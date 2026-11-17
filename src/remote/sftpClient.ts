import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import { posix } from 'path';
import { Client, ConnectConfig, SFTPWrapper, Stats } from 'ssh2';
import {
  ClientInteraction,
  EntryKind,
  RemoteClient,
  RemoteDirEntry,
  RemoteError,
  RemoteStat,
  errorMessage,
} from './types';

export interface SftpOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  agent?: string;
  interactiveAuth?: boolean;
  algorithms?: ConnectConfig['algorithms'];
  /** Milliseconds; time spent waiting for the user is not counted. */
  connectTimeout: number;
}

// SFTP status codes (draft-ietf-secsh-filexfer-02)
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function kindOfMode(mode: number): EntryKind {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir';
    case S_IFREG:
      return 'file';
    default:
      return 'unknown';
  }
}

function isLink(mode: number) {
  return (mode & S_IFMT) === S_IFLNK;
}

export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return os.homedir() + p.slice(1);
  }
  return p;
}

function expandEnv(p: string): string {
  return p.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => process.env[name] ?? m);
}

function toRemoteError(err: unknown, path?: string): RemoteError {
  if (err instanceof RemoteError) {
    return err;
  }
  const code = (err as { code?: unknown })?.code;
  const where = path ? `${path}: ` : '';
  if (code === SFTP_NO_SUCH_FILE) {
    return new RemoteError('ENOENT', `${where}no such file or directory`, err);
  }
  if (code === SFTP_PERMISSION_DENIED) {
    return new RemoteError('EACCES', `${where}permission denied`, err);
  }
  const msg = errorMessage(err);
  if (/no response|not connected|channel|closed|ECONNRESET|EPIPE/i.test(msg)) {
    return new RemoteError('ECONN', `${where}${msg}`, err);
  }
  return new RemoteError('EOTHER', `${where}${msg}`, err);
}

/** A timer that can be paused while the user answers a prompt. */
class Deadline {
  private handle?: NodeJS.Timeout;
  constructor(private readonly ms: number, private readonly onExpire: () => void) {}
  start() {
    this.stop();
    if (this.ms > 0) {
      this.handle = setTimeout(this.onExpire, this.ms);
    }
  }
  stop() {
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
  async pauseWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.stop();
    try {
      return await fn();
    } finally {
      this.start();
    }
  }
}

export class SftpClient implements RemoteClient {
  private _closed = false;
  private readonly closeListeners: Array<() => void> = [];

  private constructor(private readonly ssh: Client, private readonly sftp: SFTPWrapper) {
    const onEnd = () => {
      if (this._closed) {
        return;
      }
      this._closed = true;
      for (const l of this.closeListeners.splice(0)) {
        l();
      }
    };
    ssh.on('close', onEnd);
    ssh.on('end', onEnd);
    sftp.on('close', onEnd);
  }

  static async connect(opts: SftpOptions, ui: ClientInteraction): Promise<SftpClient> {
    const config: ConnectConfig = {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      passphrase: opts.passphrase,
      tryKeyboard: !!opts.interactiveAuth,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
      readyTimeout: 0, // replaced by our pausable deadline
      algorithms: opts.algorithms,
    };

    if (opts.privateKeyPath) {
      const keyPath = expandHome(expandEnv(opts.privateKeyPath));
      try {
        config.privateKey = await fs.readFile(keyPath);
      } catch (err) {
        throw new RemoteError('EAUTH', `Cannot read private key ${keyPath}: ${errorMessage(err)}`, err);
      }
    }
    if (opts.agent) {
      const agent = expandEnv(opts.agent);
      if (agent && !agent.startsWith('$')) {
        config.agent = agent;
      }
    }

    const ssh = new Client();

    return new Promise<SftpClient>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        deadline.stop();
        ssh.end();
        const msg = errorMessage(err);
        if (err instanceof RemoteError) {
          reject(err);
        } else if (/authentication methods failed|auth/i.test(msg)) {
          reject(new RemoteError('EAUTH', `Authentication failed for ${opts.username ?? ''}@${opts.host}`, err));
        } else {
          reject(new RemoteError('ECONN', `Cannot connect to ${opts.host}:${opts.port}: ${msg}`, err));
        }
      };

      const deadline = new Deadline(opts.connectTimeout, () =>
        fail(new RemoteError('ECONN', `Timed out connecting to ${opts.host}:${opts.port}`))
      );

      if (ui.verifyHostKey) {
        const verifyHostKey = ui.verifyHostKey;
        config.hostVerifier = (key: Buffer, verify: (ok: boolean) => void) => {
          const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          deadline
            .pauseWhile(() => verifyHostKey(opts.host, opts.port, fingerprint))
            .then(ok => {
              if (!ok) {
                fail(new RemoteError('ECANCELED', `Host key for ${opts.host} was not trusted`));
              }
              verify(ok);
            })
            .catch(err => {
              fail(err);
              verify(false);
            });
        };
      }

      ssh.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        (async () => {
          const answers: string[] = [];
          for (const p of prompts) {
            if (opts.password && /password/i.test(p.prompt)) {
              answers.push(opts.password);
              continue;
            }
            const answer = await deadline.pauseWhile(() => ui.prompt(p.prompt.trim(), !p.echo));
            if (answer === undefined) {
              fail(new RemoteError('ECANCELED', 'Authentication cancelled'));
              return;
            }
            answers.push(answer);
          }
          finish(answers);
        })().catch(fail);
      });

      ssh.on('ready', () => {
        ssh.sftp((err, sftp) => {
          if (err) {
            fail(err);
            return;
          }
          if (settled) {
            ssh.end();
            return;
          }
          settled = true;
          deadline.stop();
          resolve(new SftpClient(ssh, sftp));
        });
      });
      ssh.on('error', fail);
      ssh.on('close', () => fail(new RemoteError('ECONN', `Connection to ${opts.host} closed`)));

      deadline.start();
      try {
        ssh.connect(config);
      } catch (err) {
        fail(err);
      }
    });
  }

  get closed() {
    return this._closed;
  }

  onClose(listener: () => void) {
    if (this._closed) {
      listener();
    } else {
      this.closeListeners.push(listener);
    }
  }

  close() {
    this.ssh.end();
  }

  private call<T>(path: string, fn: (cb: (err: Error | null | undefined, res?: T) => void) => void): Promise<T> {
    if (this._closed) {
      return Promise.reject(new RemoteError('ECONN', 'Not connected'));
    }
    return new Promise<T>((resolve, reject) => {
      try {
        fn((err, res) => (err ? reject(toRemoteError(err, path)) : resolve(res as T)));
      } catch (err) {
        reject(toRemoteError(err, path));
      }
    });
  }

  private async lstatRaw(path: string): Promise<Stats> {
    return this.call<Stats>(path, cb => this.sftp.lstat(path, cb));
  }

  private async statRaw(path: string): Promise<Stats> {
    return this.call<Stats>(path, cb => this.sftp.stat(path, cb));
  }

  private toStat(attrs: Stats, isSymlink: boolean): RemoteStat {
    return {
      kind: kindOfMode(attrs.mode),
      isSymlink,
      size: Number(attrs.size) || 0,
      mtime: (Number(attrs.mtime) || 0) * 1000,
    };
  }

  private async resolveLink(path: string, linkAttrs: Stats): Promise<RemoteStat> {
    try {
      return this.toStat(await this.statRaw(path), true);
    } catch {
      // dangling link
      return { ...this.toStat(linkAttrs, true), kind: 'unknown' };
    }
  }

  async stat(path: string): Promise<RemoteStat> {
    const attrs = await this.lstatRaw(path);
    if (isLink(attrs.mode)) {
      return this.resolveLink(path, attrs);
    }
    return this.toStat(attrs, false);
  }

  async readdir(path: string): Promise<RemoteDirEntry[]> {
    const list = await this.call<Array<{ filename: string; attrs: Stats }>>(path, cb =>
      this.sftp.readdir(path, cb)
    );
    return Promise.all(
      list
        .filter(e => e.filename !== '.' && e.filename !== '..')
        .map(async e => {
          const st = isLink(e.attrs.mode)
            ? await this.resolveLink(posix.join(path, e.filename), e.attrs)
            : this.toStat(e.attrs, false);
          return { name: e.filename, ...st };
        })
    );
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.call<Buffer>(path, cb => this.sftp.readFile(path, cb));
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    // keep the permissions of an existing file
    let mode = 0o644;
    try {
      mode = (await this.statRaw(path)).mode & 0o7777;
    } catch {
      // new file
    }
    await this.call<void>(path, cb => {
      const stream = this.sftp.createWriteStream(path, { mode });
      let done = false;
      const finish = (err?: Error | null) => {
        if (!done) {
          done = true;
          cb(err);
        }
      };
      stream.on('error', finish);
      stream.on('close', () => finish());
      stream.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    });
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.call<void>(path, cb => this.sftp.mkdir(path, cb));
    } catch (err) {
      // SFTP v3 reports "already exists" as a generic FAILURE
      if ((err as RemoteError).code === 'EOTHER' && (await this.exists(path))) {
        throw new RemoteError('EEXIST', `${path}: already exists`, err);
      }
      throw err;
    }
  }

  rmdir(path: string): Promise<void> {
    return this.call<void>(path, cb => this.sftp.rmdir(path, cb));
  }

  unlink(path: string): Promise<void> {
    return this.call<void>(path, cb => this.sftp.unlink(path, cb));
  }

  async rename(from: string, to: string, overwrite: boolean): Promise<void> {
    if (overwrite) {
      try {
        // atomic replace when the server supports it (OpenSSH does)
        await this.call<void>(from, cb => this.sftp.ext_openssh_rename(from, to, cb));
        return;
      } catch (err) {
        if (!/does not support/i.test(errorMessage(err))) {
          throw err;
        }
      }
      if (await this.exists(to)) {
        await this.unlink(to);
      }
    }
    await this.call<void>(from, cb => this.sftp.rename(from, to, cb));
  }

  realpath(path: string): Promise<string> {
    return this.call<string>(path, cb => this.sftp.realpath(path, cb));
  }

  private async exists(path: string) {
    try {
      await this.lstatRaw(path);
      return true;
    } catch {
      return false;
    }
  }
}
