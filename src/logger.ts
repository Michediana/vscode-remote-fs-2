import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;
// Once the extension is deactivated the channel must not be recreated:
// late events (e.g. a connection's close handler) would otherwise call
// createOutputChannel on an already-disposed extension host store.
let disposed = false;

function get(): vscode.LogOutputChannel | undefined {
  if (!channel && !disposed) {
    channel = vscode.window.createOutputChannel('Remote FS 2', { log: true });
  }
  return channel;
}

const logger = {
  trace: (msg: string, ...args: unknown[]) => get()?.trace(msg, ...args),
  debug: (msg: string, ...args: unknown[]) => get()?.debug(msg, ...args),
  info: (msg: string, ...args: unknown[]) => get()?.info(msg, ...args),
  warn: (msg: string, ...args: unknown[]) => get()?.warn(msg, ...args),
  error: (msg: string | Error, ...args: unknown[]) => get()?.error(msg, ...args),
  show: () => get()?.show(),
  dispose: () => {
    disposed = true;
    channel?.dispose();
    channel = undefined;
  },
};

export default logger;
