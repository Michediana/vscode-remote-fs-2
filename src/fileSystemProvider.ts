import { posix } from 'path';
import * as vscode from 'vscode';
import { Connection, ConnectionStore, connectionId } from './config';
import { ActivityTracker } from './activity';
import { ConnectionManager } from './connectionManager';
import logger from './logger';
import { RemoteClient, RemoteError, RemoteStat, errorMessage, removeRecursive } from './remote';

function toFileType(stat: RemoteStat): vscode.FileType {
  let type =
    stat.kind === 'dir' ? vscode.FileType.Directory : stat.kind === 'file' ? vscode.FileType.File : vscode.FileType.Unknown;
  if (stat.isSymlink) {
    type |= vscode.FileType.SymbolicLink;
  }
  return type;
}

function toFsError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof vscode.FileSystemError) {
    return err;
  }
  if (err instanceof RemoteError) {
    switch (err.code) {
      case 'ENOENT':
        return vscode.FileSystemError.FileNotFound(uri);
      case 'EACCES':
        return vscode.FileSystemError.NoPermissions(uri);
      case 'EEXIST':
        return vscode.FileSystemError.FileExists(uri);
      case 'ECONN':
      case 'EAUTH':
      case 'ECANCELED':
        return vscode.FileSystemError.Unavailable(`${uri.authority}: ${err.message}`);
    }
  }
  return new vscode.FileSystemError(`${uri.toString(true)}: ${errorMessage(err)}`);
}

/**
 * One provider instance serves all remote schemes (sftp, ftp, ftps). The URI
 * authority selects the connection; the URI path is relative to its rootPath
 * unless the query contains `absolute`.
 */
export class RemoteFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;
  private buffered: vscode.FileChangeEvent[] = [];
  private fireHandle?: NodeJS.Timeout;
  private readonly roots = new WeakMap<RemoteClient, Promise<string>>();
  /** Connections on which an operation failed because the connection was not available. */
  private readonly unavailable = new Set<string>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    readonly activity: ActivityTracker
  ) {}

  /**
   * True (once) when operations on the connection failed for lack of a connection since the
   * last call: what VS Code showed of it (e.g. an empty Explorer folder) must be re-read.
   */
  takeUnavailable(id: string) {
    return this.unavailable.delete(id);
  }

  dispose() {
    this._onDidChangeFile.dispose();
  }

  private connectionFor(uri: vscode.Uri): Connection {
    const conn = this.store.get(connectionId(uri.authority));
    if (!conn) {
      throw vscode.FileSystemError.Unavailable(
        `Unknown remote "${uri.authority}". Add it from the Remote FS 2 view.`
      );
    }
    return conn;
  }

  private root(conn: Connection, client: RemoteClient): Promise<string> {
    let root = this.roots.get(client);
    if (!root) {
      const raw = conn.rootPath;
      root = raw.startsWith('/')
        ? Promise.resolve(posix.normalize(raw))
        : client.realpath(raw.replace(/^~\/?/, '') || '.');
      this.roots.set(client, root);
      root.catch(() => this.roots.delete(client));
    }
    return root;
  }

  private async remotePath(conn: Connection, client: RemoteClient, uri: vscode.Uri) {
    if (uri.query.includes('absolute')) {
      return posix.normalize(uri.path || '/');
    }
    const root = await this.root(conn, client);
    // normalize collapses '..' so a URI can't escape above "/"
    return posix.join(root, posix.normalize('/' + uri.path));
  }

  /**
   * Runs an operation with a live client and the absolute remote path of `uri`.
   * If the connection dropped in the meantime the operation is retried once on
   * a fresh connection. Errors are passed through unchanged (RemoteError).
   */
  async withClient<T>(
    uri: vscode.Uri,
    op: (client: RemoteClient, path: string) => Promise<T>,
    label = 'sync',
    upBytes = 0
  ): Promise<T> {
    const conn = this.connectionFor(uri);
    const done = this.activity.begin(conn.id, `${label} ${uri.path || '/'}`, upBytes);
    try {
      const result = await this.attempt(conn, uri, op);
      done(result);
      return result;
    } catch (err) {
      done(undefined, err);
      if (err instanceof RemoteError && ['ECONN', 'EAUTH', 'ECANCELED'].includes(err.code)) {
        this.unavailable.add(conn.id);
      }
      throw err;
    }
  }

  private async attempt<T>(
    conn: Connection,
    uri: vscode.Uri,
    op: (client: RemoteClient, path: string) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.manager.getClient(conn);
      try {
        return await op(client, await this.remotePath(conn, client, uri));
      } catch (err) {
        if (attempt === 0 && err instanceof RemoteError && err.code === 'ECONN' && client.closed) {
          logger.info(`Connection to ${conn.name} lost, reconnecting`);
          continue;
        }
        throw err;
      }
    }
  }

  /** Same as withClient, with errors converted to FileSystemError. */
  private async run<T>(
    uri: vscode.Uri,
    label: string,
    op: (client: RemoteClient, path: string) => Promise<T>,
    upBytes = 0
  ): Promise<T> {
    try {
      return await this.withClient(uri, op, label, upBytes);
    } catch (err) {
      logger.debug(`${uri.toString(true)}: ${errorMessage(err)}`);
      throw toFsError(err, uri);
    }
  }

  private fireSoon(...events: vscode.FileChangeEvent[]) {
    this.buffered.push(...events);
    clearTimeout(this.fireHandle);
    this.fireHandle = setTimeout(() => {
      const events = this.buffered;
      this.buffered = [];
      this._onDidChangeFile.fire(events);
    }, 5);
  }

  private parentOf(uri: vscode.Uri) {
    return uri.with({ path: posix.dirname(uri.path) });
  }

  /** Signals the editor that a folder (and what is shown from it) must be re-read. */
  refresh(uri: vscode.Uri) {
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }

  watch(): vscode.Disposable {
    // Remote watching is not supported by the protocols; use the Refresh command.
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.run(uri, 'stat', async (client, path) => {
      const st = await client.stat(path);
      return { type: toFileType(st), ctime: 0, mtime: st.mtime, size: st.size };
    });
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.run(uri, 'list', async (client, path) => {
      const entries = await client.readdir(path);
      return entries.map(e => [e.name, toFileType(e)] as [string, vscode.FileType]);
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.run(uri, 'mkdir', (client, path) => client.mkdir(path));
    this.fireSoon(
      { type: vscode.FileChangeType.Changed, uri: this.parentOf(uri) },
      { type: vscode.FileChangeType.Created, uri }
    );
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.run(uri, 'read', (client, path) => client.readFile(path));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }) {
    const created = await this.run(uri, 'write', async (client, path) => {
      let existing: RemoteStat | undefined;
      try {
        existing = await client.stat(path);
      } catch (err) {
        if (!(err instanceof RemoteError && err.code === 'ENOENT')) {
          throw err;
        }
      }
      if (existing?.kind === 'dir') {
        throw vscode.FileSystemError.FileIsADirectory(uri);
      }
      if (!existing && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (existing && options.create && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }
      await client.writeFile(path, content);
      return !existing;
    }, content.byteLength);
    this.fireSoon(
      created
        ? { type: vscode.FileChangeType.Created, uri }
        : { type: vscode.FileChangeType.Changed, uri }
    );
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.run(uri, 'delete', async (client, path) => {
      const st = await client.stat(path);
      if (st.kind === 'dir' && !st.isSymlink) {
        return options.recursive ? removeRecursive(client, path) : client.rmdir(path);
      }
      return client.unlink(path);
    });
    this.fireSoon(
      { type: vscode.FileChangeType.Changed, uri: this.parentOf(uri) },
      { type: vscode.FileChangeType.Deleted, uri }
    );
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (connectionId(oldUri.authority) !== connectionId(newUri.authority) || oldUri.scheme !== newUri.scheme) {
      // VS Code falls back to copy + delete across providers/connections
      throw vscode.FileSystemError.Unavailable('Cannot rename across different remotes');
    }
    await this.run(oldUri, 'rename', async (client, from) => {
      const conn = this.connectionFor(newUri);
      const to = await this.remotePath(conn, client, newUri);
      if (!options.overwrite) {
        let exists = true;
        try {
          await client.stat(to);
        } catch {
          exists = false;
        }
        if (exists) {
          throw vscode.FileSystemError.FileExists(newUri);
        }
      }
      await client.rename(from, to, options.overwrite);
    });
    this.fireSoon(
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    );
  }
}
