import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile } from './git';
import { ReviewState } from './reviewState';
import { BranchResolution, ParentSource } from './stack';

export interface ChangesFolderNode {
  kind: 'folder';
  name: string;
  children: ChangesNode[];
}

export interface ChangesFileNode {
  kind: 'file';
  file: ChangedFile;
  baseRef: string;
  repoRoot: string;
}

export type ChangesNode = ChangesFolderNode | ChangesFileNode;

const SOURCE_LABELS: Record<ParentSource, string | undefined> = {
  override: 'override',
  'gh-stack': 'gh stack',
  pr: 'PR',
  inferred: 'inferred',
  trunk: undefined,
};

const STATUS_LABELS: Record<ChangedFile['status'], string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  U: 'untracked',
  X: 'conflict',
};

export function parentDescription(resolution: BranchResolution): string {
  const label = SOURCE_LABELS[resolution.source];
  const qualifiers = [label, resolution.ambiguous ? 'ambiguous' : undefined].filter(Boolean);
  let text = `vs ${resolution.parent}`;
  if (qualifiers.length > 0) {
    text += ` (${qualifiers.join(', ')})`;
  }
  if (resolution.warning) {
    text += ` · ${resolution.warning}`;
  }
  return text;
}

function buildTree(files: ChangedFile[], baseRef: string, repoRoot: string): ChangesNode[] {
  const root: ChangesFolderNode = { kind: 'folder', name: '', children: [] };
  for (const file of files) {
    const segments = file.path.split('/');
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let next = folder.children.find(
        (child): child is ChangesFolderNode => child.kind === 'folder' && child.name === segment
      );
      if (!next) {
        next = { kind: 'folder', name: segment, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: 'file', file, baseRef, repoRoot });
  }
  sortTree(root);
  return root.children;
}

function sortTree(folder: ChangesFolderNode): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }
    const nameA = a.kind === 'folder' ? a.name : a.file.path;
    const nameB = b.kind === 'folder' ? b.name : b.file.path;
    return nameA.localeCompare(nameB);
  });
  for (const child of folder.children) {
    if (child.kind === 'folder') {
      sortTree(child);
    }
  }
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangesNode> {
  private readonly emitter = new vscode.EventEmitter<ChangesNode | undefined | void>();

  readonly onDidChangeTreeData: vscode.Event<ChangesNode | undefined | void> = this.emitter.event;

  constructor(
    private readonly state: ReviewState,
    private readonly setMessage?: (message: string | undefined) => void,
    private readonly setDescription?: (description: string | undefined) => void
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(element?: ChangesNode): Promise<ChangesNode[]> {
    if (element) {
      return element.kind === 'folder' ? element.children : [];
    }
    if (this.state.error) {
      this.setMessage?.(`Could not read this branch: ${this.state.error}`);
      this.setDescription?.(undefined);
      return [];
    }
    const snapshot = this.state.snapshot;
    const current = snapshot?.stack.current;
    if (!snapshot || !current) {
      this.setMessage?.(snapshot ? 'HEAD is detached. Check out a branch to review it.' : undefined);
      this.setDescription?.(undefined);
      return [];
    }
    let description = current.onTrunk ? `on ${current.parent}` : parentDescription(current);
    if (snapshot.checkpointMode) {
      description += ' · since checkpoint';
    }
    this.setDescription?.(description);
    this.setMessage?.(snapshot.unavailable);
    if (!snapshot.base) {
      return [];
    }
    let files: ChangedFile[];
    try {
      files = await this.state.files(snapshot);
    } catch (err) {
      this.setMessage?.(`Could not list changes: ${(err as Error).message}`);
      return [];
    }
    if (files.length === 0) {
      this.setMessage?.(
        snapshot.checkpointMode ? 'No changes since the checkpoint.' : `No changes against ${current.parent}.`
      );
    }
    return buildTree(files, snapshot.base, this.state.repoRoot);
  }

  getTreeItem(element: ChangesNode): vscode.TreeItem {
    if (element.kind === 'folder') {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const item = new vscode.TreeItem(
      path.basename(element.file.path),
      vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = vscode.Uri.file(path.join(element.repoRoot, element.file.path));
    item.description = STATUS_LABELS[element.file.status];
    item.contextValue = 'revu.changesFile';
    item.command = {
      command: 'revu.openChangesFile',
      title: 'Open Diff',
      arguments: [element],
    };
    return item;
  }
}

export function registerChangesTree(
  context: vscode.ExtensionContext,
  state: ReviewState
): ChangesTreeProvider {
  let treeView: vscode.TreeView<ChangesNode> | undefined;
  const provider = new ChangesTreeProvider(
    state,
    (message) => {
      if (treeView) {
        treeView.message = message;
      }
    },
    (description) => {
      if (treeView) {
        treeView.description = description;
      }
    }
  );
  treeView = vscode.window.createTreeView('revu.changesView', { treeDataProvider: provider });
  context.subscriptions.push(treeView, state.onDidChange(() => provider.refresh()));
  return provider;
}
