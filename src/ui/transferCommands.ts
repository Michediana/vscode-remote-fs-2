import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionStore, connectionId, describeConnection } from '../config';
import logger from '../logger';
import { errorMessage } from '../remote';
import {
  ConnectionSecrets,
  ExportEntry,
  SecretsMode,
  WrongPassphraseError,
  buildExport,
  parseExport,
} from '../transfer';

const MIN_PASSPHRASE = 8;

function fileFilters(): Record<string, string[]> {
  return { [vscode.l10n.t('Remote FS 2 connections')]: ['json'] };
}

function exportTitle() {
  return vscode.l10n.t('Remote FS 2: Export Connections');
}

function importTitle() {
  return vscode.l10n.t('Remote FS 2: Import Connections');
}

function expandHome(p: string) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function askNewPassphrase(): Promise<string | undefined> {
  const first = await vscode.window.showInputBox({
    title: exportTitle(),
    prompt: vscode.l10n.t(
      'Passphrase used to encrypt the passwords. Send it to the recipient over a different channel than the file.'
    ),
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v.length < MIN_PASSPHRASE ? vscode.l10n.t('At least {0} characters.', MIN_PASSPHRASE) : undefined),
  });
  if (first === undefined) {
    return undefined;
  }
  const second = await vscode.window.showInputBox({
    title: exportTitle(),
    prompt: vscode.l10n.t('Repeat the passphrase.'),
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v !== first ? vscode.l10n.t('The passphrases do not match.') : undefined),
  });
  return second === undefined ? undefined : first;
}

export async function exportConnections(store: ConnectionStore, preselected?: string) {
  const conns = store.list();
  if (!conns.length) {
    vscode.window.showInformationMessage(vscode.l10n.t('Remote FS 2: no connections to export.'));
    return;
  }

  const picked = await vscode.window.showQuickPick(
    conns.map(conn => ({
      label: conn.config.label || conn.name,
      description: describeConnection(conn),
      picked: preselected ? conn.id === preselected : true,
      conn,
    })),
    {
      title: exportTitle(),
      placeHolder: vscode.l10n.t('Connections to export'),
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked?.length) {
    return;
  }

  const modes: Array<vscode.QuickPickItem & { mode: SecretsMode }> = [
    {
      label: '$(lock) ' + vscode.l10n.t('Include passwords, encrypted'),
      detail: vscode.l10n.t('Passwords and key passphrases are encrypted with a passphrase you choose. Recommended for sharing.'),
      mode: 'encrypted',
    },
    {
      label: '$(circle-slash) ' + vscode.l10n.t('Without passwords'),
      detail: vscode.l10n.t('The recipient enters the credentials on the first connection.'),
      mode: 'none',
    },
    {
      label: '$(warning) ' + vscode.l10n.t('Include passwords in plain text'),
      detail: vscode.l10n.t(
        'Anyone who gets the file can read them. Use only over a secure channel and delete the file afterwards.'
      ),
      mode: 'plain',
    },
  ];
  const mode = await vscode.window.showQuickPick(modes, {
    title: exportTitle(),
    placeHolder: vscode.l10n.t('Passwords and key passphrases'),
    ignoreFocusOut: true,
  });
  if (!mode) {
    return;
  }

  let passphrase: string | undefined;
  if (mode.mode === 'encrypted') {
    passphrase = await askNewPassphrase();
    if (passphrase === undefined) {
      return;
    }
  }

  const defaultName = picked.length === 1 ? `${picked[0].conn.name}.remotefs.json` : 'connections.remotefs.json';
  const baseDir = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri ?? vscode.Uri.file(os.homedir());
  const target = await vscode.window.showSaveDialog({
    title: exportTitle(),
    defaultUri: vscode.Uri.joinPath(baseDir, defaultName),
    filters: fileFilters(),
  });
  if (!target) {
    return;
  }

  try {
    const entries: ExportEntry[] = [];
    for (const { conn } of picked) {
      const secrets: ConnectionSecrets = {};
      if (mode.mode !== 'none') {
        secrets.password = await store.getSecret(conn.id, 'password');
        secrets.passphrase = await store.getSecret(conn.id, 'passphrase');
      }
      entries.push({ name: conn.name, config: conn.config, secrets });
    }
    const file = await buildExport(entries, mode.mode, passphrase);
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(file, null, 2) + '\n', 'utf8'));
    const withSecrets =
      mode.mode === 'none' ? 'without passwords' : mode.mode === 'encrypted' ? 'with encrypted passwords' : 'with PLAIN-TEXT passwords';
    logger.info(`Exported ${entries.length} connection(s) ${withSecrets} to ${target.fsPath}`);
    const n = entries.length;
    const fileName = path.basename(target.fsPath);
    const one = n === 1;
    let message: string;
    if (mode.mode === 'none') {
      message = one
        ? vscode.l10n.t('Remote FS 2: exported {0} connection without passwords to {1}.', n, fileName)
        : vscode.l10n.t('Remote FS 2: exported {0} connections without passwords to {1}.', n, fileName);
    } else if (mode.mode === 'encrypted') {
      message = one
        ? vscode.l10n.t('Remote FS 2: exported {0} connection with encrypted passwords to {1}.', n, fileName)
        : vscode.l10n.t('Remote FS 2: exported {0} connections with encrypted passwords to {1}.', n, fileName);
    } else {
      message = one
        ? vscode.l10n.t('Remote FS 2: exported {0} connection with PLAIN-TEXT passwords to {1}.', n, fileName)
        : vscode.l10n.t('Remote FS 2: exported {0} connections with PLAIN-TEXT passwords to {1}.', n, fileName);
    }
    vscode.window.showInformationMessage(message);
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Remote FS 2: export failed: {0}', transferErrorMessage(err)));
  }
}

async function askDecryption(
  decrypt: (passphrase: string) => Promise<Record<string, ConnectionSecrets>>
): Promise<Record<string, ConnectionSecrets> | undefined | null> {
  let error: string | undefined;
  for (;;) {
    const passphrase = await vscode.window.showInputBox({
      title: importTitle(),
      prompt: error ?? vscode.l10n.t('The passwords in this file are encrypted: enter the passphrase chosen at export.'),
      placeHolder: vscode.l10n.t('Leave empty to import without passwords'),
      password: true,
      ignoreFocusOut: true,
    });
    if (passphrase === undefined) {
      return undefined; // cancelled
    }
    if (passphrase === '') {
      return null; // import without secrets
    }
    try {
      return await decrypt(passphrase);
    } catch (err) {
      if (!(err instanceof WrongPassphraseError)) {
        throw err;
      }
      error = vscode.l10n.t('Wrong passphrase, try again (or leave empty to import without passwords).');
    }
  }
}

export async function importConnections(store: ConnectionStore) {
  const files = await vscode.window.showOpenDialog({
    title: importTitle(),
    canSelectMany: false,
    filters: { ...fileFilters(), [vscode.l10n.t('All files')]: ['*'] },
    openLabel: vscode.l10n.t('Import'),
  });
  if (!files?.length) {
    return;
  }

  try {
    const parsed = parseExport(Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8'));
    if (!parsed.entries.length) {
      vscode.window.showWarningMessage(vscode.l10n.t('Remote FS 2: the file contains no valid connections.'));
      return;
    }

    const existing = new Map(store.list().map(c => [c.id, c]));
    const picked = await vscode.window.showQuickPick(
      parsed.entries.map(entry => {
        const exists = existing.has(connectionId(entry.name));
        const user = entry.config.username ? `${entry.config.username}@` : '';
        return {
          label: entry.config.label || entry.name,
          description: `${entry.config.scheme}://${user}${entry.config.host}${entry.config.rootPath ?? '/'}`,
          detail: exists
            ? '$(warning) ' + vscode.l10n.t('A connection named "{0}" already exists', entry.name)
            : undefined,
          picked: true,
          entry,
        };
      }),
      {
        title: importTitle(),
        placeHolder: vscode.l10n.t('Connections to import'),
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    if (!picked?.length) {
      return;
    }

    let conflict: 'overwrite' | 'skip' | 'rename' = 'overwrite';
    const conflicts = picked.filter(p => existing.has(connectionId(p.entry.name)));
    if (conflicts.length) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: vscode.l10n.t('Overwrite'),
            detail: vscode.l10n.t('Replace the existing connections with the imported ones.'),
            value: 'overwrite' as const,
          },
          {
            label: vscode.l10n.t('Keep both'),
            detail: vscode.l10n.t('Import them with a new name (e.g. "server-2").'),
            value: 'rename' as const,
          },
          {
            label: vscode.l10n.t('Skip'),
            detail: vscode.l10n.t('Keep the existing connections, import only the new ones.'),
            value: 'skip' as const,
          },
        ],
        {
          title: importTitle(),
          placeHolder:
            conflicts.length === 1
              ? vscode.l10n.t('{0} connection already exists: {1}', conflicts.length, conflicts[0].entry.name)
              : vscode.l10n.t(
                  '{0} connections already exist: {1}',
                  conflicts.length,
                  conflicts.map(c => c.entry.name).join(', ')
                ),
          ignoreFocusOut: true,
        }
      );
      if (!choice) {
        return;
      }
      conflict = choice.value;
    }

    let target = vscode.ConfigurationTarget.Global;
    if (vscode.workspace.workspaceFolders?.length && vscode.workspace.isTrusted) {
      const where = await vscode.window.showQuickPick(
        [
          {
            label: vscode.l10n.t('User settings'),
            detail: vscode.l10n.t('Available in every window.'),
            target: vscode.ConfigurationTarget.Global,
          },
          {
            label: vscode.l10n.t('Workspace settings'),
            detail: vscode.l10n.t('Only in this workspace (.vscode/settings.json, can be shared with the project).'),
            target: vscode.ConfigurationTarget.Workspace,
          },
        ],
        { title: importTitle(), placeHolder: vscode.l10n.t('Where to save the connections'), ignoreFocusOut: true }
      );
      if (!where) {
        return;
      }
      target = where.target;
    }

    let fileSecrets: Record<string, ConnectionSecrets> = {};
    if (parsed.decryptSecrets) {
      const decrypted = await askDecryption(parsed.decryptSecrets);
      if (decrypted === undefined) {
        return;
      }
      fileSecrets = decrypted ?? {};
    }

    const taken = new Set(existing.keys());
    const imported: string[] = [];
    const missingKeys: string[] = [];
    let secretsSaved = 0;
    for (const { entry } of picked) {
      let name = entry.name;
      const prev = existing.get(connectionId(name));
      if (prev) {
        if (conflict === 'skip') {
          continue;
        }
        if (conflict === 'rename') {
          let i = 2;
          while (taken.has(connectionId(`${entry.name}-${i}`))) {
            i++;
          }
          name = `${entry.name}-${i}`;
        }
      }
      // an overwritten connection stays in its settings layer (a user entry written to the
      // workspace would not replace it, a workspace one would keep hiding a user entry)
      const saved = await store.save(name, entry.config, prev && conflict === 'overwrite' ? prev : undefined, target);
      taken.add(saved.id);
      imported.push(saved.name);

      const secrets = { ...entry.secrets, ...(fileSecrets[entry.name] ?? {}) };
      for (const kind of ['password', 'passphrase'] as const) {
        if (secrets[kind]) {
          await store.setSecret(saved.id, kind, secrets[kind]!);
          secretsSaved++;
        }
      }
      if (entry.config.privateKeyPath && !existsSync(expandHome(entry.config.privateKeyPath))) {
        missingKeys.push(saved.name);
      }
    }

    logger.info(`Imported ${imported.length} connection(s) from ${files[0].fsPath}: ${imported.join(', ')}`);
    const parts = [
      imported.length === 1
        ? vscode.l10n.t('Remote FS 2: imported {0} connection', imported.length)
        : vscode.l10n.t('Remote FS 2: imported {0} connections', imported.length),
    ];
    if (secretsSaved) {
      parts.push(vscode.l10n.t('passwords saved in the keychain'));
    }
    if (parsed.invalid.length) {
      parts.push(vscode.l10n.t('skipped invalid entries: {0}', parsed.invalid.join(', ')));
    }
    vscode.window.showInformationMessage(parts.join('; ') + '.');
    if (missingKeys.length) {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Remote FS 2: the private key file of {0} does not exist on this computer: edit the connection to set yours.',
          missingKeys.join(', ')
        )
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Remote FS 2: import failed: {0}', transferErrorMessage(err)));
  }
}

/** Translates the errors raised by ../transfer (kept in English there, since it runs under plain node in tests). */
function transferErrorMessage(err: unknown): string {
  const msg = errorMessage(err);
  switch (msg) {
    case 'Unsupported encryption parameters.':
      return vscode.l10n.t('Unsupported encryption parameters.');
    case 'A passphrase is required to encrypt the secrets.':
      return vscode.l10n.t('A passphrase is required to encrypt the secrets.');
    case 'The file is not valid JSON.':
      return vscode.l10n.t('The file is not valid JSON.');
    case 'The file is not a Remote FS 2 connections export.':
      return vscode.l10n.t('The file is not a Remote FS 2 connections export.');
    case 'The file was created by a newer version of Remote FS 2: update the extension.':
      return vscode.l10n.t('The file was created by a newer version of Remote FS 2: update the extension.');
    case 'The encrypted secrets are missing from the file.':
      return vscode.l10n.t('The encrypted secrets are missing from the file.');
    default:
      return msg;
  }
}
