/**
 * File format used to export and import connections.
 *
 * Nothing here imports `vscode`, so it can be tested with plain Node.
 *
 * Secrets (password / key passphrase) are never written inside the
 * connection configs: depending on the export mode they are omitted, kept
 * in a separate plain-text map, or encrypted with AES-256-GCM using a key
 * derived from a user passphrase with scrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import type { ConnectionConfig } from './config';
import { SCHEMES, Scheme } from './remote';

export const FORMAT = 'remotefs-connections';
export const VERSION = 1;

export type SecretsMode = 'none' | 'plain' | 'encrypted';

export interface ConnectionSecrets {
  password?: string;
  passphrase?: string;
}

/** One connection to export: its config plus the secrets found in the keychain. */
export interface ExportEntry {
  name: string;
  config: ConnectionConfig;
  secrets: ConnectionSecrets;
}

interface EncryptedBlob {
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export interface ExportFile {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  secrets: SecretsMode;
  connections: Record<string, ConnectionConfig>;
  plainSecrets?: Record<string, ConnectionSecrets>;
  encryptedSecrets?: EncryptedBlob;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase, or the file has been modified.');
  }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Config keys accepted on import: anything else in the file is dropped. */
const CONFIG_KEYS: ReadonlyArray<keyof ConnectionConfig> = [
  'scheme', 'host', 'port', 'username', 'rootPath', 'connectTimeout', 'label', 'privateKeyPath',
  'passphrase', 'agent', 'interactiveAuth', 'algorithms', 'secure', 'rejectUnauthorized',
];

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
/** Upper bound of the scrypt cost accepted from a file, so a crafted file cannot exhaust memory. */
const MAX_SCRYPT_N = 1 << 20;

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    const maxmem = 256 * params.N * params.r + 1024 * 1024;
    scrypt(passphrase.normalize('NFC'), salt, 32, { ...params, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

async function encrypt(payload: unknown, passphrase: string): Promise<EncryptedBlob> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    kdf: 'scrypt',
    ...SCRYPT,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

async function decrypt(blob: EncryptedBlob, passphrase: string): Promise<unknown> {
  const { N, r, p } = blob;
  const valid = (n: unknown, max: number) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= max;
  if (blob.kdf !== 'scrypt' || !valid(N, MAX_SCRYPT_N) || (N & (N - 1)) !== 0 || !valid(r, 32) || !valid(p, 16)) {
    throw new Error('Unsupported encryption parameters.');
  }
  const key = await deriveKey(passphrase, Buffer.from(blob.salt, 'base64'), { N, r, p });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  let text: string;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new WrongPassphraseError();
  }
  return JSON.parse(text);
}

/**
 * Splits the legacy plain-text secrets out of a config: the returned config
 * never contains a password or a passphrase string (`passphrase: true`, i.e.
 * "prompt for it", is kept).
 */
export function splitSecrets(config: ConnectionConfig): { config: ConnectionConfig; secrets: ConnectionSecrets } {
  const { password, passphrase, ...rest } = config;
  const clean: ConnectionConfig = { ...rest };
  if (passphrase === true) {
    clean.passphrase = true;
  }
  const secrets: ConnectionSecrets = {};
  if (typeof password === 'string' && password) {
    secrets.password = password;
  }
  if (typeof passphrase === 'string' && passphrase) {
    secrets.passphrase = passphrase;
  }
  return { config: clean, secrets };
}

function hasSecrets(s: ConnectionSecrets | undefined) {
  return !!(s && (s.password || s.passphrase));
}

export async function buildExport(entries: ExportEntry[], mode: SecretsMode, passphrase?: string): Promise<ExportFile> {
  const file: ExportFile = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    secrets: mode,
    connections: {},
  };
  const secrets: Record<string, ConnectionSecrets> = {};
  for (const entry of entries) {
    const split = splitSecrets(entry.config);
    file.connections[entry.name] = split.config;
    const merged = { ...split.secrets, ...stripEmpty(entry.secrets) };
    if (hasSecrets(merged)) {
      secrets[entry.name] = merged;
    }
  }
  if (mode === 'plain') {
    file.plainSecrets = secrets;
  } else if (mode === 'encrypted') {
    if (!passphrase) {
      throw new Error('A passphrase is required to encrypt the secrets.');
    }
    file.encryptedSecrets = await encrypt(secrets, passphrase);
  }
  return file;
}

function stripEmpty(s: ConnectionSecrets): ConnectionSecrets {
  const out: ConnectionSecrets = {};
  if (typeof s.password === 'string' && s.password) {
    out.password = s.password;
  }
  if (typeof s.passphrase === 'string' && s.passphrase) {
    out.passphrase = s.passphrase;
  }
  return out;
}

function sanitizeConfig(raw: unknown): ConnectionConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      config[key] = source[key];
    }
  }
  const scheme = String(config.scheme ?? '').toLowerCase() as Scheme;
  if (!SCHEMES.includes(scheme) || typeof config.host !== 'string' || !config.host) {
    return undefined;
  }
  config.scheme = scheme;
  return config as unknown as ConnectionConfig;
}

export interface ParsedExport {
  mode: SecretsMode;
  /** Valid connections, with any plain-text secret moved to `secrets`. */
  entries: ExportEntry[];
  /** Names of the entries that were skipped because invalid. */
  invalid: string[];
  /** Present when the secrets are encrypted: call it with the passphrase to get them. */
  decryptSecrets?: (passphrase: string) => Promise<Record<string, ConnectionSecrets>>;
}

function sanitizeSecrets(raw: unknown): Record<string, ConnectionSecrets> {
  const out: Record<string, ConnectionSecrets> = {};
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object') {
      const s = stripEmpty(value as ConnectionSecrets);
      if (hasSecrets(s)) {
        out[name] = s;
      }
    }
  }
  return out;
}

/** Parses and validates the content of an export file. Throws if it is not one. */
export function parseExport(text: string): ParsedExport {
  let data: Partial<ExportFile>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || data.format !== FORMAT) {
    throw new Error('The file is not a Remote FS 2 connections export.');
  }
  if (typeof data.version !== 'number' || data.version > VERSION) {
    throw new Error('The file was created by a newer version of Remote FS 2: update the extension.');
  }
  const mode: SecretsMode = data.secrets === 'plain' || data.secrets === 'encrypted' ? data.secrets : 'none';
  const plain = mode === 'plain' ? sanitizeSecrets(data.plainSecrets) : {};

  const entries: ExportEntry[] = [];
  const invalid: string[] = [];
  for (const [name, raw] of Object.entries(data.connections ?? {})) {
    const config = sanitizeConfig(raw);
    if (!config || !NAME_PATTERN.test(name)) {
      invalid.push(name);
      continue;
    }
    const split = splitSecrets(config);
    entries.push({ name, config: split.config, secrets: { ...split.secrets, ...(plain[name] ?? {}) } });
  }

  const parsed: ParsedExport = { mode, entries, invalid };
  if (mode === 'encrypted') {
    const blob = data.encryptedSecrets;
    if (!blob || typeof blob !== 'object') {
      throw new Error('The encrypted secrets are missing from the file.');
    }
    parsed.decryptSecrets = async passphrase => sanitizeSecrets(await decrypt(blob, passphrase));
  }
  return parsed;
}
