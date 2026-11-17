import * as vscode from 'vscode';
import { Connection, ConnectionStore } from './config';
import logger from './logger';
import {
  ClientInteraction,
  RemoteClient,
  RemoteError,
  ResolvedConnection,
  errorMessage,
  openClient,
} from './remote';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  error?: string;
}

interface Entry {
  state: ConnectionState;
  client?: RemoteClient;
  pending?: Promise<RemoteClient>;
  failedAt?: number;
  failure?: unknown;
  /** Settings snapshot the client was created with. */
  fingerprint?: string;
}

/** After a failed attempt, further calls fail fast for this long instead of re-prompting. */
const FAILURE_COOLDOWN = 3000;
const KNOWN_HOSTS_KEY = 'remotefs.knownHosts';

/** VS Code implementation of the prompts needed by the clients. */
export function createInteraction(context: vscode.ExtensionContext, connName: string): ClientInteraction {
  return {
    async prompt(message, secret) {
      return vscode.window.showInputBox({
        title: `Remote FS 2: ${connName}`,
        prompt: message,
        password: secret,
        ignoreFocusOut: true,
      });
    },
    async verifyHostKey(host, port, fingerprint) {
      const known = context.globalState.get<Record<string, string>>(KNOWN_HOSTS_KEY, {});
      const key = `${host}:${port}`;
      if (known[key] === fingerprint) {
        return true;
      }
      const changed = known[key] !== undefined;
      const trust = changed ? 'Trust New Key' : 'Trust';
      const detail = changed
        ? `The host key of ${key} has CHANGED.\n\nPreviously: ${known[key]}\nNow: ${fingerprint}\n\nThis could mean someone is intercepting the connection (man-in-the-middle), or the server was reinstalled. Only continue if you know why the key changed.`
        : `First connection to ${key}.\n\nHost key fingerprint:\n${fingerprint}\n\nVerify it matches the server (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub) before trusting it.`;
      const answer = await vscode.window.showWarningMessage(
        changed ? 'Remote FS 2: host key changed!' : 'Remote FS 2: unknown host',
        { modal: true, detail },
        trust
      );
      if (answer !== trust) {
        return false;
      }
      await context.globalState.update(KNOWN_HOSTS_KEY, { ...known, [key]: fingerprint });
      return true;
    },
  };
}

export interface ResolveResult {
  resolved: ResolvedConnection;
  /** Secrets typed by the user during resolution (candidates for saving). */
  typed: { password?: string; passphrase?: string };
}

/**
 * Builds the connection parameters, reading secrets from the keychain and
 * prompting for what is missing. Throws ECANCELED when the user dismisses a prompt.
 */
export async function resolveConnection(
  conn: Connection,
  store: ConnectionStore,
  ui: ClientInteraction,
  overrides: { password?: string; passphrase?: string } = {}
): Promise<ResolveResult> {
  const c = conn.config;
  const typed: ResolveResult['typed'] = {};

  let password = overrides.password ?? c.password ?? (await store.getSecret(conn.id, 'password'));
  const needsPassword =
    conn.scheme === 'sftp' ? !c.privateKeyPath && !c.agent && !c.interactiveAuth : true;
  if (password === undefined && needsPassword) {
    password = await ui.prompt(`Password for ${c.username ?? ''}@${c.host}`, true);
    if (password === undefined) {
      throw new RemoteError('ECANCELED', 'Password prompt cancelled');
    }
    typed.password = password;
  }

  let passphrase: string | undefined =
    overrides.passphrase ?? (typeof c.passphrase === 'string' ? c.passphrase : undefined);
  if (passphrase === undefined && c.privateKeyPath) {
    passphrase = await store.getSecret(conn.id, 'passphrase');
    if (passphrase === undefined && c.passphrase === true) {
      passphrase = await ui.prompt(`Passphrase for ${c.privateKeyPath}`, true);
      if (passphrase === undefined) {
        throw new RemoteError('ECANCELED', 'Passphrase prompt cancelled');
      }
      typed.passphrase = passphrase;
    }
  }

  return {
    typed,
    resolved: {
      scheme: conn.scheme,
      host: c.host,
      port: conn.port,
      username: c.username,
      password,
      connectTimeout: conn.connectTimeout,
      privateKeyPath: c.privateKeyPath,
      passphrase,
      agent: c.agent,
      interactiveAuth: c.interactiveAuth,
      algorithms: c.algorithms,
      secure: c.secure,
      rejectUnauthorized: c.rejectUnauthorized,
    },
  };
}

/**
 * Connects, prompting for a key passphrase if the key turns out to be
 * encrypted and none was configured.
 */
export async function connectWithPrompts(
  conn: Connection,
  store: ConnectionStore,
  ui: ClientInteraction,
  overrides: { password?: string; passphrase?: string } = {}
): Promise<{ client: RemoteClient; typed: ResolveResult['typed'] }> {
  const { resolved, typed } = await resolveConnection(conn, store, ui, overrides);
  try {
    return { client: await openClient(resolved, ui), typed };
  } catch (err) {
    const encryptedKey = /passphrase|encrypted/i.test(errorMessage(err)) && !resolved.passphrase;
    if (!encryptedKey) {
      throw err;
    }
    const passphrase = await ui.prompt(`Passphrase for ${conn.config.privateKeyPath}`, true);
    if (passphrase === undefined) {
      throw new RemoteError('ECANCELED', 'Passphrase prompt cancelled');
    }
    const client = await openClient({ ...resolved, passphrase }, ui);
    return { client, typed: { ...typed, passphrase } };
  }
}

function configFingerprint(conn: Connection) {
  return JSON.stringify([conn.name, conn.config]);
}

export class ConnectionManager implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  /** Bumped on every manual disconnect, so views can reset their expanded state. */
  private readonly sessions = new Map<string, number>();
  private readonly _onDidChangeState = new vscode.EventEmitter<string>();
  readonly onDidChangeState = this._onDidChangeState.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChangeState];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly onEditRequested: (id: string) => void
  ) {
    // drop connections whose settings changed or were removed
    this.disposables.push(
      store.onDidChange(() => {
        for (const [id, entry] of this.entries) {
          const conn = store.get(id);
          if (!conn || (entry.fingerprint && entry.fingerprint !== configFingerprint(conn))) {
            logger.info(`Settings of "${id}" changed, closing its connection`);
            this.disconnect(id);
          }
        }
      })
    );
  }

  dispose() {
    this.disconnectAll();
    this.disposables.forEach(d => d.dispose());
  }

  getState(id: string): ConnectionState {
    return this.entries.get(id)?.state ?? { status: 'idle' };
  }

  isConnected(id: string) {
    return this.getState(id).status === 'connected';
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { state: { status: 'idle' } };
      this.entries.set(id, e);
    }
    return e;
  }

  private setState(id: string, entry: Entry, state: ConnectionState) {
    entry.state = state;
    this._onDidChangeState.fire(id);
  }

  /**
   * Returns a live client for the connection, connecting if needed.
   * Concurrent callers share the same attempt.
   */
  async getClient(conn: Connection, opts: { retryNow?: boolean } = {}): Promise<RemoteClient> {
    const entry = this.entry(conn.id);
    if (entry.client && !entry.client.closed) {
      return entry.client;
    }
    if (entry.pending) {
      return entry.pending;
    }
    if (!opts.retryNow && entry.failedAt && Date.now() - entry.failedAt < FAILURE_COOLDOWN) {
      throw entry.failure;
    }

    const attempt = this.connect(conn, entry);
    entry.pending = attempt;
    try {
      return await attempt;
    } finally {
      entry.pending = undefined;
    }
  }

  private async connect(conn: Connection, entry: Entry): Promise<RemoteClient> {
    this.setState(conn.id, entry, { status: 'connecting' });
    logger.info(`Connecting to ${conn.name} (${conn.scheme}://${conn.config.host}:${conn.port})`);
    try {
      const { client, typed } = await connectWithPrompts(
        conn,
        this.store,
        createInteraction(this.context, conn.name)
      );
      entry.client = client;
      entry.failedAt = undefined;
      entry.failure = undefined;
      entry.fingerprint = configFingerprint(conn);
      client.onClose(() => {
        if (entry.client === client) {
          logger.info(`Connection to ${conn.name} closed`);
          entry.client = undefined;
          this.setState(conn.id, entry, { status: 'idle' });
        }
      });
      this.setState(conn.id, entry, { status: 'connected' });
      logger.info(`Connected to ${conn.name}`);
      this.offerToSaveSecrets(conn, typed);
      return client;
    } catch (err) {
      entry.failedAt = Date.now();
      entry.failure = err;
      const cancelled = err instanceof RemoteError && err.code === 'ECANCELED';
      this.setState(conn.id, entry, cancelled ? { status: 'idle' } : { status: 'error', error: errorMessage(err) });
      if (cancelled) {
        logger.info(`Connection to ${conn.name} cancelled`);
      } else {
        logger.error(`Connection to ${conn.name} failed: ${errorMessage(err)}`);
        this.notifyFailure(conn, err);
      }
      throw err;
    }
  }

  private async notifyFailure(conn: Connection, err: unknown) {
    const edit = 'Edit Connection';
    const log = 'Show Log';
    const answer = await vscode.window.showErrorMessage(
      `Remote FS 2: ${conn.name}: ${errorMessage(err)}`,
      edit,
      log
    );
    if (answer === edit) {
      this.onEditRequested(conn.id);
    } else if (answer === log) {
      logger.show();
    }
  }

  private async offerToSaveSecrets(conn: Connection, typed: ResolveResult['typed']) {
    const kinds = (['password', 'passphrase'] as const).filter(k => typed[k] !== undefined);
    if (!kinds.length) {
      return;
    }
    const save = 'Save in Keychain';
    const answer = await vscode.window.showInformationMessage(
      `Remote FS 2: save the ${kinds.join(' and ')} for "${conn.name}" in the OS keychain?`,
      save,
      'Not Now'
    );
    if (answer === save) {
      for (const k of kinds) {
        await this.store.setSecret(conn.id, k, typed[k]!);
      }
    }
  }

  /** Changes every time the user disconnects the connection. */
  session(id: string) {
    return this.sessions.get(id) ?? 0;
  }

  disconnect(id: string) {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    this.sessions.set(id, this.session(id) + 1);
    this.entries.delete(id);
    entry.client?.close();
    entry.pending?.then(c => c.close(), () => undefined);
    this._onDidChangeState.fire(id);
  }

  disconnectAll() {
    for (const id of [...this.entries.keys()]) {
      this.disconnect(id);
    }
  }

  connectedIds() {
    return [...this.entries.entries()].filter(([, e]) => e.client && !e.client.closed).map(([id]) => id);
  }
}
