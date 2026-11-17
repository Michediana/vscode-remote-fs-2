import * as vscode from 'vscode';
import { RemoteError, errorMessage } from './remote';

/** What happened on one connection since the extension started. */
export interface ConnectionActivity {
  /** Operations running or waiting for the connection right now. */
  inflight: number;
  /** Operations completed (successfully or not). */
  ops: number;
  /** Bytes read from the server. */
  down: number;
  /** Bytes written to the server. */
  up: number;
  lastOp?: string;
  lastAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}

/** Errors that are part of normal use (VS Code probes for files that may not exist). */
function isExpected(err: unknown) {
  if (err instanceof RemoteError) {
    return err.code === 'ENOENT' || err.code === 'EEXIST';
  }
  return err instanceof vscode.FileSystemError && (err.code === 'FileNotFound' || err.code === 'FileExists');
}

/** Counts the operations made on each connection, for the status bar. */
export class ActivityTracker implements vscode.Disposable {
  private readonly byId = new Map<string, ConnectionActivity>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fired at most every 150 ms. */
  readonly onDidChange = this._onDidChange.event;
  private fireHandle?: NodeJS.Timeout;

  dispose() {
    clearTimeout(this.fireHandle);
    this._onDidChange.dispose();
  }

  private changed() {
    if (!this.fireHandle) {
      this.fireHandle = setTimeout(() => {
        this.fireHandle = undefined;
        this._onDidChange.fire();
      }, 150);
    }
  }

  get(id: string): ConnectionActivity {
    let a = this.byId.get(id);
    if (!a) {
      a = { inflight: 0, ops: 0, down: 0, up: 0 };
      this.byId.set(id, a);
    }
    return a;
  }

  /** Records the start of an operation; call the returned function when it ends. */
  begin(id: string, label: string, upBytes = 0): (result?: unknown, err?: unknown) => void {
    const a = this.get(id);
    a.inflight++;
    a.lastOp = label;
    a.lastAt = Date.now();
    this.changed();
    let ended = false;
    return (result, err) => {
      if (ended) {
        return;
      }
      ended = true;
      a.inflight = Math.max(0, a.inflight - 1);
      a.ops++;
      a.lastAt = Date.now();
      if (err !== undefined) {
        if (!isExpected(err)) {
          a.lastError = `${label}: ${errorMessage(err)}`;
          a.lastErrorAt = Date.now();
        }
      } else {
        a.up += upBytes;
        if (result instanceof Uint8Array) {
          a.down += result.byteLength;
        }
      }
      this.changed();
    };
  }

  clearError(id: string) {
    const a = this.byId.get(id);
    if (a?.lastError) {
      a.lastError = undefined;
      a.lastErrorAt = undefined;
      this.changed();
    }
  }

  reset(id: string) {
    if (this.byId.delete(id)) {
      this.changed();
    }
  }
}
