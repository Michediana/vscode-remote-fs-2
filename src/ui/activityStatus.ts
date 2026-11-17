import * as vscode from 'vscode';
import { ActivityTracker } from '../activity';
import { Connection, ConnectionStore } from '../config';
import { ConnectionManager } from '../connectionManager';
import { SCHEMES } from '../remote';

function formatBytes(n: number) {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatTime(at?: number) {
  return at ? new Date(at).toLocaleTimeString() : '—';
}

/** Escapes text placed in a Markdown tooltip. */
function md(text: string) {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/**
 * Status bar item showing the remote connections in use: connecting / connected / busy /
 * failed, with the operations in progress and the data transferred in the tooltip.
 */
export class ActivityStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('remotefs.activity', vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[] = [this.item];

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly activity: ActivityTracker
  ) {
    this.item.name = 'Remote FS 2 Activity';
    this.item.command = 'remotefs.showActivity';
    const update = () => this.update();
    this.disposables.push(
      activity.onDidChange(update),
      manager.onDidChangeState(update),
      store.onDidChange(update),
      vscode.workspace.onDidChangeWorkspaceFolders(update)
    );
    this.update();
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }

  /** Connections shown: those with a workspace folder, plus those connected or failing. */
  connections(): Connection[] {
    const ids = new Set<string>(this.manager.knownIds());
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if ((SCHEMES as readonly string[]).includes(f.uri.scheme)) {
        ids.add(f.uri.authority.toLowerCase());
      }
    }
    return [...ids].map(id => this.store.get(id)).filter((c): c is Connection => !!c);
  }

  private update() {
    const conns = this.connections();
    if (!conns.length) {
      this.item.hide();
      return;
    }
    let inflight = 0;
    let connecting = 0;
    let connected = 0;
    const failed: string[] = [];
    const tooltip = new vscode.MarkdownString('', true);
    tooltip.appendMarkdown('**Remote FS 2**\n\n');
    tooltip.appendMarkdown('| | |\n|:--|:--|\n');
    for (const conn of conns) {
      const state = this.manager.getState(conn.id);
      const a = this.activity.get(conn.id);
      inflight += a.inflight;
      const icon =
        state.status === 'connected'
          ? '$(vm-active)'
          : state.status === 'connecting'
            ? '$(loading~spin)'
            : state.status === 'error'
              ? '$(error)'
              : '$(vm-outline)';
      if (state.status === 'connected') {
        connected++;
      } else if (state.status === 'connecting') {
        connecting++;
      } else if (state.status === 'error') {
        failed.push(conn.name);
      }
      const status = { connected: 'connected', connecting: 'connecting…', error: 'error', idle: 'not connected' }[state.status];
      tooltip.appendMarkdown(`| ${icon} **${md(conn.name)}** | ${status}${a.inflight ? ` · ${a.inflight} in progress` : ''} |\n`);
      tooltip.appendMarkdown(`| | $(arrow-down) ${formatBytes(a.down)} · $(arrow-up) ${formatBytes(a.up)} · ${a.ops} ops |\n`);
      if (a.lastOp) {
        tooltip.appendMarkdown(`| | last: \`${md(a.lastOp)}\` at ${formatTime(a.lastAt)} |\n`);
      }
      const error = state.status === 'error' ? state.error : a.lastError;
      if (error) {
        tooltip.appendMarkdown(`| | $(warning) ${md(error)} (${formatTime(state.status === 'error' ? undefined : a.lastErrorAt)}) |\n`);
      }
    }
    tooltip.appendMarkdown('\nClick for actions (refresh, log, disconnect).');

    const label = conns.length === 1 ? conns[0].name : `${connected}/${conns.length}`;
    if (connecting) {
      this.item.text = `$(loading~spin) ${label}`;
    } else if (inflight) {
      this.item.text = `$(sync~spin) ${label} · ${inflight}`;
    } else if (failed.length) {
      this.item.text = `$(cloud-offline) ${label}`;
    } else if (connected) {
      this.item.text = `$(cloud) ${label}`;
    } else {
      this.item.text = `$(debug-disconnect) ${label}`;
    }
    this.item.backgroundColor = failed.length && !connecting ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.item.tooltip = tooltip;
    this.item.show();
  }

  /** Quick pick opened by clicking the item. */
  async showActions() {
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const items: Item[] = [
      { label: '$(refresh) Refresh Remote Folders', run: () => vscode.commands.executeCommand('remotefs.refresh') },
      { label: '$(output) Show Log', run: () => vscode.commands.executeCommand('remotefs.showLog') },
    ];
    const conns = this.connections();
    if (conns.length) {
      items.push({ label: 'Connections', kind: vscode.QuickPickItemKind.Separator });
      for (const conn of conns) {
        const a = this.activity.get(conn.id);
        const status = this.manager.getState(conn.id).status;
        if (status === 'connected' || status === 'connecting') {
          items.push({
            label: `$(debug-disconnect) Disconnect ${conn.name}`,
            description: `↓ ${formatBytes(a.down)} ↑ ${formatBytes(a.up)} · ${a.ops} ops`,
            run: () => this.manager.disconnect(conn.id),
          });
        } else {
          items.push({
            label: `$(plug) Connect ${conn.name}`,
            description: status === 'error' ? this.manager.getState(conn.id).error : undefined,
            run: async () => {
              try {
                await this.manager.getClient(conn, { retryNow: true });
              } catch {
                return; // failures are notified by the manager
              }
              await vscode.commands.executeCommand('remotefs.refresh');
            },
          });
        }
      }
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Remote FS 2' });
    await picked?.run?.();
  }
}
