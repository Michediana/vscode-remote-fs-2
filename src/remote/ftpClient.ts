import { posix } from 'path';
import { Socket } from 'net';
import { PassThrough, Readable, Writable } from 'stream';
import { Client, FileInfo, FileType, FTPError } from 'basic-ftp';
import { SerialQueue } from './queue';
import { EntryKind, RemoteClient, RemoteDirEntry, RemoteError, RemoteStat, errorMessage } from './types';

export interface FtpOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** false = plain FTP, true = explicit FTPS (AUTH TLS), 'implicit' = implicit FTPS */
  secure: boolean | 'implicit';
  rejectUnauthorized: boolean;
  connectTimeout: number;
}

/** How long a directory listing is reused to answer `stat` calls. */
const LISTING_TTL = 2000;
const KEEPALIVE_INTERVAL = 30_000;

function toRemoteError(err: unknown, path?: string): RemoteError {
  if (err instanceof RemoteError) {
    return err;
  }
  const where = path ? `${path}: ` : '';
  const msg = errorMessage(err);
  if (err instanceof FTPError) {
    // 550: file unavailable (not found / no access), 553: name not allowed,
    // 530: not logged in, 532/550 permission variants are server specific.
    if (/permission|denied|not allowed|EACCES|EPERM/i.test(msg) && err.code >= 450) {
      return new RemoteError('EACCES', `${where}${msg}`, err);
    }
    if (err.code === 550 || err.code === 551 || /no such file|not found|ENOENT/i.test(msg)) {
      return new RemoteError('ENOENT', `${where}${msg}`, err);
    }
    if (err.code === 553 || err.code === 532) {
      return new RemoteError('EACCES', `${where}${msg}`, err);
    }
    if (err.code === 530) {
      return new RemoteError('EAUTH', msg, err);
    }
    if (err.code === 421) {
      return new RemoteError('ECONN', msg, err);
    }
    return new RemoteError('EOTHER', `${where}${msg}`, err);
  }
  if (/closed|timeout|ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH/i.test(msg)) {
    return new RemoteError('ECONN', `${where}${msg}`, err);
  }
  return new RemoteError('EOTHER', `${where}${msg}`, err);
}

/**
 * Some servers (IIS among others) close the data connection with a TCP reset instead of a
 * normal close once a listing or download has been sent. basic-ftp treats any data socket
 * error as fatal and closes the whole client, so every operation in the queue fails. A reset
 * on the data socket is turned into a normal end of data instead: the reply on the control
 * connection (226 transfer complete, 426 aborted…) still decides whether the transfer succeeded.
 */
function tolerateDataReset(ftp: Client, onReset: () => void) {
  const ctx = ftp.ftp;
  const proto = Object.getPrototypeOf(ctx);
  const desc = Object.getOwnPropertyDescriptor(proto, 'dataSocket');
  if (!desc?.get || !desc.set) {
    return; // basic-ftp internals changed: keep its default behaviour
  }
  Object.defineProperty(ctx, 'dataSocket', {
    configurable: true,
    get() {
      return desc.get!.call(this);
    },
    set(socket: Socket | undefined) {
      if (socket) {
        const destroy = socket.destroy.bind(socket);
        socket.destroy = ((err?: Error) => {
          if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ECONNRESET' || socket.readableEnded) {
            return destroy(err);
          }
          onReset();
          socket.destroy = destroy;
          // deliver what was received, then end the stream as if the server had closed it
          socket.push(null);
          socket.once('end', () => destroy());
          // nobody is reading (e.g. an upload): report the reset as basic-ftp would
          setTimeout(() => destroy(err), 2000).unref?.();
          return socket;
        }) as typeof socket.destroy;
      }
      desc.set!.call(this, socket);
    },
  });
}

function kindOf(info: FileInfo): EntryKind {
  switch (info.type) {
    case FileType.Directory:
      return 'dir';
    case FileType.File:
      return 'file';
    default:
      return 'unknown';
  }
}

function mtimeOf(info: FileInfo): number {
  if (info.modifiedAt) {
    return info.modifiedAt.getTime();
  }
  const parsed = Date.parse(info.rawModifiedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export class FtpClient implements RemoteClient {
  private readonly queue = new SerialQueue();
  private readonly listings = new Map<string, { at: number; entries: Promise<RemoteDirEntry[]> }>();
  private readonly closeListeners: Array<() => void> = [];
  /**
   * Directories seen to exist (listed, or found as entries of a listing). `stat` checks the
   * parent exists before listing it: some servers drop the whole control connection when
   * asked to LIST a missing directory (VS Code stats `.vscode/settings.json` & co. on startup).
   */
  private readonly knownDirs = new Set<string>(['/']);
  private keepAlive?: NodeJS.Timeout;
  private _closed = false;
  /** Data connections the server reset (tolerated, see tolerateDataReset). */
  dataResets = 0;

  private constructor(private readonly ftp: Client) {
    tolerateDataReset(ftp, () => this.dataResets++);
    this.keepAlive = setInterval(() => {
      if (this.queue.idle) {
        this.run(() => this.ftp.send('NOOP')).catch(() => undefined);
      }
    }, KEEPALIVE_INTERVAL);
    this.keepAlive.unref?.();
  }

  static async connect(opts: FtpOptions): Promise<FtpClient> {
    const ftp = new Client(opts.connectTimeout);
    try {
      await ftp.access({
        host: opts.host,
        port: opts.port,
        user: opts.username,
        password: opts.password,
        secure: opts.secure,
        secureOptions: { rejectUnauthorized: opts.rejectUnauthorized, servername: opts.host },
      });
    } catch (err) {
      ftp.close();
      const e = toRemoteError(err);
      if (e.code === 'EAUTH') {
        throw new RemoteError('EAUTH', `Authentication failed for ${opts.username ?? 'anonymous'}@${opts.host}`, err);
      }
      throw new RemoteError(e.code === 'EOTHER' ? 'ECONN' : e.code, `Cannot connect to ${opts.host}:${opts.port}: ${e.message}`, err);
    }
    return new FtpClient(ftp);
  }

  get closed() {
    this.checkClosed();
    return this._closed;
  }

  onClose(listener: () => void) {
    if (this._closed) {
      listener();
    } else {
      this.closeListeners.push(listener);
    }
  }

  /** Why the connection ended, when it was not closed on purpose. */
  get closeReason(): string | undefined {
    const err = (this.ftp.ftp as unknown as { _closingError?: Error })._closingError;
    return err && !/^User closed client/.test(err.message) ? err.message : undefined;
  }

  close() {
    this.ftp.close();
    this.checkClosed();
  }

  private checkClosed() {
    if (!this._closed && this.ftp.closed) {
      this._closed = true;
      clearInterval(this.keepAlive);
      for (const l of this.closeListeners.splice(0)) {
        l();
      }
    }
  }

  /** FTP allows a single command at a time on a control connection. */
  private run<T>(task: () => Promise<T>, path?: string): Promise<T> {
    if (this.closed) {
      return Promise.reject(new RemoteError('ECONN', 'Not connected'));
    }
    return this.queue.add(async () => {
      try {
        return await task();
      } catch (err) {
        throw toRemoteError(err, path);
      } finally {
        this.checkClosed();
      }
    });
  }

  private invalidate(...paths: string[]) {
    for (const p of paths) {
      this.listings.delete(p);
      this.listings.delete(posix.dirname(p));
    }
  }

  /** Forgets that `path` and everything below it are directories (after a delete or rename). */
  private forgetDirs(path: string) {
    const prefix = path.endsWith('/') ? path : path + '/';
    for (const d of this.knownDirs) {
      if (d === path || d.startsWith(prefix)) {
        this.knownDirs.delete(d);
      }
    }
    this.knownDirs.add('/');
  }

  private async resolveSymlink(path: string): Promise<EntryKind> {
    // `cd` succeeds only for directories; all paths we use are absolute, so
    // changing the working directory has no side effect on later commands.
    try {
      await this.ftp.cd(path);
      return 'dir';
    } catch {
      return 'file';
    }
  }

  private listUncached(dir: string): Promise<RemoteDirEntry[]> {
    return this.run(async () => {
      const list = await this.ftp.list(dir);
      const out: RemoteDirEntry[] = [];
      for (const info of list) {
        if (info.name === '.' || info.name === '..') {
          continue;
        }
        const isSymlink = info.type === FileType.SymbolicLink;
        out.push({
          name: info.name,
          kind: isSymlink ? await this.resolveSymlink(posix.join(dir, info.name)) : kindOf(info),
          isSymlink,
          size: Number(info.size) || 0,
          mtime: mtimeOf(info),
        });
      }
      this.knownDirs.add(dir);
      for (const e of out) {
        if (e.kind === 'dir') {
          this.knownDirs.add(posix.join(dir, e.name));
        }
      }
      return out;
    }, dir);
  }

  readdir(dir: string): Promise<RemoteDirEntry[]> {
    const entries = this.listUncached(dir);
    this.listings.set(dir, { at: Date.now(), entries });
    entries.catch(() => this.listings.delete(dir));
    return entries;
  }

  private cachedList(dir: string): Promise<RemoteDirEntry[]> {
    const hit = this.listings.get(dir);
    if (hit && Date.now() - hit.at < LISTING_TTL) {
      return hit.entries;
    }
    return this.readdir(dir);
  }

  async stat(path: string): Promise<RemoteStat> {
    if (this.closed) {
      throw new RemoteError('ECONN', 'Not connected');
    }
    if (path === '/' || path === '') {
      return { kind: 'dir', isSymlink: false, size: 0, mtime: 0 };
    }
    // FTP has no portable "stat": look the entry up in its parent's listing.
    const parent = posix.dirname(path);
    if (!this.knownDirs.has(parent)) {
      // make sure the parent exists before listing it (see knownDirs); recursion checks the ancestors
      const st = await this.stat(parent);
      if (st.kind !== 'dir') {
        throw new RemoteError('ENOENT', `${path}: no such file or directory`);
      }
    }
    const entries = await this.cachedList(parent);
    const name = posix.basename(path);
    const entry = entries.find(e => e.name === name);
    if (!entry) {
      throw new RemoteError('ENOENT', `${path}: no such file or directory`);
    }
    const { name: _n, ...stat } = entry;
    return stat;
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.run(async () => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
      });
      await this.ftp.downloadTo(sink, path);
      return Buffer.concat(chunks);
    }, path);
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    this.invalidate(path);
    return this.run(async () => {
      const source: Readable = new PassThrough();
      (source as PassThrough).end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      await this.ftp.uploadFrom(source, path);
      this.invalidate(path);
    }, path);
  }

  async mkdir(path: string): Promise<void> {
    // some servers create missing parents or ignore existing directories: check first
    if (await this.exists(path)) {
      throw new RemoteError('EEXIST', `${path}: already exists`);
    }
    const parent = posix.dirname(path);
    if (parent !== path && parent !== '/' && !(await this.exists(parent))) {
      throw new RemoteError('ENOENT', `${parent}: no such file or directory`);
    }
    try {
      await this.run(() => this.ftp.send('MKD ' + path), path);
    } catch (err) {
      // most servers answer 550 both for "exists" and "parent missing"
      if ((await this.exists(path))) {
        throw new RemoteError('EEXIST', `${path}: already exists`, err);
      }
      throw err;
    } finally {
      this.invalidate(path);
    }
  }

  async rmdir(path: string): Promise<void> {
    this.invalidate(path);
    this.forgetDirs(path);
    await this.run(() => this.ftp.removeEmptyDir(path), path);
    this.invalidate(path);
  }

  async unlink(path: string): Promise<void> {
    this.invalidate(path);
    await this.run(() => this.ftp.remove(path), path);
    this.invalidate(path);
  }

  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    this.invalidate(from, to);
    this.forgetDirs(from);
    this.forgetDirs(to);
    if (overwrite && (await this.exists(to))) {
      await this.unlink(to);
    }
    await this.run(() => this.ftp.rename(from, to), from);
    this.invalidate(from, to);
  }

  realpath(path: string): Promise<string> {
    if (path.startsWith('/')) {
      return Promise.resolve(posix.normalize(path));
    }
    return this.run(async () => {
      const home = await this.ftp.pwd();
      return posix.join(home, path);
    }, path);
  }

  private async exists(path: string) {
    this.invalidate(path);
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }
}
