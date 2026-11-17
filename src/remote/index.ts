import { FtpClient } from './ftpClient';
import { SftpClient } from './sftpClient';
import { ClientInteraction, RemoteClient } from './types';

export * from './types';
export { expandHome } from './sftpClient';

export type Scheme = 'sftp' | 'ftp' | 'ftps';
export const SCHEMES: readonly Scheme[] = ['sftp', 'ftp', 'ftps'];

/** Fully resolved connection parameters (secrets included). */
export interface ResolvedConnection {
  scheme: Scheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
  connectTimeout: number;
  // sftp
  privateKeyPath?: string;
  passphrase?: string;
  agent?: string;
  interactiveAuth?: boolean;
  algorithms?: Record<string, unknown>;
  // ftp
  secure?: boolean | 'implicit';
  rejectUnauthorized?: boolean;
}

export function openClient(conn: ResolvedConnection, ui: ClientInteraction): Promise<RemoteClient> {
  if (conn.scheme === 'sftp') {
    return SftpClient.connect(
      {
        host: conn.host,
        port: conn.port,
        username: conn.username,
        password: conn.password,
        privateKeyPath: conn.privateKeyPath,
        passphrase: conn.passphrase,
        agent: conn.agent,
        interactiveAuth: conn.interactiveAuth,
        algorithms: conn.algorithms as never,
        connectTimeout: conn.connectTimeout,
      },
      ui
    );
  }
  return FtpClient.connect({
    host: conn.host,
    port: conn.port,
    username: conn.username,
    password: conn.password,
    secure: conn.scheme === 'ftps' ? (conn.secure === 'implicit' ? 'implicit' : true) : conn.secure ?? false,
    rejectUnauthorized: conn.rejectUnauthorized ?? true,
    connectTimeout: conn.connectTimeout,
  });
}

/** Recursively deletes a directory using only the primitive client operations. */
export async function removeRecursive(client: RemoteClient, path: string): Promise<void> {
  const entries = await client.readdir(path);
  for (const e of entries) {
    const child = path.endsWith('/') ? path + e.name : `${path}/${e.name}`;
    if (e.kind === 'dir' && !e.isSymlink) {
      await removeRecursive(client, child);
    } else {
      await client.unlink(child);
    }
  }
  await client.rmdir(path);
}
