import * as path from 'path';
import * as vscode from 'vscode';
import {
  REVIEWED_COMMITS_CAP,
  getCheckpointState,
  reviewedCommits,
  unreviewedCommits,
} from './checkpoint';
import {
  ChangedFile,
  CommitInfo,
  changedFiles,
  commitChangedFiles,
  hasUncommittedChanges,
} from './git';
import { EMPTY_REF } from './gitContentProvider';

export interface CommitNode {
  kind: 'commit';
  commit: CommitInfo;
  parentSha: string;
  repoRoot: string;
  reviewed: boolean;
  isCheckpoint: boolean;
}

export interface CommitFileNode {
  kind: 'commitFile';
  file: ChangedFile;
  commitSha: string;
  parentSha: string;
  repoRoot: string;
}

export interface WorkingTreeFileNode {
  kind: 'workingTreeFile';
  file: ChangedFile;
  checkpointSha: string;
  repoRoot: string;
}

export interface RecoveryRootNode {
  kind: 'recoveryRoot';
  orphanedSha: string;
  repoRoot: string;
}

export interface ReviewedOverflowNode {
  kind: 'reviewedOverflow';
  repoRoot: string;
}

export type CheckpointNode =
  | CommitNode
  | CommitFileNode
  | WorkingTreeFileNode
  | RecoveryRootNode
  | ReviewedOverflowNode;

export function summaryDescription(
  commitCount: number,
  dirty: boolean,
  reviewedCount: number,
  reviewedTruncated: boolean
): string {
  const commits = `${commitCount} commit${commitCount === 1 ? '' : 's'}`;
  const base = dirty ? `${commits} + dirty working tree` : commits;
  if (reviewedCount === 0) {
    return base;
  }
  return `${base} · ${reviewedCount}${reviewedTruncated ? '+' : ''} reviewed`;
}

const MESSAGES = {
  orphaned:
    'Checkpoint is orphaned — its commit is no longer on this branch (rebase or amend). Re-pick with "Revu: Set Checkpoint".',
  detached: 'Checkpoint disabled: detached HEAD',
  needsInit: 'No checkpoint for this branch yet. Run "Revu: Set Checkpoint" to pick one.',
};

export class CheckpointTreeProvider implements vscode.TreeDataProvider<CheckpointNode> {
  private readonly emitter = new vscode.EventEmitter<CheckpointNode | undefined | void>();

  readonly onDidChangeTreeData: vscode.Event<CheckpointNode | undefined | void> =
    this.emitter.event;

  constructor(
    private readonly repoRoot: string,
    private readonly implicitBase: () => string | undefined,
    private readonly setMessage?: (message: string | undefined) => void,
    private readonly setDescription?: (description: string | undefined) => void
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(element?: CheckpointNode): Promise<CheckpointNode[]> {
    if (!element) {
      return this.rootChildren();
    }
    switch (element.kind) {
      case 'commit': {
        const files = await commitChangedFiles(element.repoRoot, element.commit.sha);
        return files.map((file) => ({
          kind: 'commitFile',
          file,
          commitSha: element.commit.sha,
          parentSha: element.parentSha,
          repoRoot: element.repoRoot,
        }));
      }
      case 'recoveryRoot': {
        const files = await changedFiles(element.repoRoot, element.orphanedSha, false);
        return files.map((file) => ({
          kind: 'workingTreeFile',
          file,
          checkpointSha: element.orphanedSha,
          repoRoot: element.repoRoot,
        }));
      }
      default:
        return [];
    }
  }

  getTreeItem(element: CheckpointNode): vscode.TreeItem {
    switch (element.kind) {
      case 'commit': {
        const item = new vscode.TreeItem(
          element.commit.subject,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.tooltip = `${element.commit.author} — ${element.commit.date}`;
        if (element.isCheckpoint) {
          item.description = `${element.commit.shortSha} · checkpoint`;
          item.contextValue = 'revu.checkpointCommit';
          item.iconPath = new vscode.ThemeIcon('milestone');
        } else if (element.reviewed) {
          item.description = `${element.commit.shortSha} · reviewed`;
          item.contextValue = 'revu.reviewedCommit';
          item.iconPath = new vscode.ThemeIcon('check');
        } else {
          item.description = element.commit.shortSha;
          item.contextValue = 'revu.commit';
          item.iconPath = new vscode.ThemeIcon('git-commit');
        }
        item.command = {
          command: 'revu.openCommitDiff',
          title: 'Open Commit Diff',
          arguments: [element],
        };
        return item;
      }
      case 'commitFile': {
        const item = new vscode.TreeItem(
          path.basename(element.file.path),
          vscode.TreeItemCollapsibleState.None
        );
        item.resourceUri = vscode.Uri.file(path.join(element.repoRoot, element.file.path));
        item.description = element.file.path;
        item.contextValue = 'revu.commitFile';
        item.command = {
          command: 'revu.openCommitFileDiff',
          title: 'Open Commit File Diff',
          arguments: [element],
        };
        return item;
      }
      case 'workingTreeFile': {
        const item = new vscode.TreeItem(
          path.basename(element.file.path),
          vscode.TreeItemCollapsibleState.None
        );
        item.resourceUri = vscode.Uri.file(path.join(element.repoRoot, element.file.path));
        item.description = element.file.path;
        item.contextValue = 'revu.workingTreeFile';
        item.command = {
          command: 'revu.openWorkingTreeFileDiff',
          title: 'Open Working Tree File Diff',
          arguments: [element],
        };
        return item;
      }
      case 'recoveryRoot': {
        const item = new vscode.TreeItem(
          'Show recovery comparison',
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.contextValue = 'revu.recoveryRoot';
        item.iconPath = new vscode.ThemeIcon('history');
        return item;
      }
      case 'reviewedOverflow': {
        const item = new vscode.TreeItem(
          `Older reviewed commits hidden (showing ${REVIEWED_COMMITS_CAP})`,
          vscode.TreeItemCollapsibleState.None
        );
        item.contextValue = 'revu.reviewedOverflow';
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  private async rootChildren(): Promise<CheckpointNode[]> {
    const implicitBase = this.implicitBase();
    const state = await getCheckpointState(this.repoRoot, implicitBase);
    switch (state.kind) {
      case 'detached':
        this.update(MESSAGES.detached, undefined);
        return [];
      case 'needsInit':
        this.update(MESSAGES.needsInit, undefined);
        return [];
      case 'orphaned':
        this.update(MESSAGES.orphaned, undefined);
        return [{ kind: 'recoveryRoot', orphanedSha: state.sha, repoRoot: this.repoRoot }];
      case 'explicit':
      case 'implicit': {
        const [commits, dirty, reviewed] = await Promise.all([
          unreviewedCommits(this.repoRoot, state.sha, state.branch),
          hasUncommittedChanges(this.repoRoot),
          reviewedCommits(this.repoRoot, state.sha, implicitBase),
        ]);
        this.update(
          undefined,
          summaryDescription(
            commits.length,
            dirty,
            reviewed.commits.length,
            reviewed.truncated
          )
        );
        const nodes: CheckpointNode[] = [
          ...commits.map(
            (commit): CommitNode => ({
              kind: 'commit',
              commit,
              parentSha: commit.parents[0] ?? EMPTY_REF,
              repoRoot: this.repoRoot,
              reviewed: false,
              isCheckpoint: false,
            })
          ),
          ...reviewed.commits.map(
            (commit): CommitNode => ({
              kind: 'commit',
              commit,
              parentSha: commit.parents[0] ?? EMPTY_REF,
              repoRoot: this.repoRoot,
              reviewed: true,
              isCheckpoint: commit.sha === state.sha,
            })
          ),
        ];
        if (reviewed.truncated) {
          nodes.push({ kind: 'reviewedOverflow', repoRoot: this.repoRoot });
        }
        return nodes;
      }
    }
  }

  private update(message: string | undefined, description: string | undefined): void {
    this.setMessage?.(message);
    this.setDescription?.(description);
  }
}

export function registerCheckpointTree(
  context: vscode.ExtensionContext,
  repoRootPath: string,
  onGitStateChanged: vscode.Event<void>,
  implicitBase: () => string | undefined
): CheckpointTreeProvider {
  let treeView: vscode.TreeView<CheckpointNode> | undefined;
  const provider = new CheckpointTreeProvider(
    repoRootPath,
    implicitBase,
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
  treeView = vscode.window.createTreeView('revu.checkpointView', {
    treeDataProvider: provider,
  });

  let debounceTimer: NodeJS.Timeout | undefined;
  const debouncedRefresh = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      provider.refresh();
    }, 2000);
  };

  context.subscriptions.push(
    treeView,
    onGitStateChanged(() => provider.refresh()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') {
        return;
      }
      const rel = path.relative(repoRootPath, doc.uri.fsPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return;
      }
      debouncedRefresh();
    }),
    new vscode.Disposable(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    })
  );

  return provider;
}
