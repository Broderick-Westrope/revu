import * as vscode from 'vscode';
import { Worktrees, aheadBehind } from './git';
import { ReviewState } from './reviewState';
import { BranchResolution, StackResult } from './stack';

export interface StackNode {
  branch: string;
  isTrunk: boolean;
  isCurrent: boolean;
  isLocal: boolean;
  resolution?: BranchResolution;
  worktree?: string;
  counts?: { ahead: number; behind: number };
  children: StackNode[];
}

export class StackTreeProvider implements vscode.TreeDataProvider<StackNode> {
  private readonly emitter = new vscode.EventEmitter<StackNode | undefined | void>();

  readonly onDidChangeTreeData: vscode.Event<StackNode | undefined | void> = this.emitter.event;

  constructor(
    private readonly state: ReviewState,
    private readonly setMessage?: (message: string | undefined) => void
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(element?: StackNode): Promise<StackNode[]> {
    if (element) {
      return element.children;
    }
    if (this.state.error) {
      this.setMessage?.(`Could not read this branch: ${this.state.error}`);
      return [];
    }
    const snapshot = this.state.snapshot;
    if (!snapshot?.stack.current) {
      this.setMessage?.(snapshot ? 'HEAD is detached. Check out a branch to see its stack.' : undefined);
      return [];
    }
    this.setMessage?.(undefined);
    const repoRoot = this.state.repoRoot;
    const root = buildStackTree(snapshot.stack, snapshot.stack.worktrees, repoRoot);
    await Promise.all(
      flatten(root).map(async (node) => {
        if (node.isTrunk || !node.isLocal || !node.resolution) {
          return;
        }
        node.counts = await aheadBehind(repoRoot, node.resolution.parentRef, node.branch).catch(
          () => undefined
        );
      })
    );
    return [root];
  }

  getTreeItem(element: StackNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.branch,
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = element.branch;
    item.description = describe(element, this.state.prsKnown);
    item.tooltip = tooltip(element);
    item.iconPath = element.isCurrent
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon(element.worktree ? 'folder-opened' : 'git-branch');
    const flags = ['revu.stackRow'];
    if (!element.isCurrent && element.isLocal) {
      flags.push('switch');
    }
    if (element.worktree) {
      flags.push('worktree');
    }
    if (element.resolution?.pr) {
      flags.push('pr');
    }
    item.contextValue = flags.join(';');
    return item;
  }
}

function buildStackTree(stack: StackResult, worktrees: Worktrees, currentWorktree: string): StackNode {
  const current = stack.current as BranchResolution & { onTrunk: boolean };
  const trunk = stack.trunk.name;
  const resolutionOf = (branch: string): BranchResolution | undefined =>
    branch === current.branch ? current : stack.branches.get(branch);
  const node = (branch: string): StackNode => {
    const elsewhere = worktrees.byBranch.get(branch);
    return {
      branch,
      isTrunk: false,
      isCurrent: branch === current.branch,
      isLocal: stack.branches.has(branch) || branch === current.branch,
      resolution: resolutionOf(branch),
      worktree: elsewhere !== undefined && elsewhere !== currentWorktree ? elsewhere : undefined,
      children: [],
    };
  };

  const root: StackNode = {
    branch: trunk,
    isTrunk: true,
    isCurrent: current.onTrunk,
    isLocal: true,
    worktree: worktrees.main !== currentWorktree ? worktrees.main : undefined,
    children: [],
  };
  if (current.onTrunk) {
    return root;
  }

  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = current.branch;
  while (cursor !== undefined && cursor !== trunk && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(cursor);
    cursor = resolutionOf(cursor)?.parent;
  }
  let parentNode = root;
  for (const branch of chain) {
    const next = node(branch);
    parentNode.children.push(next);
    parentNode = next;
  }

  const childrenOf = new Map<string, string[]>();
  for (const [branch, resolution] of stack.branches) {
    const list = childrenOf.get(resolution.parent) ?? [];
    list.push(branch);
    childrenOf.set(resolution.parent, list);
  }
  const addDescendants = (parent: StackNode): void => {
    for (const branch of (childrenOf.get(parent.branch) ?? []).sort()) {
      if (seen.has(branch)) {
        continue;
      }
      seen.add(branch);
      const child = node(branch);
      parent.children.push(child);
      addDescendants(child);
    }
  };
  addDescendants(parentNode);
  return root;
}

function flatten(node: StackNode): StackNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function describe(node: StackNode, prsKnown: boolean): string | undefined {
  if (node.isTrunk) {
    return undefined;
  }
  const pr = node.resolution?.pr;
  const parts: string[] = [];
  if (pr) {
    parts.push(`#${pr.number} ${pr.state.toLowerCase()}`);
  } else if (prsKnown) {
    parts.push('no PR');
  }
  if (node.counts) {
    parts.push(`↑${node.counts.ahead} ↓${node.counts.behind}`);
  }
  if (node.resolution?.needsRebase) {
    parts.push('needs rebase');
  }
  return parts.join(' · ');
}

function tooltip(node: StackNode): string {
  const lines = [node.branch];
  if (node.resolution) {
    lines.push(`Parent: ${node.resolution.parent}`);
  }
  if (node.counts) {
    lines.push(`${node.counts.ahead} ahead of and ${node.counts.behind} behind the parent`);
  }
  if (node.resolution?.needsRebase) {
    lines.push('gh stack reports this layer needs a rebase; restack it from the terminal.');
  }
  if (node.worktree) {
    lines.push(`Checked out in ${node.worktree}`);
  }
  return lines.join('\n');
}

export function registerStackTree(
  context: vscode.ExtensionContext,
  state: ReviewState
): StackTreeProvider {
  let treeView: vscode.TreeView<StackNode> | undefined;
  const provider = new StackTreeProvider(state, (message) => {
    if (treeView) {
      treeView.message = message;
    }
  });
  treeView = vscode.window.createTreeView('revu.stackView', { treeDataProvider: provider });
  context.subscriptions.push(treeView, state.onDidChange(() => provider.refresh()));
  return provider;
}
