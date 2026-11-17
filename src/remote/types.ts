/**
 * Protocol-agnostic contract between the VS Code file system provider and the
 * concrete SFTP / FTP clients. Nothing in `src/remote` imports `vscode`, so
 * the clients can be tested with plain Node.
 */

export type EntryKind = 'file' | 'dir' | 'unknown';

export interface RemoteStat {
  /** Kind of the entry, after following symbolic links. */
  kind: EntryKind;
  /** True when the entry itself is a symbolic link. */
  isSymlink: boolean;
  size: number;
  /** Milliseconds since epoch, 0 when unknown. */
  mtime: number;
}

export interface RemoteDirEntry extends RemoteStat {
  name: string;
}

export interface RemoteClient {
  /** True once the underlying connection is gone; the client must not be reused. */
  readonly closed: boolean;
  stat(path: string): Promise<RemoteStat>;
  readdir(path: string): Promise<RemoteDirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Renames `from` to `to`. When `overwrite` is true an existing `to` is replaced. */
  rename(from: string, to: string, overwrite: boolean): Promise<void>;
  /** Resolves a path relative to the login directory into an absolute one. */
  realpath(path: string): Promise<string>;
  close(): void;
  /** Registers a listener invoked once when the connection ends. */
  onClose(listener: () => void): void;
}

export type RemoteErrorCode =
  | 'ENOENT' // no such file
  | 'EACCES' // permission denied
  | 'EEXIST' // already exists
  | 'ECONN' // connection lost / not established
  | 'EAUTH' // authentication failed
  | 'ECANCELED' // user cancelled a prompt
  | 'EOTHER';

export class RemoteError extends Error {
  constructor(
    public readonly code: RemoteErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

/** Callbacks the clients use to interact with the user. */
export interface ClientInteraction {
  /** Ask for a secret / value. Resolve `undefined` when the user cancels. */
  prompt(message: string, secret: boolean): Promise<string | undefined>;
  /**
   * Decide whether to trust an SSH host key. `fingerprint` is `SHA256:<base64>`.
   * Resolve true to continue the connection.
   */
  verifyHostKey?(host: string, port: number, fingerprint: string): Promise<boolean>;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
