import { posix } from 'path';
import * as vscode from 'vscode';
import { ActivityTracker } from './activity';
import { Connection, ConnectionStore, describeConnection } from './config';
import { ConnectionManager } from './connectionManager';
import { RemoteFileSystemProvider } from './fileSystemProvider';
import logger from './logger';
import { MirrorManager } from './mirror';
import { SCHEMES, errorMessage } from './remote';
import { ActivityStatus } from './ui/activityStatus';
import { ConnectionEditor } from './ui/connectionEditor';
import { ConnectionsView, Node, rootUri } from './ui/connectionsView';
import { exportConnections, importConnections } from './ui/transferCommands';

const DEFAULT_ROOT_LABEL = '${label}';
/** Appended to the default label, so remote folders are not confused with local mirrors. */
const REMOTE_SUFFIX = ' (remote)';
/** globalState key: folder added to the workspace whose Explorer must be revealed after a restart. */
const PENDING_REVEAL = 'remotefs.pendingReveal';

/** The extension this fork replaces: it registers the same file systems and commands. */
const ORIGINAL_EXTENSION_ID = 'liximomo.remotefs';

function supplant(template: string, props: Record<string, string>) {
  return template.replace(/\$\{([^{}]*)\}/g, (match, key) => props[key] ?? match);
}

/** Warns when the original Remote FS is enabled too (disabled extensions are not returned by getExtension). */
async function warnIfOriginalInstalled() {
  if (!vscode.extensions.getExtension(ORIGINAL_EXTENSION_ID)) {
    return;
  }
  logger.warn(`${ORIGINAL_EXTENSION_ID} is enabled: it conflicts with Remote FS 2`);
  const show = vscode.l10n.t('Show Original Extension');
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Remote FS 2 replaces the original Remote FS extension ({0}), which is also enabled. Both register the sftp:// and ftp:// file systems and the same commands, so they cannot work together. Uninstall or disable the original, then reload the window. Your connections are kept.',
      ORIGINAL_EXTENSION_ID
    ),
    show
  );
  if (answer === show) {
    await vscode.commands.executeCommand('extension.open', ORIGINAL_EXTENSION_ID);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // first, so the warning is shown even if a registration below fails because of the original extension
  warnIfOriginalInstalled();

  const store = new ConnectionStore(context.secrets);
  const editConnection = (conn?: Connection, duplicate = false) =>
    ConnectionEditor.open(context, store, manager, conn, duplicate);
  const manager = new ConnectionManager(context, store, id => editConnection(store.get(id)));
  const activity = new ActivityTracker();
  const provider = new RemoteFileSystemProvider(store, manager, activity);
  const view = new ConnectionsView(store, manager);
  const mirrors = new MirrorManager(context, store, provider);
  const activityStatus = new ActivityStatus(store, manager, activity);

  context.subscriptions.push(store, manager, activity, provider, view, mirrors, activityStatus, {
    dispose: () => logger.dispose(),
  });
  for (const scheme of SCHEMES) {
    try {
      context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(scheme, provider, { isCaseSensitive: true })
      );
    } catch (err) {
      // another extension (typically liximomo.remotefs) owns the scheme: keep activating so the view still works
      logger.error(`Cannot register the ${scheme}:// file system: ${errorMessage(err)}`);
    }
  }

  async function pickConnection(
    node?: Node,
    placeHolder = vscode.l10n.t('Select a remote connection')
  ): Promise<Connection | undefined> {
    if (node) {
      return node.conn;
    }
    const conns = store.list();
    if (!conns.length) {
      const add = vscode.l10n.t('Add Connection');
      if ((await vscode.window.showInformationMessage(vscode.l10n.t('Remote FS 2: no connections configured.'), add)) === add) {
        editConnection();
      }
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      conns.map(conn => ({
        label: conn.config.label || conn.name,
        description: describeConnection(conn),
        detail: manager.isConnected(conn.id) ? `$(vm-active) ${vscode.l10n.t('connected')}` : undefined,
        conn,
      })),
      { placeHolder, matchOnDescription: true }
    );
    return picked?.conn;
  }

  async function addToWorkspace(node?: Node) {
    const conn = await pickConnection(node);
    if (!conn) {
      return;
    }
    const uri = rootUri(conn);
    const existing = vscode.workspace.getWorkspaceFolder(uri);
    if (existing && existing.uri.toString() === uri.toString()) {
      await vscode.commands.executeCommand('workbench.view.explorer');
      return;
    }
    const template = vscode.workspace.getConfiguration('remotefs').get<string>('rootLabel') || DEFAULT_ROOT_LABEL;
    const remotePath = conn.rootPath;
    const folderName = posix.basename(remotePath) || remotePath || '/';
    const props = { label: conn.config.label || conn.name, name: conn.name, folderName, path: remotePath };
    let name = supplant(template, props);
    if (template === DEFAULT_ROOT_LABEL) {
      name += REMOTE_SUFFIX;
    }
    const count = vscode.workspace.workspaceFolders?.length ?? 0;
    // if the window has no folder (or switches from a single folder to a multi-root workspace) VS Code
    // restarts the extension host and this code is killed: remember to reveal the Explorer on the next activation
    await context.globalState.update(PENDING_REVEAL, { uri: uri.toString(), at: Date.now() });
    // appending (instead of inserting first) keeps the current first folder and avoids an extension host restart
    if (!vscode.workspace.updateWorkspaceFolders(count, 0, { uri, name })) {
      await context.globalState.update(PENDING_REVEAL, undefined);
      vscode.window.showErrorMessage(vscode.l10n.t('Remote FS 2: could not add the folder to the workspace.'));
      return;
    }
    await context.globalState.update(PENDING_REVEAL, undefined);
    await vscode.commands.executeCommand('workbench.view.explorer');
  }

  /** Completes an addToWorkspace() interrupted by an extension host restart. */
  async function revealPendingFolder() {
    const pending = context.globalState.get<{ uri: string; at: number }>(PENDING_REVEAL);
    if (!pending) {
      return;
    }
    await context.globalState.update(PENDING_REVEAL, undefined);
    const added = (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.toString() === pending.uri);
    if (added && Date.now() - pending.at < 60_000) {
      await vscode.commands.executeCommand('workbench.view.explorer');
    }
  }
  revealPendingFolder();

  /** The remote workspace folders served by a connection. */
  function remoteFolders(connId?: string) {
    return (vscode.workspace.workspaceFolders ?? []).filter(
      f =>
        (SCHEMES as readonly string[]).includes(f.uri.scheme) &&
        (connId === undefined || f.uri.authority.toLowerCase() === connId)
    );
  }

  // When a workspace is opened VS Code reads its remote folders once, while the extension is
  // still starting or the connection is being made (password prompt, server dropping the first
  // attempts…); a failed read leaves the folder empty until a manual refresh. Re-read the
  // folders of a connection as soon as it is up again after such failures.
  const lastAutoRefresh = new Map<string, number>();
  const scheduledRefresh = new Map<string, NodeJS.Timeout>();
  const autoRefresh = (id: string) => {
    if (scheduledRefresh.has(id)) {
      return;
    }
    // at least 5 s apart, so a connection that keeps dropping cannot cause a refresh storm;
    // a refresh asked too early is postponed, never dropped
    const wait = Math.max(300, (lastAutoRefresh.get(id) ?? 0) + 5_000 - Date.now());
    scheduledRefresh.set(
      id,
      setTimeout(() => {
        scheduledRefresh.delete(id);
        lastAutoRefresh.set(id, Date.now());
        const folders = remoteFolders(id);
        if (folders.length) {
          logger.info(`Reloading the workspace folders of ${id} after the connection was restored`);
          folders.forEach(f => provider.refresh(f.uri));
        }
      }, wait)
    );
  };
  context.subscriptions.push(
    { dispose: () => scheduledRefresh.forEach(t => clearTimeout(t)) },
    manager.onDidChangeState(id => {
      if (manager.getState(id).status !== 'connected' || !provider.takeUnavailable(id)) {
        return;
      }
      activity.clearError(id);
      if (remoteFolders(id).length) {
        autoRefresh(id);
      }
    })
  );

  /** Connects the remote workspace folders as soon as the window opens, then reloads them. */
  async function connectWorkspaceFolders() {
    const ids = new Set(remoteFolders().map(f => f.uri.authority.toLowerCase()));
    for (const id of ids) {
      const conn = store.get(id);
      if (!conn) {
        logger.warn(`The workspace contains a folder of the unknown remote "${id}"`);
        continue;
      }
      try {
        await manager.getClient(conn);
      } catch {
        continue; // notified by the manager
      }
      remoteFolders(id).forEach(f => provider.refresh(f.uri));
    }
  }
  connectWorkspaceFolders();

  /** Removes the workspace folders that browse the given connections (local mirrors are kept). */
  function removeFromWorkspace(connIds: string[]) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const isGone = (f: vscode.WorkspaceFolder) =>
      (SCHEMES as readonly string[]).includes(f.uri.scheme) && connIds.includes(f.uri.authority);
    const first = folders.findIndex(isGone);
    if (first < 0) {
      return;
    }
    // a single call (multiple calls must wait for onDidChangeWorkspaceFolders); folders before
    // `first` are untouched, so the first folder only changes when it is itself removed
    const kept = folders.slice(first).filter(f => !isGone(f)).map(f => ({ uri: f.uri, name: f.name }));
    vscode.workspace.updateWorkspaceFolders(first, folders.length - first, ...kept);
  }

  function disconnect(connIds: string[]) {
    removeFromWorkspace(connIds);
    connIds.forEach(id => manager.disconnect(id));
  }

  let searchFilterMode = false;
  const findModeSetting = () => vscode.workspace.getConfiguration('workbench.list').get<string>('defaultFindMode');

  const commands: Record<string, (...args: any[]) => unknown> = {
    'remotefs.addFolderToWorkspace': () => addToWorkspace(),
    'remotefs.openInWorkspace': (node?: Node) => addToWorkspace(node),

    'remotefs.openInNewWindow': async (node?: Node) => {
      const conn = await pickConnection(node);
      if (conn) {
        await vscode.commands.executeCommand('vscode.openFolder', rootUri(conn), { forceNewWindow: true });
      }
    },

    'remotefs.openInCurrentWindow': async (node?: Node) => {
      const conn = await pickConnection(node);
      if (conn) {
        await vscode.commands.executeCommand('vscode.openFolder', rootUri(conn), { forceReuseWindow: true });
      }
    },

    'remotefs.openMirror': async (target?: Node | vscode.Uri) => {
      if (target instanceof vscode.Uri) {
        // explorer context menu on an sftp:// / ftp:// folder
        const conn = store.get(target.authority);
        if (!conn) {
          vscode.window.showErrorMessage(vscode.l10n.t('Remote FS 2: unknown remote "{0}".', target.authority));
          return;
        }
        return mirrors.createMirror(conn, target.path || '/');
      }
      const conn = await pickConnection(target, vscode.l10n.t('Select the remote to mirror locally'));
      if (conn) {
        await mirrors.createMirror(conn, '/');
      }
    },
    'remotefs.syncMirror': (uri?: vscode.Uri) => mirrors.syncCommand(uri instanceof vscode.Uri ? uri : undefined),
    'remotefs.downloadMirrorFolder': (uri?: vscode.Uri) =>
      mirrors.downloadFolderCommand(uri instanceof vscode.Uri ? uri : undefined),
    'remotefs.resolveMirrorConflicts': () => mirrors.resolveConflicts(),
    'remotefs.unlinkMirror': (uri?: vscode.Uri) => mirrors.unlinkCommand(uri instanceof vscode.Uri ? uri : undefined),

    'remotefs.addConnection': () => editConnection(),

    'remotefs.editConnection': async (node?: Node) => {
      const conn = await pickConnection(node, vscode.l10n.t('Select the connection to edit'));
      if (conn) {
        editConnection(conn);
      }
    },

    'remotefs.duplicateConnection': async (node?: Node) => {
      const conn = await pickConnection(node, vscode.l10n.t('Select the connection to duplicate'));
      if (conn) {
        editConnection(conn, true);
      }
    },

    'remotefs.deleteConnection': async (node?: Node) => {
      const conn = await pickConnection(node, vscode.l10n.t('Select the connection to delete'));
      if (!conn) {
        return;
      }
      const del = vscode.l10n.t('Delete');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete the connection "{0}"?', conn.name),
        {
          modal: true,
          detail: `${describeConnection(conn)}\n\n${vscode.l10n.t('Its saved password/passphrase will be removed from the keychain. Files on the server are not touched.')}`,
        },
        del
      );
      if (answer !== del) {
        return;
      }
      disconnect([conn.id]);
      await store.delete(conn);
    },

    'remotefs.exportConnections': (node?: Node) => exportConnections(store, node?.conn.id),
    'remotefs.importConnections': () => importConnections(store),

    'remotefs.testConnection': async (node?: Node) => {
      const conn = await pickConnection(node, vscode.l10n.t('Select the connection to test'));
      if (!conn) {
        return;
      }
      manager.disconnect(conn.id);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Remote FS 2: connecting to {0}…', conn.name) },
        async () => {
          const started = Date.now();
          try {
            await manager.getClient(conn, { retryNow: true });
            const entries = await vscode.workspace.fs.readDirectory(rootUri(conn));
            vscode.window.showInformationMessage(
              vscode.l10n.t(
                'Remote FS 2: connected to {0} in {1} ms ({2} entries in {3}).',
                conn.name,
                Date.now() - started,
                entries.length,
                conn.rootPath
              )
            );
          } catch (err) {
            // connection failures are already notified by the manager
            logger.warn(`Test of ${conn.name} failed: ${errorMessage(err)}`);
          }
        }
      );
    },

    'remotefs.disconnect': async (node?: Node) => {
      const conn = node?.conn ?? (await pickConnection(undefined, vscode.l10n.t('Select the connection to close')));
      if (conn) {
        disconnect([conn.id]);
      }
    },

    'remotefs.disconnectAll': () => {
      removeFromWorkspace(store.list().map(c => c.id));
      manager.disconnectAll();
    },

    'remotefs.forgetPassword': async (node?: Node) => {
      const conn = await pickConnection(node);
      if (!conn) {
        return;
      }
      await store.deleteSecret(conn.id, 'password');
      await store.deleteSecret(conn.id, 'passphrase');
      manager.disconnect(conn.id);
      vscode.window.showInformationMessage(vscode.l10n.t('Remote FS 2: saved credentials of "{0}" removed.', conn.name));
    },

    'remotefs.refresh': (node?: Node) => {
      view.refresh();
      if (node) {
        provider.refresh(node.uri);
      }
      for (const folder of remoteFolders()) {
        provider.refresh(folder.uri);
      }
    },

    'remotefs.showActivity': () => activityStatus.showActions(),

    'remotefs.openSettings': () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),

    'remotefs.openSettingsJson': () =>
      vscode.commands.executeCommand('workbench.action.openSettingsJson', {
        revealSetting: { key: 'remotefs.remote' },
      }),

    'remotefs.showLog': () => logger.show(),

    // native find widget of the tree, switched to filter mode: hides the connections that do not match
    'remotefs.searchConnections': async () => {
      await vscode.commands.executeCommand('remotefs.connections.focus');
      if (!searchFilterMode && findModeSetting() !== 'filter') {
        // there is no API to set the mode of one tree: toggle it once, the tree keeps it while it lives
        await vscode.commands.executeCommand('list.toggleFindMode');
      }
      searchFilterMode = true;
      await vscode.commands.executeCommand('list.find');
    },
  };

  // a change of the setting resets the find mode of every tree to the setting
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.list.defaultFindMode')) {
        searchFilterMode = false;
      }
    })
  );

  for (const [id, handler] of Object.entries(commands)) {
    try {
      context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    } catch (err) {
      // already registered by another extension (typically liximomo.remotefs)
      logger.error(`Cannot register the command ${id}: ${errorMessage(err)}`);
    }
  }

  logger.info(`Remote FS 2 activated with ${store.list().length} connection(s)`);
}

export function deactivate() {
  // connections are closed by the disposables registered in activate()
}
