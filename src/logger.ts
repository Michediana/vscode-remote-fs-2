import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

function get() {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Remote FS', { log: true });
  }
  return channel;
}

const logger = {
  trace: (msg: string, ...args: unknown[]) => get().trace(msg, ...args),
  debug: (msg: string, ...args: unknown[]) => get().debug(msg, ...args),
  info: (msg: string, ...args: unknown[]) => get().info(msg, ...args),
  warn: (msg: string, ...args: unknown[]) => get().warn(msg, ...args),
  error: (msg: string | Error, ...args: unknown[]) => get().error(msg, ...args),
  show: () => get().show(),
  dispose: () => {
    channel?.dispose();
    channel = undefined;
  },
};

export default logger;
