import * as vscode from 'vscode';
import { Scheme, SCHEMES } from './remote';

/** Shape of one entry of the `remotefs.remote` setting. */
export interface ConnectionConfig {
  scheme: Scheme;
  host: string;
  port?: number;
  username?: string;
  /** Plain-text password (legacy). New passwords are kept in SecretStorage. */
  password?: string;
  rootPath?: string;
  connectTimeout?: number;
  label?: string;
  privateKeyPath?: string;
  passphrase?: string | boolean;
  agent?: string;
  interactiveAuth?: boolean;
  algorithms?: Record<string, unknown>;
  secure?: boolean | 'implicit';
  rejectUnauthorized?: boolean;
}

export interface Connection {
  /** Case-insensitive identity, used as URI authority and secret key. */
  id: string;
  /** Key as written in settings. */
  name: string;
  config: ConnectionConfig;
  scheme: Scheme;
  port: number;
  rootPath: string;
  connectTimeout: number;
  /** Where the entry is defined. */
  target: vscode.ConfigurationTarget;
}

export type SecretKind = 'password' | 'passphrase';

const SECTION = 'remotefs';
const KEY = 'remote';

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultPort(scheme: Scheme) {
  return scheme === 'sftp' ? 22 : 21;
}

export function connectionId(name: string) {
  return name.toLowerCase();
}

export function describeConnection(c: Connection) {
  const user = c.config.username ? `${c.config.username}@` : '';
  const port = c.port !== defaultPort(c.scheme) ? `:${c.port}` : '';
  return `${c.scheme}://${user}${c.config.host}${port}${c.rootPath}`;
}

function normalize(name: string, raw: unknown, target: vscode.ConfigurationTarget): Connection | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const config = raw as ConnectionConfig;
  const scheme = String(config.scheme ?? '').toLowerCase() as Scheme;
  if (!SCHEMES.includes(scheme) || !config.host) {
    return undefined;
  }
  return {
    id: connectionId(name),
    name,
    config: { ...config, scheme },
    scheme,
    port: Number(config.port) || defaultPort(scheme),
    rootPath: config.rootPath || '/',
    connectTimeout: Number(config.connectTimeout) || 10_000,
    target,
  };
}

export class ConnectionStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChange];

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(`${SECTION}.${KEY}`)) {
          this._onDidChange.fire();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this._onDidChange.fire())
    );
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }

  private inspect() {
    return vscode.workspace.getConfiguration(SECTION).inspect<Record<string, unknown>>(KEY);
  }

  /** All connections; workspace entries override user entries with the same name. */
  list(): Connection[] {
    const info = this.inspect();
    const byId = new Map<string, Connection>();
    const layers: Array<[Record<string, unknown> | undefined, vscode.ConfigurationTarget]> = [
      [info?.globalValue, vscode.ConfigurationTarget.Global],
    ];
    if (vscode.workspace.isTrusted) {
      layers.push([info?.workspaceValue, vscode.ConfigurationTarget.Workspace]);
    }
    for (const [value, target] of layers) {
      for (const [name, raw] of Object.entries(value ?? {})) {
        const conn = normalize(name, raw, target);
        if (conn) {
          byId.set(conn.id, conn);
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(idOrName: string): Connection | undefined {
    const id = connectionId(idOrName);
    return this.list().find(c => c.id === id);
  }

  private async writeLayer(
    target: vscode.ConfigurationTarget,
    mutate: (layer: Record<string, unknown>) => void
  ) {
    const info = this.inspect();
    const current = target === vscode.ConfigurationTarget.Workspace ? info?.workspaceValue : info?.globalValue;
    const layer = { ...(current ?? {}) };
    mutate(layer);
    await vscode.workspace.getConfiguration(SECTION).update(KEY, layer, target);
  }

  /**
   * Creates or updates a connection. When `previous` is given the entry is
   * replaced in the settings layer it came from (supports renaming).
   */
  async save(name: string, config: ConnectionConfig, previous?: Connection): Promise<Connection> {
    const target = previous?.target ?? vscode.ConfigurationTarget.Global;
    const clean = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined && v !== '')
    ) as unknown as ConnectionConfig;

    await this.writeLayer(target, layer => {
      if (previous) {
        delete layer[previous.name];
      }
      // drop entries differing only by case, they would collide
      for (const key of Object.keys(layer)) {
        if (connectionId(key) === connectionId(name)) {
          delete layer[key];
        }
      }
      layer[name] = clean;
    });

    if (previous && previous.id !== connectionId(name)) {
      for (const kind of ['password', 'passphrase'] as SecretKind[]) {
        const value = await this.getSecret(previous.id, kind);
        if (value !== undefined) {
          await this.setSecret(connectionId(name), kind, value);
          await this.deleteSecret(previous.id, kind);
        }
      }
    }
    const saved = normalize(name, clean, target);
    if (!saved) {
      throw new Error('Invalid connection configuration');
    }
    return saved;
  }

  async delete(conn: Connection) {
    await this.writeLayer(conn.target, layer => {
      delete layer[conn.name];
    });
    await this.deleteSecret(conn.id, 'password');
    await this.deleteSecret(conn.id, 'passphrase');
  }

  private secretKey(id: string, kind: SecretKind) {
    return `remotefs.${kind}.${id}`;
  }

  async getSecret(id: string, kind: SecretKind): Promise<string | undefined> {
    return (await this.secrets.get(this.secretKey(id, kind))) ?? undefined;
  }

  setSecret(id: string, kind: SecretKind, value: string) {
    return this.secrets.store(this.secretKey(id, kind), value);
  }

  deleteSecret(id: string, kind: SecretKind) {
    return this.secrets.delete(this.secretKey(id, kind));
  }
}
