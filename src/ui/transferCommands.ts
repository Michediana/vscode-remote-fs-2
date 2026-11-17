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

const TITLE = 'Remote FS 2';
const MIN_PASSPHRASE = 8;
const FILE_FILTERS = { 'Remote FS 2 connections': ['json'] };

function expandHome(p: string) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function askNewPassphrase(): Promise<string | undefined> {
  const first = await vscode.window.showInputBox({
    title: `${TITLE}: Export Connections`,
    prompt: 'Passphrase used to encrypt the passwords. Send it to the recipient over a different channel than the file.',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v.length < MIN_PASSPHRASE ? `At least ${MIN_PASSPHRASE} characters.` : undefined),
  });
  if (first === undefined) {
    return undefined;
  }
  const second = await vscode.window.showInputBox({
    title: `${TITLE}: Export Connections`,
    prompt: 'Repeat the passphrase.',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v !== first ? 'The passphrases do not match.' : undefined),
  });
  return second === undefined ? undefined : first;
}

export async function exportConnections(store: ConnectionStore, preselected?: string) {
  const conns = store.list();
  if (!conns.length) {
    vscode.window.showInformationMessage(`${TITLE}: no connections to export.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    conns.map(conn => ({
      label: conn.config.label || conn.name,
      description: describeConnection(conn),
      picked: preselected ? conn.id === preselected : true,
      conn,
    })),
    { title: `${TITLE}: Export Connections`, placeHolder: 'Connections to export', canPickMany: true, ignoreFocusOut: true }
  );
  if (!picked?.length) {
    return;
  }

  const modes: Array<vscode.QuickPickItem & { mode: SecretsMode }> = [
    {
      label: '$(lock) Include passwords, encrypted',
      detail: 'Passwords and key passphrases are encrypted with a passphrase you choose. Recommended for sharing.',
      mode: 'encrypted',
    },
    {
      label: '$(circle-slash) Without passwords',
      detail: 'The recipient enters the credentials on the first connection.',
      mode: 'none',
    },
    {
      label: '$(warning) Include passwords in plain text',
      detail: 'Anyone who gets the file can read them. Use only over a secure channel and delete the file afterwards.',
      mode: 'plain',
    },
  ];
  const mode = await vscode.window.showQuickPick(modes, {
    title: `${TITLE}: Export Connections`,
    placeHolder: 'Passwords and key passphrases',
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
    title: `${TITLE}: Export Connections`,
    defaultUri: vscode.Uri.joinPath(baseDir, defaultName),
    filters: FILE_FILTERS,
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
    vscode.window.showInformationMessage(
      `${TITLE}: exported ${entries.length} connection(s) ${withSecrets} to ${path.basename(target.fsPath)}.`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`${TITLE}: export failed: ${errorMessage(err)}`);
  }
}

async function askDecryption(
  decrypt: (passphrase: string) => Promise<Record<string, ConnectionSecrets>>
): Promise<Record<string, ConnectionSecrets> | undefined | null> {
  let error: string | undefined;
  for (;;) {
    const passphrase = await vscode.window.showInputBox({
      title: `${TITLE}: Import Connections`,
      prompt: error ?? 'The passwords in this file are encrypted: enter the passphrase chosen at export.',
      placeHolder: 'Leave empty to import without passwords',
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
      error = 'Wrong passphrase, try again (or leave empty to import without passwords).';
    }
  }
}

export async function importConnections(store: ConnectionStore) {
  const files = await vscode.window.showOpenDialog({
    title: `${TITLE}: Import Connections`,
    canSelectMany: false,
    filters: { ...FILE_FILTERS, 'All files': ['*'] },
    openLabel: 'Import',
  });
  if (!files?.length) {
    return;
  }

  try {
    const parsed = parseExport(Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8'));
    if (!parsed.entries.length) {
      vscode.window.showWarningMessage(`${TITLE}: the file contains no valid connections.`);
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
          detail: exists ? `$(warning) A connection named "${entry.name}" already exists` : undefined,
          picked: true,
          entry,
        };
      }),
      { title: `${TITLE}: Import Connections`, placeHolder: 'Connections to import', canPickMany: true, ignoreFocusOut: true }
    );
    if (!picked?.length) {
      return;
    }

    let conflict: 'overwrite' | 'skip' | 'rename' = 'overwrite';
    const conflicts = picked.filter(p => existing.has(connectionId(p.entry.name)));
    if (conflicts.length) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Overwrite', detail: 'Replace the existing connections with the imported ones.', value: 'overwrite' as const },
          { label: 'Keep both', detail: 'Import them with a new name (e.g. "server-2").', value: 'rename' as const },
          { label: 'Skip', detail: 'Keep the existing connections, import only the new ones.', value: 'skip' as const },
        ],
        {
          title: `${TITLE}: Import Connections`,
          placeHolder: `${conflicts.length} connection(s) already exist: ${conflicts.map(c => c.entry.name).join(', ')}`,
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
          { label: 'User settings', detail: 'Available in every window.', target: vscode.ConfigurationTarget.Global },
          {
            label: 'Workspace settings',
            detail: 'Only in this workspace (.vscode/settings.json, can be shared with the project).',
            target: vscode.ConfigurationTarget.Workspace,
          },
        ],
        { title: `${TITLE}: Import Connections`, placeHolder: 'Where to save the connections', ignoreFocusOut: true }
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
    const parts = [`${TITLE}: imported ${imported.length} connection(s)`];
    if (secretsSaved) {
      parts.push('passwords saved in the keychain');
    }
    if (parsed.invalid.length) {
      parts.push(`skipped invalid entries: ${parsed.invalid.join(', ')}`);
    }
    vscode.window.showInformationMessage(parts.join('; ') + '.');
    if (missingKeys.length) {
      vscode.window.showWarningMessage(
        `${TITLE}: the private key file of ${missingKeys.join(', ')} does not exist on this computer: edit the connection to set yours.`
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(`${TITLE}: import failed: ${errorMessage(err)}`);
  }
}
