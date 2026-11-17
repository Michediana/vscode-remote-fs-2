/**
 * Two-way, on-demand synchronisation between a local folder and a remote folder.
 *
 * The local folder is a plain directory on disk, so any tool (AI agents,
 * terminals, git, linters…) can work on it. Folders are downloaded lazily:
 * a remote folder that was never opened exists locally only as an empty
 * folder holding a placeholder file (PLACEHOLDER_NAME). It is downloaded
 * (one level: its files, plus placeholders for its sub-folders) when
 * `fetchDir` is called — by the editor when the folder is expanded, or by an
 * agent creating a trigger file (FETCH_TRIGGER / FETCH_ALL_TRIGGER) in it.
 *
 * Changes are propagated using a manifest that records, for every synced
 * file, the local and remote size/mtime observed right after the last
 * transfer: a side "changed" when its current signature differs from the
 * recorded one. When both sides changed the file is reported as a conflict
 * and never overwritten. Full syncs only re-list the folders already fetched.
 *
 * Nothing here imports `vscode`, so it can be tested with plain Node.
 */
import { promises as fsp, Stats, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { posix } from 'path';
import { SerialQueue } from '../remote/queue';
import { RemoteDirEntry, RemoteStat, errorMessage } from '../remote/types';
import { compileExcludes } from './glob';

/** File left in folders not downloaded yet. Local only, never uploaded. */
export const PLACEHOLDER_NAME = '_remotefs_not_downloaded.txt';
/** Created (by anyone) in a folder to download its files. Removed once done. */
export const FETCH_TRIGGER = '.remotefs-download';
/** Created in a folder to download it with all its sub-folders. */
export const FETCH_ALL_TRIGGER = '.remotefs-download-all';

const RESERVED = new Set([PLACEHOLDER_NAME, FETCH_TRIGGER, FETCH_ALL_TRIGGER]);

export const PLACEHOLDER_TEXT = `This folder exists on the server but has not been downloaded yet
(Remote FS local mirror: folders are downloaded on demand).

- In VS Code: expand the folder in the Explorer, it is downloaded automatically.
- From a terminal or an AI agent: create an empty file named "${FETCH_TRIGGER}"
  in this folder to download its files (sub-folders stay on demand), or
  "${FETCH_ALL_TRIGGER}" to download it with all its sub-folders, e.g.
      touch "path/to/folder/${FETCH_TRIGGER}"
  then wait until this file disappears (usually a few seconds).

Files created here are uploaded to the server normally.
This file is local only: it is never uploaded and is removed after the download.
`;

export interface Sig {
  size: number;
  mtime: number;
}

interface ManifestEntry {
  /** Local signature after the last sync. */
  l: Sig;
  /** Remote signature after the last sync. */
  r: Sig;
}

interface Manifest {
  version: 2;
  files: Record<string, ManifestEntry>;
  /** Folders downloaded at least once ('' = root). */
  dirs: string[];
}

/** Remote operations, with paths relative to the mirrored remote folder ('' = the folder itself). */
export interface RemoteSide {
  /** Resolves undefined when the path does not exist. */
  stat(rel: string): Promise<RemoteStat | undefined>;
  readdir(rel: string): Promise<RemoteDirEntry[]>;
  read(rel: string): Promise<Uint8Array>;
  write(rel: string, data: Uint8Array): Promise<void>;
  /** Creates one directory; must not fail when it already exists. */
  mkdir(rel: string): Promise<void>;
  unlink(rel: string): Promise<void>;
  rmdir(rel: string): Promise<void>;
}

export type ConflictKind = 'both-changed' | 'deleted-locally' | 'deleted-remotely';

export interface Conflict {
  rel: string;
  kind: ConflictKind;
}

export type SyncAction = 'upload' | 'download' | 'delete-remote' | 'delete-local';

export interface MirrorListener {
  onConflict?(conflict: Conflict): void;
  onBusyChange?(busy: boolean): void;
  onAction?(rel: string, action: SyncAction): void;
  /** A folder finished downloading. */
  onFetched?(rel: string): void;
  onError?(rel: string, err: unknown): void;
  log?(message: string): void;
  /** Asked before deleting many remote files at once. Resolve false to keep them. */
  confirmRemoteDeletes?(rels: string[]): Promise<boolean>;
}

export interface MirrorOptions {
  localRoot: string;
  remote: RemoteSide;
  /** JSON file where the sync state is kept (outside the local folder). */
  manifestPath: string;
  exclude?: readonly string[];
  /** Files larger than this (bytes) are not synced. 0 = no limit. */
  maxFileSize?: number;
  /** Delay before a local change is uploaded, to coalesce bursts of writes. */
  debounce?: number;
  /** Deleting this many remote files at once needs confirmRemoteDeletes. */
  deleteConfirmThreshold?: number;
  listener?: MirrorListener;
}

export interface SyncReport {
  uploaded: string[];
  downloaded: string[];
  deletedRemote: string[];
  deletedLocal: string[];
  conflicts: string[];
  /** Too large, type clashes, or deletions the user declined. */
  skipped: string[];
  errors: string[];
  unchanged: number;
}

export interface SyncOptions {
  onProgress?(done: number, total: number, rel: string): void;
  isCancelled?(): boolean;
}

export class CancelledError extends Error {
  constructor() {
    super('Sync cancelled');
  }
}

function localSig(st: Stats): Sig {
  return { size: st.size, mtime: Math.floor(st.mtimeMs) };
}

function sameLocal(a: Sig, b: Sig) {
  return a.size === b.size && a.mtime === b.mtime;
}

/** Remote mtimes can be unknown (0) on some FTP servers: then only the size is compared. */
function sameRemote(a: Sig, b: Sig) {
  return a.size === b.size && (a.mtime === b.mtime || a.mtime === 0 || b.mtime === 0);
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function isUnder(rel: string, dir: string) {
  return dir === '' || rel === dir || rel.startsWith(dir + '/');
}

function parentOf(rel: string) {
  const d = posix.dirname(rel);
  return d === '.' ? '' : d;
}

function emptyReport(): SyncReport {
  return { uploaded: [], downloaded: [], deletedRemote: [], deletedLocal: [], conflicts: [], skipped: [], errors: [], unchanged: 0 };
}

export class MirrorEngine {
  readonly localRoot: string;
  private readonly remote: RemoteSide;
  private readonly manifestPath: string;
  private readonly userExcluded: (rel: string) => boolean;
  private readonly maxFileSize: number;
  private readonly debounce: number;
  private readonly deleteThreshold: number;
  private readonly listener: MirrorListener;

  private manifest: Manifest;
  private fetched: Set<string>;
  private manifestDirty = false;
  private saveHandle?: NodeJS.Timeout;
  private readonly queue = new SerialQueue();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Folders known to exist on the server (no mkdir needed). */
  private readonly remoteDirs = new Set<string>(['']);
  private readonly fetchRequests = new Map<string, Promise<void>>();
  private readonly _conflicts = new Map<string, ConflictKind>();
  private running = 0;
  private wasBusy = false;
  private disposed = false;

  constructor(opts: MirrorOptions) {
    this.localRoot = path.resolve(opts.localRoot);
    this.remote = opts.remote;
    this.manifestPath = opts.manifestPath;
    this.userExcluded = compileExcludes(opts.exclude ?? []);
    this.maxFileSize = opts.maxFileSize ?? 0;
    this.debounce = opts.debounce ?? 300;
    this.deleteThreshold = opts.deleteConfirmThreshold ?? 10;
    this.listener = opts.listener ?? {};
    this.manifest = this.loadManifest();
    this.fetched = new Set(this.manifest.dirs);
  }

  // ---------------------------------------------------------------- state

  get busy() {
    return this.running > 0 || this.timers.size > 0;
  }

  get conflicts(): Conflict[] {
    return [...this._conflicts].map(([rel, kind]) => ({ rel, kind }));
  }

  /** True when the root folder was downloaded at least once. */
  get initialized() {
    return this.manifest.dirs.length > 0;
  }

  isFetched(rel: string) {
    return this.fetched.has(rel);
  }

  /** Excluded by the user settings, or one of the mirror's own marker files. */
  isExcluded(rel: string) {
    return RESERVED.has(posix.basename(rel)) || this.userExcluded(rel);
  }

  localPath(rel: string) {
    return rel ? path.join(this.localRoot, ...rel.split('/')) : this.localRoot;
  }

  /** Converts an absolute local path to a mirror-relative one ('' = root), or undefined when outside. */
  relativeOf(fsPath: string): string | undefined {
    const rel = path.relative(this.localRoot, fsPath);
    if (rel === '') {
      return '';
    }
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return undefined;
    }
    return rel.split(path.sep).join('/');
  }

  private loadManifest(): Manifest {
    try {
      const data = JSON.parse(readFileSync(this.manifestPath, 'utf8'));
      if (data?.version === 2 && data.files && typeof data.files === 'object' && Array.isArray(data.dirs)) {
        return data;
      }
    } catch {
      // missing or corrupt: start fresh
    }
    return { version: 2, files: {}, dirs: [] };
  }

  private markDirty() {
    this.manifestDirty = true;
    if (!this.saveHandle && !this.disposed) {
      this.saveHandle = setTimeout(() => this.flush(), 1000);
    }
  }

  /** Writes the manifest to disk now. */
  flush() {
    clearTimeout(this.saveHandle);
    this.saveHandle = undefined;
    if (!this.manifestDirty) {
      return;
    }
    this.manifest.dirs = [...this.fetched].sort();
    mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest));
    this.manifestDirty = false;
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.flush();
  }

  private record(rel: string, l: Sig, r: Sig) {
    this.manifest.files[rel] = { l, r };
    this._conflicts.delete(rel);
    this.markDirty();
  }

  private forget(rel: string) {
    if (this.manifest.files[rel]) {
      delete this.manifest.files[rel];
      this.markDirty();
    }
    this._conflicts.delete(rel);
  }

  private setFetched(rel: string, value: boolean) {
    if (value === this.fetched.has(rel)) {
      return;
    }
    if (value) {
      this.fetched.add(rel);
    } else {
      for (const d of [...this.fetched]) {
        if (isUnder(d, rel)) {
          this.fetched.delete(d);
        }
      }
    }
    this.markDirty();
  }

  private conflict(rel: string, kind: ConflictKind) {
    const known = this._conflicts.get(rel) === kind;
    this._conflicts.set(rel, kind);
    if (!known) {
      this.listener.log?.(`Conflict (${kind}): ${rel}`);
      this.listener.onConflict?.({ rel, kind });
    }
  }

  private updateBusy() {
    const busy = this.busy;
    if (busy !== this.wasBusy) {
      this.wasBusy = busy;
      this.listener.onBusyChange?.(busy);
    }
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    this.running++;
    this.updateBusy();
    return this.queue.add(task).finally(() => {
      this.running--;
      this.updateBusy();
    });
  }

  // ---------------------------------------------------------------- primitives

  private async localStat(rel: string): Promise<Stats | undefined> {
    try {
      return await fsp.stat(this.localPath(rel));
    } catch {
      return undefined;
    }
  }

  private async ensureRemoteDir(relDir: string) {
    if (relDir === '' || this.remoteDirs.has(relDir)) {
      return;
    }
    await this.ensureRemoteDir(parentOf(relDir));
    await this.remote.mkdir(relDir);
    this.remoteDirs.add(relDir);
  }

  private async upload(rel: string, sig: Sig) {
    const data = await fsp.readFile(this.localPath(rel));
    await this.ensureRemoteDir(parentOf(rel));
    await this.remote.write(rel, data);
    const r = await this.remote.stat(rel);
    // the signature taken *before* reading: if the file changed meanwhile, the next event uploads it again
    this.record(rel, sig, { size: r?.size ?? data.length, mtime: r?.mtime ?? 0 });
    this.listener.onAction?.(rel, 'upload');
  }

  private async download(rel: string, remoteSig?: Sig) {
    const data = await this.remote.read(rel);
    const abs = this.localPath(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
    const st = await fsp.stat(abs);
    const r = remoteSig ?? (await this.remote.stat(rel)) ?? { size: data.length, mtime: 0 };
    this.record(rel, localSig(st), { size: r.size, mtime: r.mtime });
    this.listener.onAction?.(rel, 'download');
  }

  private async deleteRemote(rel: string) {
    try {
      await this.remote.unlink(rel);
    } catch (err) {
      if (await this.remote.stat(rel)) {
        throw err;
      }
    }
    this.forget(rel);
    this.listener.onAction?.(rel, 'delete-remote');
  }

  private async deleteLocal(rel: string) {
    await fsp.rm(this.localPath(rel), { force: true });
    this.forget(rel);
    this.listener.onAction?.(rel, 'delete-local');
  }

  /** Both sides exist and nothing is recorded: equal content is adopted, different content is a conflict. */
  private async adoptOrConflict(rel: string, l: Sig, r: Sig) {
    if (l.size === r.size) {
      const [a, b] = await Promise.all([fsp.readFile(this.localPath(rel)), this.remote.read(rel)]);
      if (sameBytes(a, b)) {
        this.record(rel, l, r);
        return;
      }
    }
    this.conflict(rel, 'both-changed');
  }

  private tooBig(size: number) {
    return this.maxFileSize > 0 && size > this.maxFileSize;
  }

  private async writePlaceholder(rel: string) {
    const dir = this.localPath(rel);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, PLACEHOLDER_NAME);
    try {
      await fsp.writeFile(file, PLACEHOLDER_TEXT, { flag: 'wx' });
    } catch {
      // already there
    }
  }

  private async removeMarkers(rel: string) {
    for (const name of RESERVED) {
      await fsp.rm(path.join(this.localPath(rel), name), { force: true }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- live local changes

  /**
   * Notifies that something changed on disk at `fsPath` (file or folder,
   * created, modified or deleted). The change is uploaded after a short delay.
   */
  localChanged(fsPath: string) {
    const rel = this.relativeOf(fsPath);
    if (!rel || this.disposed) {
      return;
    }
    const name = posix.basename(rel);
    if (name === FETCH_TRIGGER || name === FETCH_ALL_TRIGGER) {
      // only creation matters: the trigger is removed once the folder is downloaded
      if (existsSync(fsPath)) {
        this.requestFetch(parentOf(rel), name === FETCH_ALL_TRIGGER);
      }
      return;
    }
    if (this.isExcluded(rel)) {
      return;
    }
    clearTimeout(this.timers.get(rel));
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        this.run(() => this.syncPath(rel)).catch(err => {
          this.listener.log?.(`Sync of ${rel} failed: ${errorMessage(err)}`);
          this.listener.onError?.(rel, err);
        });
      }, this.debounce)
    );
    this.updateBusy();
  }

  private async syncPath(rel: string) {
    const st = await this.localStat(rel);
    if (!st) {
      return this.localDeleted(rel);
    }
    if (st.isDirectory()) {
      if (!this.remoteDirs.has(rel) && !(await this.remote.stat(rel))) {
        // a folder created locally: nothing to download for it
        await this.ensureRemoteDir(rel);
        this.setFetched(rel, true);
      }
      const files = new Map<string, Sig>();
      await this.walkLocal(rel, files);
      for (const [fileRel, sig] of files) {
        await this.syncLocalFile(fileRel, sig);
      }
      return;
    }
    if (st.isFile()) {
      await this.syncLocalFile(rel, localSig(st));
    }
  }

  private async syncLocalFile(rel: string, l: Sig) {
    const m = this.manifest.files[rel];
    if (m && sameLocal(m.l, l)) {
      return; // our own download, or a touch without changes
    }
    if (this._conflicts.has(rel)) {
      return; // waiting for the user to resolve it
    }
    if (this.tooBig(l.size)) {
      this.listener.log?.(`Skipped ${rel}: larger than the size limit`);
      return;
    }
    const r = await this.remote.stat(rel);
    if (r && r.kind === 'dir') {
      this.conflict(rel, 'both-changed');
      return;
    }
    if (m) {
      if (r && !sameRemote(r, m.r)) {
        return this.conflict(rel, 'both-changed');
      }
      return this.upload(rel, l);
    }
    if (r) {
      return this.adoptOrConflict(rel, l, r);
    }
    return this.upload(rel, l);
  }

  private async localDeleted(rel: string) {
    const targets: string[] = [];
    for (const key of Object.keys(this.manifest.files)) {
      if (isUnder(key, rel) && !(await this.localStat(key))) {
        targets.push(key);
      }
    }
    const wasFetchedDir = this.fetched.has(rel);
    if (targets.length >= this.deleteThreshold && this.listener.confirmRemoteDeletes) {
      if (!(await this.listener.confirmRemoteDeletes(targets))) {
        this.listener.log?.(`Kept ${targets.length} remote file(s) under ${rel} (deletion not confirmed)`);
        // they come back on the next sync
        targets.forEach(t => this.forget(t));
        return;
      }
    }
    for (const t of targets) {
      await this.deleteRemoteChecked(t);
    }
    if (!wasFetchedDir && !targets.length && !this.manifest.files[rel]) {
      // an unopened folder (or unknown path) deleted locally: the server copy is
      // not known well enough to delete it; it comes back as a placeholder
      this.setFetched(rel, false);
      return;
    }
    // remove remote folders that are now empty (rmdir fails on non-empty ones)
    const dirs = new Set<string>();
    if (wasFetchedDir) {
      dirs.add(rel);
    }
    for (const t of targets) {
      for (let d = parentOf(t); d !== '' && isUnder(d, rel); d = parentOf(d)) {
        dirs.add(d);
      }
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      try {
        await this.remote.rmdir(d);
        this.remoteDirs.delete(d);
        this.setFetched(d, false);
      } catch {
        // not empty (e.g. unopened sub-folders or excluded files), or already gone
      }
    }
  }

  private async deleteRemoteChecked(rel: string) {
    const m = this.manifest.files[rel];
    const r = await this.remote.stat(rel);
    if (!r) {
      this.forget(rel);
      return;
    }
    if (m && !sameRemote(r, m.r)) {
      this.conflict(rel, 'deleted-locally');
      return;
    }
    await this.deleteRemote(rel);
  }

  // ---------------------------------------------------------------- reconciliation

  private async walkLocal(relDir: string, out: Map<string, Sig>, dirs?: Set<string>, depth = Infinity) {
    let entries;
    try {
      entries = await fsp.readdir(this.localPath(relDir), { withFileTypes: true });
    } catch (err) {
      if (relDir === '') {
        throw err;
      }
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (this.isExcluded(rel)) {
        continue;
      }
      let st: Stats;
      try {
        st = await fsp.stat(this.localPath(rel));
      } catch {
        continue; // dangling symlink
      }
      if (st.isDirectory()) {
        if (e.isSymbolicLink()) {
          continue; // avoid cycles
        }
        dirs?.add(rel);
        if (depth > 1) {
          await this.walkLocal(rel, out, dirs, depth - 1);
        }
      } else if (st.isFile()) {
        out.set(rel, localSig(st));
      }
    }
  }

  /**
   * Reconciles the given folders with the server:
   * - `listDirs` are listed on the server (one level each); their sub-folders
   *   that were never fetched get a placeholder locally;
   * - `candidates` decides which local / recorded files are examined.
   * Local files whose folder is not listed are checked with an individual stat,
   * so a file is never uploaded over an unknown server copy.
   */
  private async reconcile(
    listDirs: string[],
    localScope: { dir: string; depth: number },
    report: SyncReport,
    opts: SyncOptions
  ) {
    const remoteFiles = new Map<string, Sig>();
    const remoteSubdirs = new Set<string>();
    const listed = new Set<string>();
    const gone: string[] = [];
    for (const dir of listDirs) {
      if (opts.isCancelled?.()) {
        throw new CancelledError();
      }
      let entries: RemoteDirEntry[];
      try {
        entries = await this.remote.readdir(dir);
      } catch (err) {
        // a partial listing must never look like deletions: only a confirmed absence counts
        if (dir !== '' && !(await this.remote.stat(dir))) {
          entries = [];
          gone.push(dir);
          this.setFetched(dir, false);
        } else {
          throw err;
        }
      }
      listed.add(dir);
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (this.isExcluded(rel)) {
          continue;
        }
        if (e.kind === 'dir') {
          if (e.isSymlink) {
            this.listener.log?.(`Skipped ${rel}: symbolic link to a folder`);
            continue;
          }
          remoteSubdirs.add(rel);
          this.remoteDirs.add(rel);
        } else if (e.kind === 'file') {
          if (this.tooBig(e.size)) {
            report.skipped.push(rel);
            continue;
          }
          remoteFiles.set(rel, { size: e.size, mtime: e.mtime });
        }
      }
    }

    const localFiles = new Map<string, Sig>();
    const localDirs = new Set<string>();
    await this.walkLocal(localScope.dir, localFiles, localDirs, localScope.depth);

    // folders not opened yet: an empty folder with a placeholder
    for (const d of remoteSubdirs) {
      if (localFiles.has(d)) {
        report.skipped.push(d);
      } else if (!this.fetched.has(d)) {
        await this.writePlaceholder(d);
      }
    }

    const inScope = (rel: string) =>
      isUnder(rel, localScope.dir) &&
      (localScope.depth === Infinity || rel.slice(localScope.dir ? localScope.dir.length + 1 : 0).split('/').length <= localScope.depth);
    const tooBigRemote = new Set(report.skipped);
    const paths = new Set<string>(remoteFiles.keys());
    localFiles.forEach((_, rel) => paths.add(rel));
    for (const rel of Object.keys(this.manifest.files)) {
      if (inScope(rel)) {
        paths.add(rel);
      }
    }

    type Plan = { rel: string; action: SyncAction | 'compare' | 'forget' | 'check-local'; r?: Sig };
    const plan: Plan[] = [];
    for (const rel of [...paths].sort()) {
      if (this.isExcluded(rel) || (tooBigRemote.has(rel) && localFiles.has(rel))) {
        continue;
      }
      const l = localFiles.get(rel);
      const m = this.manifest.files[rel];
      if (!listed.has(parentOf(rel))) {
        // folder not listed (never opened, or outside the listed scope)
        if (l && !(m && sameLocal(m.l, l))) {
          plan.push({ rel, action: 'check-local' });
        } else if (!l && m) {
          plan.push({ rel, action: 'forget' });
        }
        continue;
      }
      const r = remoteFiles.get(rel);
      if (!m) {
        if (l && r) {
          plan.push({ rel, action: 'compare', r });
        } else if (l) {
          if (remoteSubdirs.has(rel) || this.tooBig(l.size)) {
            report.skipped.push(rel);
          } else {
            plan.push({ rel, action: 'upload' });
          }
        } else if (r) {
          if (localDirs.has(rel)) {
            report.skipped.push(rel);
          } else {
            plan.push({ rel, action: 'download', r });
          }
        }
        continue;
      }
      const lChanged = !l || !sameLocal(l, m.l);
      const rChanged = !r || !sameRemote(r, m.r);
      if (!lChanged && !rChanged) {
        report.unchanged++;
        this._conflicts.delete(rel);
      } else if (lChanged && !rChanged) {
        plan.push({ rel, action: l ? 'upload' : 'delete-remote' });
      } else if (!lChanged && rChanged) {
        plan.push({ rel, action: r ? 'download' : 'delete-local', r });
      } else if (!l && !r) {
        plan.push({ rel, action: 'forget' });
      } else if (l && r) {
        plan.push({ rel, action: 'compare', r });
      } else {
        this.conflict(rel, l ? 'deleted-remotely' : 'deleted-locally');
        report.conflicts.push(rel);
      }
    }

    const remoteDeletes = plan.filter(p => p.action === 'delete-remote').map(p => p.rel);
    if (remoteDeletes.length >= this.deleteThreshold && this.listener.confirmRemoteDeletes) {
      if (!(await this.listener.confirmRemoteDeletes(remoteDeletes))) {
        // restore the files locally instead of deleting them on the server
        for (const p of plan) {
          if (p.action === 'delete-remote') {
            p.action = 'download';
          }
        }
      }
    }

    let done = 0;
    for (const p of plan) {
      const { rel } = p;
      if (opts.isCancelled?.()) {
        this.flush();
        throw new CancelledError();
      }
      opts.onProgress?.(done++, plan.length, rel);
      try {
        switch (p.action) {
          case 'upload':
            await this.upload(rel, localFiles.get(rel)!);
            report.uploaded.push(rel);
            break;
          case 'download':
            await this.download(rel, p.r);
            report.downloaded.push(rel);
            break;
          case 'delete-remote':
            await this.deleteRemote(rel);
            report.deletedRemote.push(rel);
            break;
          case 'delete-local':
            await this.deleteLocal(rel);
            report.deletedLocal.push(rel);
            break;
          case 'forget':
            this.forget(rel);
            break;
          case 'compare':
            await this.adoptOrConflict(rel, localFiles.get(rel)!, p.r!);
            if (this._conflicts.has(rel)) {
              report.conflicts.push(rel);
            } else {
              report.unchanged++;
            }
            break;
          case 'check-local': {
            const before = this.manifest.files[rel];
            await this.syncLocalFile(rel, localFiles.get(rel)!);
            if (this._conflicts.has(rel)) {
              report.conflicts.push(rel);
            } else if (this.manifest.files[rel] !== before) {
              report.uploaded.push(rel);
            }
            break;
          }
        }
      } catch (err) {
        report.errors.push(`${rel}: ${errorMessage(err)}`);
        this.listener.log?.(`${p.action} ${rel} failed: ${errorMessage(err)}`);
      }
    }
    opts.onProgress?.(plan.length, plan.length, '');
    // folders deleted on the server: remove the local ones left empty
    for (const d of gone.sort((a, b) => b.length - a.length)) {
      await this.removeMarkers(d);
      await fsp.rmdir(this.localPath(d)).catch(() => undefined);
    }
    return { remoteSubdirs };
  }

  private async ensureLocalRoot() {
    if (!(await this.localStat(''))) {
      if (this.initialized) {
        // never treat a missing/unmounted folder as "everything was deleted"
        throw new Error(`Local folder ${this.localRoot} is missing`);
      }
      await fsp.mkdir(this.localRoot, { recursive: true });
    }
  }

  /**
   * Downloads one folder on demand: its files, and placeholders for its
   * sub-folders (or the whole sub-tree when `recursive`). Concurrent requests
   * for the same folder share the same download.
   */
  requestFetch(rel: string, recursive = false): Promise<void> {
    const key = `${recursive ? '*' : ''}${rel}`;
    let pending = this.fetchRequests.get(key);
    if (!pending) {
      pending = this.fetchDir(rel, { recursive })
        .then(report => {
          if (report.errors.length) {
            this.listener.onError?.(rel, new Error(report.errors[0]));
          }
        })
        .catch(err => {
          this.listener.log?.(`Download of ${rel || '/'} failed: ${errorMessage(err)}`);
          this.listener.onError?.(rel, err);
        })
        .finally(() => this.fetchRequests.delete(key));
      this.fetchRequests.set(key, pending);
    }
    return pending;
  }

  fetchDir(rel: string, opts: SyncOptions & { recursive?: boolean } = {}): Promise<SyncReport> {
    return this.run(async () => {
      await this.ensureLocalRoot();
      const report = emptyReport();
      const queue = [rel];
      while (queue.length) {
        const dir = queue.shift()!;
        if (this.isExcluded(dir) && dir !== '') {
          continue;
        }
        const { remoteSubdirs } = await this.reconcile([dir], { dir, depth: 1 }, report, opts);
        this.setFetched(dir, true);
        await this.removeMarkers(dir);
        this.listener.onFetched?.(dir);
        if (opts.recursive) {
          queue.push(...[...remoteSubdirs].sort());
        }
      }
      this.flush();
      return report;
    });
  }

  /**
   * Full two-way reconciliation of the folders already downloaded: downloads
   * what changed remotely, uploads what changed locally (also while the editor
   * was closed), propagates deletions and reports conflicts. Folders never
   * opened are not listed. On a new mirror this downloads the root folder.
   */
  syncAll(opts: SyncOptions = {}): Promise<SyncReport> {
    return this.run(async () => {
      await this.ensureLocalRoot();
      if (!this.fetched.size) {
        this.setFetched('', true);
      }
      const report = emptyReport();
      await this.reconcile([...this.fetched].sort(), { dir: '', depth: Infinity }, report, opts);
      this.flush();
      return report;
    });
  }

  // ---------------------------------------------------------------- conflicts

  /**
   * Resolves a conflict: 'local' makes the server match the local file (upload
   * or delete), 'remote' makes the local file match the server.
   */
  resolve(rel: string, keep: 'local' | 'remote'): Promise<void> {
    return this.run(async () => {
      const st = await this.localStat(rel);
      const r = await this.remote.stat(rel);
      this._conflicts.delete(rel);
      if (keep === 'local') {
        if (st?.isFile()) {
          await this.upload(rel, localSig(st));
        } else if (r) {
          await this.deleteRemote(rel);
        } else {
          this.forget(rel);
        }
      } else if (r && r.kind === 'file') {
        await this.download(rel, r);
      } else if (st?.isFile()) {
        await this.deleteLocal(rel);
      } else {
        this.forget(rel);
      }
    });
  }

  /** Waits until every pending change has been processed. */
  async idle(): Promise<void> {
    while (this.busy || this.fetchRequests.size) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
