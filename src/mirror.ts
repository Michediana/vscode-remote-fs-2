/**
 * Local mirrors: a remote folder mirrored to a real folder on disk and kept
 * in sync both ways. Unlike `ftp://` / `sftp://` workspace folders (which only
 * exist inside VS Code), a mirror can be used by any tool that works on the
 * local file system: AI agents such as Claude Code, terminals, git, linters…
 *
 * Folders are downloaded on demand. A folder never opened contains only a
 * placeholder file; when the Explorer expands it, it asks decorations for that
 * placeholder, which is the signal used to download the folder.
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { posix } from 'path';
import * as vscode from 'vscode';
import { Connection, ConnectionStore } from './config';
import { RemoteFileSystemProvider } from './fileSystemProvider';
import logger from './logger';
import { RemoteError, errorMessage } from './remote';
import {
  CancelledError,
  ConflictKind,
  MirrorEngine,
  PLACEHOLDER_NAME,
  RemoteSide,
  SyncReport,
} from './sync/engine';
import { rootUri } from './ui/connectionsView';

const LINKS_KEY = 'remotefs.mirrors';
/** Appended to the workspace folder label of a mirror, like ` (remote)` on the remote folders. */
const MIRROR_SUFFIX = ' (Local Mirror)';

export interface MirrorLink {
  /** Connection id (lower-case name). */
  connId: string;
  /** Folder mirrored, as URI path relative to the connection root ('/' = root). */
  remotePath: string;
}

interface ActiveMirror {
  localRoot: string;
  link: MirrorLink;
  conn: Connection;
  engine: MirrorEngine;
  disposables: vscode.Disposable[];
}

const CONFLICT_TEXT: Record<ConflictKind, string> = {
  'both-changed': 'was changed both locally and on the server',
  'deleted-locally': 'was deleted locally but changed on the server',
  'deleted-remotely': 'was changed locally but deleted on the server',
};

function mirrorSettings() {
  const cfg = vscode.workspace.getConfiguration('remotefs.mirror');
  return {
    baseFolder: cfg.get<string>('baseFolder') || '',
    exclude: cfg.get<string[]>('exclude') ?? [],
    maxFileSizeMB: cfg.get<number>('maxFileSizeMB') ?? 50,
    autoSyncInterval: cfg.get<number>('autoSyncInterval') ?? 0,
  };
}

function expandHome(p: string) {
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

function sanitize(segment: string) {
  return segment.replace(/[<>:"|?*\x00-\x1f]/g, '_');
}

function remoteSide(provider: RemoteFileSystemProvider, conn: Connection, base: string): RemoteSide {
  const uri = (rel: string) => rootUri(conn, posix.join(base, '/', rel));
  const run = <T>(rel: string, op: Parameters<RemoteFileSystemProvider['withClient']>[1]) =>
    provider.withClient(uri(rel), op) as Promise<T>;
  return {
    stat: rel =>
      run(rel, async (c, p) => {
        try {
          return await c.stat(p);
        } catch (err) {
          if (err instanceof RemoteError && err.code === 'ENOENT') {
            return undefined;
          }
          throw err;
        }
      }),
    readdir: rel => run(rel, (c, p) => c.readdir(p)),
    read: rel => run(rel, (c, p) => c.readFile(p)),
    write: (rel, data) => run(rel, (c, p) => c.writeFile(p, data)),
    mkdir: rel =>
      run(rel, async (c, p) => {
        try {
          await c.mkdir(p);
        } catch (err) {
          const st = await c.stat(p).catch(() => undefined);
          if (st?.kind !== 'dir') {
            throw err;
          }
        }
      }),
    unlink: rel => run(rel, (c, p) => c.unlink(p)),
    rmdir: rel => run(rel, (c, p) => c.rmdir(p)),
  };
}

export class MirrorManager implements vscode.Disposable, vscode.FileDecorationProvider {
  private readonly active = new Map<string, ActiveMirror>();
  private readonly statusBar = vscode.window.createStatusBarItem('remotefs.mirror', vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [this.statusBar];
  private autoSyncHandle?: NodeJS.Timeout;
  private lastError?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly provider: RemoteFileSystemProvider
  ) {
    this.statusBar.name = 'Remote FS 2 Mirror';
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshActive()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('remotefs.mirror')) {
          this.restartAll();
        } else if (e.affectsConfiguration('remotefs.remote')) {
          this.refreshActive();
        }
      })
    );
    this.refreshActive();
  }

  dispose() {
    clearInterval(this.autoSyncHandle);
    for (const localRoot of [...this.active.keys()]) {
      this.stop(localRoot);
    }
    this.disposables.forEach(d => d.dispose());
  }

  // ---------------------------------------------------------------- links

  private links(): Record<string, MirrorLink> {
    return this.context.globalState.get<Record<string, MirrorLink>>(LINKS_KEY, {});
  }

  private async setLink(localRoot: string, link: MirrorLink | undefined) {
    const links = { ...this.links() };
    if (link) {
      links[localRoot] = link;
    } else {
      delete links[localRoot];
    }
    await this.context.globalState.update(LINKS_KEY, links);
  }

  private manifestPath(localRoot: string) {
    const hash = createHash('sha1').update(localRoot).digest('hex').slice(0, 16);
    return path.join(this.context.globalStorageUri.fsPath, 'mirrors', `${hash}.json`);
  }

  /** Mirror containing the given local path, if any. */
  mirrorFor(fsPath: string): ActiveMirror | undefined {
    for (const m of this.active.values()) {
      if (m.engine.relativeOf(fsPath) !== undefined) {
        return m;
      }
    }
    return undefined;
  }

  /**
   * Called by the Explorer for every visible item: a visible placeholder means
   * its folder was just expanded, so the folder is downloaded.
   */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || path.basename(uri.fsPath) !== PLACEHOLDER_NAME) {
      return undefined;
    }
    const m = this.mirrorFor(uri.fsPath);
    const rel = m?.engine.relativeOf(path.dirname(uri.fsPath));
    if (!m || rel === undefined) {
      return undefined;
    }
    m.engine.requestFetch(rel);
    return { badge: '↓', tooltip: `Downloading from ${m.conn.name}…`, color: new vscode.ThemeColor('descriptionForeground') };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts the mirrors of the local workspace folders that are linked to a remote. */
  private refreshActive() {
    const links = this.links();
    const wanted = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === 'file' && links[folder.uri.fsPath]) {
        wanted.add(folder.uri.fsPath);
      }
    }
    for (const localRoot of [...this.active.keys()]) {
      if (!wanted.has(localRoot) || !this.store.get(this.active.get(localRoot)!.link.connId)) {
        this.stop(localRoot);
      }
    }
    for (const localRoot of wanted) {
      if (!this.active.has(localRoot)) {
        const m = this.start(localRoot, links[localRoot]);
        if (m) {
          // catch up with what changed on either side while the window was closed
          this.syncNow(m, { silent: true });
        }
      }
    }
    this.scheduleAutoSync();
    this.labelMirrorFolders(links);
    this.updateStatus();
  }

  private restartAll() {
    for (const localRoot of [...this.active.keys()]) {
      this.stop(localRoot);
    }
    this.refreshActive();
  }

  private start(localRoot: string, link: MirrorLink): ActiveMirror | undefined {
    const conn = this.store.get(link.connId);
    if (!conn) {
      logger.warn(`Mirror ${localRoot}: connection "${link.connId}" no longer exists`);
      return undefined;
    }
    const settings = mirrorSettings();
    const engine: MirrorEngine = new MirrorEngine({
      localRoot,
      remote: remoteSide(this.provider, conn, link.remotePath),
      manifestPath: this.manifestPath(localRoot),
      exclude: settings.exclude,
      maxFileSize: Math.max(0, settings.maxFileSizeMB) * 1024 * 1024,
      listener: {
        log: msg => logger.info(`[mirror ${conn.name}] ${msg}`),
        onAction: (rel, action) => logger.info(`[mirror ${conn.name}] ${action} ${rel}`),
        onBusyChange: () => this.updateStatus(),
        onError: (rel, err) => {
          this.lastError = `${rel}: ${errorMessage(err)}`;
          this.updateStatus();
        },
        onConflict: c => {
          this.updateStatus();
          if (!this.bulk.has(localRoot)) {
            this.promptConflict(mirror, c.rel, c.kind);
          }
        },
        confirmRemoteDeletes: rels => this.confirmRemoteDeletes(conn, rels),
      },
    });
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(localRoot), '**/*')
    );
    const changed = (uri: vscode.Uri) => engine.localChanged(uri.fsPath);
    const mirror: ActiveMirror = {
      localRoot,
      link,
      conn,
      engine,
      disposables: [watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)],
    };
    this.active.set(localRoot, mirror);
    logger.info(`Mirror active: ${localRoot} <-> ${conn.scheme}://${conn.name}${link.remotePath}`);
    return mirror;
  }

  private stop(localRoot: string) {
    const m = this.active.get(localRoot);
    if (!m) {
      return;
    }
    this.active.delete(localRoot);
    m.disposables.forEach(d => d.dispose());
    m.engine.dispose();
    this.updateStatus();
  }

  private scheduleAutoSync() {
    clearInterval(this.autoSyncHandle);
    this.autoSyncHandle = undefined;
    const seconds = mirrorSettings().autoSyncInterval;
    if (seconds > 0 && this.active.size) {
      this.autoSyncHandle = setInterval(() => {
        for (const m of this.active.values()) {
          if (!m.engine.busy) {
            this.syncNow(m, { silent: true });
          }
        }
      }, Math.max(30, seconds) * 1000);
    }
  }

  // ---------------------------------------------------------------- sync

  /** Mirrors whose conflicts are being collected by a full sync (reported once at the end). */
  private readonly bulk = new Set<string>();

  async syncNow(m: ActiveMirror, opts: { silent?: boolean; title?: string } = {}): Promise<SyncReport | undefined> {
    this.bulk.add(m.localRoot);
    this.lastError = undefined;
    const run = (progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken) => {
      let last = 0;
      return m.engine.syncAll({
        isCancelled: () => token?.isCancellationRequested ?? false,
        onProgress: (done, total, rel) => {
          if (!progress || !total) {
            return;
          }
          const pct = (done / total) * 100;
          progress.report({ message: `${done}/${total} ${rel}`, increment: pct - last });
          last = pct;
        },
      });
    };
    try {
      const report = opts.silent
        ? await run()
        : await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: opts.title ?? `Remote FS 2: syncing ${m.conn.name}`,
              cancellable: true,
            },
            (progress, token) => run(progress, token)
          );
      this.logReport(m, report);
      if (report.errors.length) {
        this.lastError = report.errors[0];
        const log = 'Show Log';
        vscode.window
          .showWarningMessage(`Remote FS 2: ${report.errors.length} file(s) of ${m.conn.name} could not be synced.`, log)
          .then(a => a === log && logger.show());
      }
      if (report.conflicts.length === 1) {
        const c = m.engine.conflicts.find(x => x.rel === report.conflicts[0]);
        if (c) {
          this.promptConflict(m, c.rel, c.kind);
        }
      } else if (report.conflicts.length > 1) {
        const resolve = 'Resolve…';
        vscode.window
          .showWarningMessage(
            `Remote FS 2: ${report.conflicts.length} files of ${m.conn.name} changed both locally and on the server.`,
            resolve
          )
          .then(a => {
            if (a === resolve) {
              this.resolveConflicts();
            }
          });
      } else if (!opts.silent) {
        const n = report.downloaded.length + report.uploaded.length + report.deletedLocal.length + report.deletedRemote.length;
        vscode.window.setStatusBarMessage(`$(check) Remote FS 2: ${m.conn.name} in sync (${n} change(s))`, 5000);
      }
      return report;
    } catch (err) {
      if (err instanceof CancelledError) {
        logger.info(`Sync of ${m.conn.name} cancelled`);
        return undefined;
      }
      this.lastError = errorMessage(err);
      logger.error(`Sync of ${m.localRoot} failed: ${errorMessage(err)}`);
      if (!(err instanceof RemoteError && err.code === 'ECANCELED')) {
        vscode.window.showErrorMessage(`Remote FS 2: sync of ${m.conn.name} failed: ${errorMessage(err)}`);
      }
      return undefined;
    } finally {
      this.bulk.delete(m.localRoot);
      this.updateStatus();
    }
  }

  private logReport(m: ActiveMirror, r: SyncReport) {
    logger.info(
      `Sync of ${m.conn.name}: ${r.downloaded.length} downloaded, ${r.uploaded.length} uploaded, ` +
        `${r.deletedLocal.length} deleted locally, ${r.deletedRemote.length} deleted remotely, ` +
        `${r.conflicts.length} conflict(s), ${r.skipped.length} skipped, ${r.errors.length} error(s), ${r.unchanged} unchanged`
    );
    if (r.skipped.length) {
      logger.info(`Skipped (size limit or type clash): ${r.skipped.join(', ')}`);
    }
  }

  private async confirmRemoteDeletes(conn: Connection, rels: string[]) {
    const del = 'Delete on Server';
    const keep = 'Keep on Server';
    const list = rels.slice(0, 15).join('\n') + (rels.length > 15 ? `\n… and ${rels.length - 15} more` : '');
    const answer = await vscode.window.showWarningMessage(
      `Remote FS 2: ${rels.length} files were deleted from the local mirror of ${conn.name}. Delete them on the server too?`,
      { modal: true, detail: `${list}\n\n"Keep on Server" downloads them again on the next sync.` },
      del,
      keep
    );
    return answer === del;
  }

  // ---------------------------------------------------------------- conflicts

  private remoteUri(m: ActiveMirror, rel: string) {
    return rootUri(m.conn, posix.join(m.link.remotePath, '/', rel));
  }

  private async compare(m: ActiveMirror, rel: string) {
    const local = vscode.Uri.file(m.engine.localPath(rel));
    const remote = this.remoteUri(m, rel);
    await vscode.commands.executeCommand('vscode.diff', remote, local, `${rel} (server ↔ local)`);
  }

  private async promptConflict(m: ActiveMirror, rel: string, kind: ConflictKind): Promise<void> {
    const compare = 'Compare';
    const keepLocal = kind === 'deleted-locally' ? 'Delete on Server' : 'Upload Local';
    const keepRemote = kind === 'deleted-remotely' ? 'Delete Local' : 'Download Server Copy';
    const answer = await vscode.window.showWarningMessage(
      `Remote FS 2: "${rel}" ${CONFLICT_TEXT[kind]} (${m.conn.name}). It was not synced.`,
      ...(kind === 'both-changed' ? [compare] : []),
      keepLocal,
      keepRemote
    );
    if (answer === compare) {
      await this.compare(m, rel);
      return this.promptConflict(m, rel, kind);
    }
    if (answer === keepLocal || answer === keepRemote) {
      try {
        await m.engine.resolve(rel, answer === keepLocal ? 'local' : 'remote');
      } catch (err) {
        vscode.window.showErrorMessage(`Remote FS 2: ${rel}: ${errorMessage(err)}`);
      }
      this.updateStatus();
    }
  }

  async resolveConflicts(): Promise<void> {
    const items = [...this.active.values()].flatMap(m =>
      m.engine.conflicts.map(c => ({
        label: c.rel,
        description: m.conn.name,
        detail: CONFLICT_TEXT[c.kind],
        m,
        c,
      }))
    );
    if (!items.length) {
      vscode.window.showInformationMessage('Remote FS 2: no conflicts.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a conflict to resolve' });
    if (picked) {
      await this.promptConflict(picked.m, picked.c.rel, picked.c.kind);
      if ([...this.active.values()].some(m => m.engine.conflicts.length)) {
        return this.resolveConflicts();
      }
    }
  }

  // ---------------------------------------------------------------- status bar

  private updateStatus() {
    vscode.commands.executeCommand('setContext', 'remotefs.hasMirror', this.active.size > 0);
    if (!this.active.size) {
      this.statusBar.hide();
      return;
    }
    const mirrors = [...this.active.values()];
    const conflicts = mirrors.reduce((n, m) => n + m.engine.conflicts.length, 0);
    const busy = mirrors.some(m => m.engine.busy);
    const names = mirrors.map(m => m.conn.name).join(', ');
    if (conflicts) {
      this.statusBar.text = `$(warning) ${conflicts} conflict${conflicts > 1 ? 's' : ''}`;
      this.statusBar.tooltip = 'Remote FS 2 mirror: click to resolve conflicts';
      this.statusBar.command = 'remotefs.resolveMirrorConflicts';
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBar.text = busy ? `$(sync~spin) ${names}` : this.lastError ? `$(cloud-offline) ${names}` : `$(cloud) ${names}`;
      this.statusBar.tooltip = busy
        ? 'Remote FS 2 mirror: syncing…'
        : this.lastError
          ? `Remote FS 2 mirror: last sync failed (${this.lastError}). Click to sync now.`
          : 'Remote FS 2 mirror: local changes are uploaded automatically, folders are downloaded when opened. Click to sync now (re-checks the opened folders on the server).';
      this.statusBar.command = 'remotefs.syncMirror';
      this.statusBar.backgroundColor = this.lastError ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    }
    this.statusBar.show();
  }

  // ---------------------------------------------------------------- commands

  private defaultLocalRoot(conn: Connection, remotePath: string) {
    const base = expandHome(mirrorSettings().baseFolder) || path.join(os.homedir(), 'RemoteFS');
    const segments = remotePath.split('/').filter(Boolean).map(sanitize);
    return path.join(base, sanitize(conn.name), ...segments);
  }

  /**
   * Downloads a remote folder into a local folder, links them, and opens the
   * local folder so that AI agents / tools can work on it.
   */
  async createMirror(conn: Connection, remotePath: string) {
    remotePath = posix.normalize('/' + remotePath);
    const existing = Object.entries(this.links()).find(
      ([, l]) => l.connId === conn.id && l.remotePath === remotePath
    );
    let localRoot = existing?.[0] ?? this.defaultLocalRoot(conn, remotePath);

    if (!existing) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: localRoot, description: 'default location', id: 'default' },
          { label: '$(folder) Choose another folder…', id: 'pick' },
        ],
        { title: `Local mirror of ${conn.name}${remotePath}`, placeHolder: 'Where should the files be downloaded?' }
      );
      if (!choice) {
        return;
      }
      if (choice.id === 'pick') {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Use as Mirror',
        });
        if (!picked?.length) {
          return;
        }
        localRoot = picked[0].fsPath;
      }
      if (existsSync(localRoot) && readdirSync(localRoot).length) {
        const go = 'Use It';
        const answer = await vscode.window.showWarningMessage(
          `${localRoot} is not empty.`,
          {
            modal: true,
            detail:
              'Files identical on both sides are adopted, files only on the server are downloaded, files only in the folder are UPLOADED to the server, and files that differ are reported as conflicts (nothing is overwritten).',
          },
          go
        );
        if (answer !== go) {
          return;
        }
      }
      await this.setLink(localRoot, { connId: conn.id, remotePath });
    }

    const link = this.links()[localRoot];
    let m = this.active.get(localRoot);
    let temporary = false;
    if (!m) {
      m = this.start(localRoot, link);
      temporary = true;
    }
    if (!m) {
      return;
    }
    // only the top folder is downloaded now; sub-folders are downloaded when opened
    const report = await this.syncNow(m, { title: `Remote FS 2: opening ${conn.name}${remotePath}` });
    if (temporary) {
      // the window that will show the folder runs its own mirror (and watcher)
      this.stop(localRoot);
    }
    if (!report) {
      return;
    }
    await this.openLocal(localRoot);
  }

  private async openLocal(localRoot: string) {
    const uri = vscode.Uri.file(localRoot);
    if (vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath === localRoot) {
      this.refreshActive();
      return;
    }
    const items = [
      {
        label: '$(empty-window) Open in New Window',
        detail: 'Recommended for AI agents: the mirror becomes the project root (e.g. the working directory of Claude Code).',
        id: 'new',
      },
      { label: '$(window) Open in Current Window', id: 'current' },
      { label: '$(add) Add to Workspace', detail: 'Agents usually work only in the first workspace folder.', id: 'add' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `Mirror ready in ${localRoot}` });
    if (picked?.id === 'new') {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    } else if (picked?.id === 'current') {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
    } else if (picked?.id === 'add') {
      const count = vscode.workspace.workspaceFolders?.length ?? 0;
      vscode.workspace.updateWorkspaceFolders(count, 0, { uri, name: this.mirrorLabel(localRoot) });
    }
  }

  /**
   * Labels the mirror folders of a multi-root workspace that still have the default name
   * (folder name, or the old lowercase label), so they are not confused with the remote ones.
   * Renaming keeps the URI, so even the first folder does not restart the extension host.
   */
  private labelMirrorFolders(links: Record<string, MirrorLink>) {
    if (!vscode.workspace.workspaceFile) {
      return; // a single-folder window cannot rename its folder
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const localRoot = folder.uri.fsPath;
      if (folder.uri.scheme !== 'file' || !links[localRoot]) {
        continue;
      }
      const label = this.mirrorLabel(localRoot);
      const isDefault = folder.name === path.basename(localRoot) || / \(local mirror\)$/.test(folder.name);
      if (folder.name !== label && isDefault) {
        // one folder per call: the next one is renamed on the resulting onDidChangeWorkspaceFolders
        vscode.workspace.updateWorkspaceFolders(folder.index, 1, { uri: folder.uri, name: label });
        return;
      }
    }
  }

  /** Workspace folder label of a mirror: distinguishes it from the remote folder of the same connection. */
  private mirrorLabel(localRoot: string) {
    const link = this.links()[localRoot];
    const conn = link && this.store.get(link.connId);
    if (!conn) {
      return path.basename(localRoot);
    }
    const name = conn.config.label || conn.name;
    const sub = link.remotePath === '/' ? '' : ` — ${posix.basename(link.remotePath)}`;
    return `${name}${sub}${MIRROR_SUFFIX}`;
  }

  private async pickActive(placeHolder: string): Promise<ActiveMirror | undefined> {
    const mirrors = [...this.active.values()];
    if (mirrors.length <= 1) {
      if (!mirrors.length) {
        vscode.window.showInformationMessage(
          'Remote FS 2: no local mirror is open. Use "Open Local Mirror" on a connection in the Remote FS 2 view.'
        );
      }
      return mirrors[0];
    }
    const picked = await vscode.window.showQuickPick(
      mirrors.map(m => ({ label: m.conn.name, description: m.localRoot, m })),
      { placeHolder }
    );
    return picked?.m;
  }

  /** Explorer context menu: download a folder of a mirror (optionally with all sub-folders). */
  async downloadFolderCommand(uri?: vscode.Uri) {
    const m = uri ? this.mirrorFor(uri.fsPath) : await this.pickActive('Select the mirror');
    if (!m) {
      return;
    }
    const rel = uri ? m.engine.relativeOf(uri.fsPath) ?? '' : '';
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'This folder only', description: 'its files; sub-folders stay on demand', recursive: false },
        { label: 'With all sub-folders', description: 'can take long on big trees', recursive: true },
      ],
      { placeHolder: `Download ${rel || m.conn.name} from the server` }
    );
    if (!picked) {
      return;
    }
    try {
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Remote FS 2: downloading ${rel || '/'}`, cancellable: true },
        (progress, token) =>
          m.engine.fetchDir(rel, {
            recursive: picked.recursive,
            isCancelled: () => token.isCancellationRequested,
            onProgress: (done, total, file) => progress.report({ message: total ? `${done}/${total} ${file}` : undefined }),
          })
      );
      this.logReport(m, report);
    } catch (err) {
      if (!(err instanceof CancelledError)) {
        vscode.window.showErrorMessage(`Remote FS 2: download of ${rel || '/'} failed: ${errorMessage(err)}`);
      }
    }
  }

  async syncCommand(uri?: vscode.Uri) {
    const m = uri ? this.mirrorFor(uri.fsPath) : await this.pickActive('Select the mirror to sync');
    if (m) {
      await this.syncNow(m);
    }
  }

  async unlinkCommand(uri?: vscode.Uri) {
    const m = uri ? this.mirrorFor(uri.fsPath) : await this.pickActive('Select the mirror to stop syncing');
    if (!m) {
      return;
    }
    const stop = 'Stop Syncing';
    const answer = await vscode.window.showWarningMessage(
      `Stop syncing ${m.localRoot} with ${m.conn.name}?`,
      { modal: true, detail: 'The local files are kept; changes will no longer be uploaded.' },
      stop
    );
    if (answer !== stop) {
      return;
    }
    const localRoot = m.localRoot;
    this.stop(localRoot);
    await this.setLink(localRoot, undefined);
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(this.manifestPath(localRoot)));
    } catch {
      // never synced
    }
  }
}
