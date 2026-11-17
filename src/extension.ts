import { posix } from 'path';
import * as vscode from 'vscode';
import { Connection, ConnectionStore, describeConnection } from './config';
import { ConnectionManager } from './connectionManager';
import { RemoteFileSystemProvider } from './fileSystemProvider';
import logger from './logger';
import { SCHEMES, errorMessage } from './remote';
import { ConnectionEditor } from './ui/connectionEditor';
import { ConnectionsView, EntryNode, Node, rootUri } from './ui/connectionsView';

const DEFAULT_ROOT_LABEL = '${label}';

function supplant(template: string, props: Record<string, string>) {
  return template.replace(/\$\{([^{}]*)\}/g, (match, key) => props[key] ?? match);
}

export function activate(context: vscode.ExtensionContext) {
  const store = new ConnectionStore(context.secrets);
  const editConnection = (conn?: Connection, duplicate = false) =>
    ConnectionEditor.open(context, store, manager, conn, duplicate);
  const manager = new ConnectionManager(context, store, id => editConnection(store.get(id)));
  const provider = new RemoteFileSystemProvider(store, manager);
  const view = new ConnectionsView(store, manager);

  context.subscriptions.push(store, manager, provider, view, { dispose: () => logger.dispose() });
  for (const scheme of SCHEMES) {
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(scheme, provider, { isCaseSensitive: true })
    );
  }

  async function pickConnection(node?: Node, placeHolder = 'Select a remote connection'): Promise<Connection | undefined> {
    if (node) {
      return node.conn;
    }
    const conns = store.list();
    if (!conns.length) {
      const add = 'Add Connection';
      if ((await vscode.window.showInformationMessage('Remote FS: no connections configured.', add)) === add) {
        editConnection();
      }
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      conns.map(conn => ({
        label: conn.config.label || conn.name,
        description: describeConnection(conn),
        detail: manager.isConnected(conn.id) ? '$(vm-active) connected' : undefined,
        conn,
      })),
      { placeHolder, matchOnDescription: true }
    );
    return picked?.conn;
  }

  function targetUri(node: Node | undefined, conn: Connection) {
    return node instanceof EntryNode ? node.uri : rootUri(conn);
  }

  async function addToWorkspace(node?: Node) {
    const conn = await pickConnection(node);
    if (!conn) {
      return;
    }
    const uri = targetUri(node, conn);
    const existing = vscode.workspace.getWorkspaceFolder(uri);
    if (existing && existing.uri.toString() === uri.toString()) {
      await vscode.commands.executeCommand('workbench.view.explorer');
      return;
    }
    const template = vscode.workspace.getConfiguration('remotefs').get<string>('rootLabel') || DEFAULT_ROOT_LABEL;
    const isSubfolder = node instanceof EntryNode;
    const remotePath = isSubfolder ? posix.join(conn.rootPath, node.uri.path) : conn.rootPath;
    const folderName = posix.basename(remotePath) || remotePath || '/';
    const props = { label: conn.config.label || conn.name, name: conn.name, folderName, path: remotePath };
    let name = supplant(template, props);
    if (isSubfolder && template === DEFAULT_ROOT_LABEL) {
      name += ` — ${folderName}`;
    }
    const count = vscode.workspace.workspaceFolders?.length ?? 0;
    // appending (instead of inserting first) keeps the current first folder and avoids an extension host restart
    if (!vscode.workspace.updateWorkspaceFolders(count, 0, { uri, name })) {
      vscode.window.showErrorMessage('Remote FS: could not add the folder to the workspace.');
    }
  }

  const commands: Record<string, (...args: any[]) => unknown> = {
    'remotefs.addFolderToWorkspace': () => addToWorkspace(),
    'remotefs.openInWorkspace': (node?: Node) => addToWorkspace(node),

    'remotefs.openInNewWindow': async (node?: Node) => {
      const conn = await pickConnection(node);
      if (conn) {
        await vscode.commands.executeCommand('vscode.openFolder', targetUri(node, conn), { forceNewWindow: true });
      }
    },

    'remotefs.openInCurrentWindow': async (node?: Node) => {
      const conn = await pickConnection(node);
      if (conn) {
        await vscode.commands.executeCommand('vscode.openFolder', targetUri(node, conn), { forceReuseWindow: true });
      }
    },

    'remotefs.addConnection': () => editConnection(),

    'remotefs.editConnection': async (node?: Node) => {
      const conn = await pickConnection(node, 'Select the connection to edit');
      if (conn) {
        editConnection(conn);
      }
    },

    'remotefs.duplicateConnection': async (node?: Node) => {
      const conn = await pickConnection(node, 'Select the connection to duplicate');
      if (conn) {
        editConnection(conn, true);
      }
    },

    'remotefs.deleteConnection': async (node?: Node) => {
      const conn = await pickConnection(node, 'Select the connection to delete');
      if (!conn) {
        return;
      }
      const del = 'Delete';
      const answer = await vscode.window.showWarningMessage(
        `Delete the connection "${conn.name}"?`,
        { modal: true, detail: `${describeConnection(conn)}\n\nIts saved password/passphrase will be removed from the keychain. Files on the server are not touched.` },
        del
      );
      if (answer !== del) {
        return;
      }
      manager.disconnect(conn.id);
      await store.delete(conn);
    },

    'remotefs.testConnection': async (node?: Node) => {
      const conn = await pickConnection(node, 'Select the connection to test');
      if (!conn) {
        return;
      }
      manager.disconnect(conn.id);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Remote FS: connecting to ${conn.name}…` },
        async () => {
          const started = Date.now();
          try {
            await manager.getClient(conn, { retryNow: true });
            const entries = await vscode.workspace.fs.readDirectory(rootUri(conn));
            vscode.window.showInformationMessage(
              `Remote FS: connected to ${conn.name} in ${Date.now() - started} ms (${entries.length} entries in ${conn.rootPath}).`
            );
          } catch (err) {
            // connection failures are already notified by the manager
            logger.warn(`Test of ${conn.name} failed: ${errorMessage(err)}`);
          }
        }
      );
    },

    'remotefs.disconnect': async (node?: Node) => {
      const conn = node?.conn ?? (await pickConnection(undefined, 'Select the connection to close'));
      if (conn) {
        manager.disconnect(conn.id);
      }
    },

    'remotefs.disconnectAll': () => manager.disconnectAll(),

    'remotefs.forgetPassword': async (node?: Node) => {
      const conn = await pickConnection(node);
      if (!conn) {
        return;
      }
      await store.deleteSecret(conn.id, 'password');
      await store.deleteSecret(conn.id, 'passphrase');
      manager.disconnect(conn.id);
      vscode.window.showInformationMessage(`Remote FS: saved credentials of "${conn.name}" removed.`);
    },

    'remotefs.refresh': (node?: Node) => {
      view.refresh();
      if (node) {
        provider.refresh(node.uri);
      }
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if ((SCHEMES as readonly string[]).includes(folder.uri.scheme)) {
          provider.refresh(folder.uri);
        }
      }
    },

    'remotefs.openSettingsJson': () =>
      vscode.commands.executeCommand('workbench.action.openSettingsJson', {
        revealSetting: { key: 'remotefs.remote' },
      }),

    'remotefs.showLog': () => logger.show(),
  };

  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  logger.info(`Remote FS activated with ${store.list().length} connection(s)`);
}

export function deactivate() {
  // connections are closed by the disposables registered in activate()
}
