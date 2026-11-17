import { posix } from 'path';
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

export class EntryNode {
  readonly kind = 'entry';
  constructor(readonly conn: Connection, readonly uri: vscode.Uri, readonly type: vscode.FileType) {}
  get isDirectory() {
    return (this.type & vscode.FileType.Directory) !== 0;
  }
}

export type Node = ConnectionNode | EntryNode;

export class ConnectionsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChangeTreeData];
  readonly treeView: vscode.TreeView<Node>;

  constructor(private readonly store: ConnectionStore, private readonly manager: ConnectionManager) {
    this.treeView = vscode.window.createTreeView('remotefs.connections', {
      treeDataProvider: this,
      showCollapseAll: true,
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
    if (node instanceof ConnectionNode) {
      return this.connectionItem(node);
    }
    const name = posix.basename(node.uri.path);
    const item = new vscode.TreeItem(
      name,
      node.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.id = `entry:${this.manager.session(node.conn.id)}:${node.uri.toString()}`;
    item.resourceUri = node.uri;
    item.contextValue = node.isDirectory ? 'remotefs.dir' : 'remotefs.file';
    if (node.type & vscode.FileType.SymbolicLink) {
      item.description = '↪';
    }
    if (!node.isDirectory) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
    }
    return item;
  }

  private connectionItem(node: ConnectionNode): vscode.TreeItem {
    const { conn } = node;
    const state = this.manager.getState(conn.id);
    const item = new vscode.TreeItem(conn.config.label || conn.name, vscode.TreeItemCollapsibleState.Collapsed);
    // A new id after a manual disconnect makes VS Code show the node collapsed, so the
    // refresh does not immediately re-read (and reconnect) an expanded connection.
    item.id = `connection:${conn.id}:${this.manager.session(conn.id)}`;
    item.description = describeConnection(conn);
    item.contextValue = state.status === 'connected' ? 'remotefs.connection.connected' : 'remotefs.connection.idle';

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
    tooltip.appendMarkdown(`**${conn.name}** — ${state.status}\n\n`);
    tooltip.appendCodeblock(describeConnection(conn));
    if (state.error) {
      tooltip.appendMarkdown(`\n$(error) ${state.error}`);
    }
    if (conn.target === vscode.ConfigurationTarget.Workspace) {
      tooltip.appendMarkdown('\n\n_Defined in workspace settings_');
    }
    item.tooltip = tooltip;
    return item;
  }

  getParent(node: Node): Node | undefined {
    if (node instanceof ConnectionNode) {
      return undefined;
    }
    const parentPath = posix.dirname(node.uri.path);
    if (parentPath === node.uri.path || parentPath === '/') {
      return new ConnectionNode(node.conn);
    }
    return new EntryNode(node.conn, node.uri.with({ path: parentPath }), vscode.FileType.Directory);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.store.list().map(c => new ConnectionNode(c));
    }
    if (node instanceof EntryNode && !node.isDirectory) {
      return [];
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(node.uri);
      return entries
        .sort(([an, at], [bn, bt]) => {
          const ad = at & vscode.FileType.Directory ? 0 : 1;
          const bd = bt & vscode.FileType.Directory ? 0 : 1;
          return ad - bd || an.localeCompare(bn);
        })
        .map(
          ([name, type]) =>
            new EntryNode(node.conn, node.uri.with({ path: posix.join(node.uri.path, name) }), type)
        );
    } catch {
      // connection errors are already reported by the ConnectionManager
      return [];
    }
  }
}
