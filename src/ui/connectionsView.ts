import * as vscode from 'vscode';
import { Connection, ConnectionStore, describeConnection } from '../config';
import { ConnectionManager } from '../connectionManager';

export function rootUri(conn: Connection, path = '/') {
  return vscode.Uri.from({ scheme: conn.scheme, authority: conn.id, path });
}

export class ConnectionNode {
  readonly kind = 'connection';
  constructor(readonly conn: Connection) {}
  get uri() {
    return rootUri(this.conn);
  }
}

export type Node = ConnectionNode;

export class ConnectionsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChangeTreeData];
  readonly treeView: vscode.TreeView<Node>;

  constructor(private readonly store: ConnectionStore, private readonly manager: ConnectionManager) {
    this.treeView = vscode.window.createTreeView('remotefs.connections', {
      treeDataProvider: this,
    });
    this.disposables.push(
      this.treeView,
      store.onDidChange(() => this.refresh()),
      manager.onDidChangeState(() => this.refresh())
    );
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return this.connectionItem(node);
  }

  private connectionItem(node: ConnectionNode): vscode.TreeItem {
    const { conn } = node;
    const state = this.manager.getState(conn.id);
    const item = new vscode.TreeItem(conn.config.label || conn.name, vscode.TreeItemCollapsibleState.None);
    item.id = `connection:${conn.id}`;
    item.description = describeConnection(conn);
    item.contextValue = state.status === 'connected' ? 'remotefs.connection.connected' : 'remotefs.connection.idle';
    item.command = { command: 'remotefs.openInWorkspace', title: vscode.l10n.t('Open in Workspace'), arguments: [node] };

    switch (state.status) {
      case 'connected':
        item.iconPath = new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('testing.iconPassed'));
        break;
      case 'connecting':
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        break;
      case 'error':
        item.iconPath = new vscode.ThemeIcon('vm-outline', new vscode.ThemeColor('errorForeground'));
        break;
      default:
        item.iconPath = new vscode.ThemeIcon('vm-outline');
    }

    const tooltip = new vscode.MarkdownString(undefined, true);
    const statusText = {
      connected: vscode.l10n.t('connected'),
      connecting: vscode.l10n.t('connecting'),
      error: vscode.l10n.t('error'),
      idle: vscode.l10n.t('idle'),
    }[state.status];
    tooltip.appendMarkdown(`**${conn.name}** — ${statusText}\n\n`);
    tooltip.appendCodeblock(describeConnection(conn));
    if (state.error) {
      tooltip.appendMarkdown(`\n$(error) ${state.error}`);
    }
    if (conn.target === vscode.ConfigurationTarget.Workspace) {
      tooltip.appendMarkdown(`\n\n_${vscode.l10n.t('Defined in workspace settings')}_`);
    }
    item.tooltip = tooltip;
    return item;
  }

  getParent(): Node | undefined {
    return undefined;
  }

  getChildren(node?: Node): Node[] {
    // only the connections: their files are browsed in the Explorer (workspace folder or local mirror)
    return node ? [] : this.store.list().map(c => new ConnectionNode(c));
  }
}
