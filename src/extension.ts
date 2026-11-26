import * as path from 'path';
import * as vscode from 'vscode';
import { ChangesFileNode, registerChangesTree } from './changesTree';
import { CheckpointTreeProvider, registerCheckpointTree } from './checkpointTree';
import { registerCheckpointGuard } from './checkpointGuard';
import {
  markSafeCommand,
  moveCheckpointCommand,
  removeCheckpointCommand,
  setCheckpointCommand,
} from './commands/checkpoint';
import {
  compareWithWorkingTree,
  openCommitDiff,
  openCommitFileDiff,
  openWorkingTreeDiff,
  openWorkingTreeFileDiff,
} from './commands/checkpointDiff';
import { showDiff } from './commands/openDiff';
import {
  compareWithCommand,
  mergeParentCommand,
  openBranchInNewWindowCommand,
  openPrCommand,
  pullDefaultBranchCommand,
  resetParentCommand,
  switchToBranchCommand,
} from './commands/stack';
import { refreshPrThreads } from './commands/prThreads';
import { quoteComment } from './commands/quoteComment';
import { registerComments } from './comments/controller';
import { CommentStore } from './comments/store';
import { currentBranch, isDetachedHead, repoRoot } from './git';
import { GitContentProvider, REVU_GIT_SCHEME } from './gitContentProvider';
import { registerGitWatcher } from './gitWatcher';
import { fetchStackExternal } from './github/gh';
import { GithubThreadRenderer } from './github/threadRenderer';
import { ReviewState } from './reviewState';
import { StackNode, registerStackTree } from './stackTree';

let checkpointProvider: CheckpointTreeProvider | undefined;
let reviewState: ReviewState | undefined;

function refreshAfterCheckpointChange(): void {
  checkpointProvider?.refresh();
  void reviewState?.refresh({ external: false });
}

async function refreshAfterAction(options: { external?: boolean } = {}): Promise<void> {
  checkpointProvider?.refresh();
  await reviewState?.refresh({ external: options.external ?? false });
}

function withState(
  action: (state: ReviewState) => Promise<void>
): () => Promise<void> | undefined {
  return () => (reviewState ? action(reviewState) : undefined);
}

async function setCheckpointMode(on: boolean): Promise<void> {
  if (!reviewState) {
    return;
  }
  reviewState.setCheckpointMode(on);
  await vscode.commands.executeCommand('setContext', 'revu.checkpointMode', on);
  await reviewState.refresh({ external: false });
}

export function activate(context: vscode.ExtensionContext): void {
  const renderer = new GithubThreadRenderer();
  context.subscriptions.push(
    renderer,
    vscode.workspace.registerTextDocumentContentProvider(REVU_GIT_SCHEME, new GitContentProvider())
  );
  const store = new CommentStore(context.workspaceState);
  const manager = registerComments(context, store);
  context.subscriptions.push(
    vscode.commands.registerCommand('revu.quoteComment', (comment: vscode.Comment | undefined) =>
      quoteComment(manager, comment)
    ),
    vscode.commands.registerCommand('revu.refreshPrThreads', () =>
      reviewState
        ? refreshPrThreads(renderer, reviewState.repoRoot, { announce: true })
        : undefined
    ),
    vscode.commands.registerCommand('revu.refreshStack', () => reviewState?.refresh()),
    vscode.commands.registerCommand('revu.switchToBranch', (node: StackNode) =>
      reviewState ? switchToBranchCommand(reviewState, node, refreshAfterAction) : undefined
    ),
    vscode.commands.registerCommand('revu.openBranchInNewWindow', openBranchInNewWindowCommand),
    vscode.commands.registerCommand('revu.openPr', openPrCommand),
    vscode.commands.registerCommand(
      'revu.pullDefaultBranch',
      withState((state) => pullDefaultBranchCommand(state, refreshAfterAction))
    ),
    vscode.commands.registerCommand(
      'revu.mergeParent',
      withState((state) => mergeParentCommand(state, refreshAfterAction))
    ),
    vscode.commands.registerCommand(
      'revu.compareWith',
      withState((state) => compareWithCommand(state, refreshAfterAction))
    ),
    vscode.commands.registerCommand(
      'revu.resetParent',
      withState((state) => resetParentCommand(state, refreshAfterAction))
    ),
    vscode.commands.registerCommand('revu.showSinceCheckpoint', () => setCheckpointMode(true)),
    vscode.commands.registerCommand('revu.showAllChanges', () => setCheckpointMode(false)),
    vscode.commands.registerCommand('revu.openChangesFile', (node: ChangesFileNode) =>
      showDiff(node.file, { repoRoot: node.repoRoot, baseRef: node.baseRef })
    ),
    vscode.commands.registerCommand('revu.refreshCheckpoint', () => checkpointProvider?.refresh()),
    vscode.commands.registerCommand('revu.markSafe', (node) =>
      markSafeCommand(node, refreshAfterCheckpointChange)
    ),
    vscode.commands.registerCommand('revu.moveCheckpoint', (node) =>
      moveCheckpointCommand(node, refreshAfterCheckpointChange)
    ),
    vscode.commands.registerCommand('revu.setCheckpoint', () =>
      setCheckpointCommand(refreshAfterCheckpointChange)
    ),
    vscode.commands.registerCommand('revu.removeCheckpoint', () =>
      removeCheckpointCommand(refreshAfterCheckpointChange)
    ),
    vscode.commands.registerCommand('revu.openCommitDiff', openCommitDiff),
    vscode.commands.registerCommand('revu.openCommitFileDiff', openCommitFileDiff),
    vscode.commands.registerCommand('revu.openWorkingTreeDiff', openWorkingTreeDiff),
    vscode.commands.registerCommand('revu.openWorkingTreeFileDiff', openWorkingTreeFileDiff),
    vscode.commands.registerCommand('revu.compareWithWorkingTree', compareWithWorkingTree)
  );
  void vscode.commands.executeCommand('setContext', 'revu.checkpointMode', false);
  void (async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.commands.executeCommand('setContext', 'revu.isGitRepo', false);
      return;
    }
    let root: string;
    try {
      root = await repoRoot(folder.uri.fsPath);
    } catch {
      void vscode.commands.executeCommand('setContext', 'revu.isGitRepo', false);
      return;
    }
    void vscode.commands.executeCommand('setContext', 'revu.isGitRepo', true);
    const gitStateEvent = registerGitWatcher(context, root);
    const state = new ReviewState(root, fetchStackExternal);
    reviewState = state;
    context.subscriptions.push(state);
    registerStackTree(context, state);
    registerChangesTree(context, state);
    registerStackContext(context, state);
    checkpointProvider = registerCheckpointTree(context, root, gitStateEvent);
    registerCheckpointGuard(context, root, gitStateEvent);
    registerReviewRefresh(context, state, gitStateEvent, renderer);
    await state.refresh();
  })();
}

function registerStackContext(context: vscode.ExtensionContext, state: ReviewState): void {
  context.subscriptions.push(
    state.onDidChange(() => {
      const current = state.snapshot?.stack.current;
      const onFeatureBranch = current !== undefined && !current.onTrunk;
      const hasOverride =
        current?.source === 'override' || current?.warning === 'override target missing';
      void vscode.commands.executeCommand('setContext', 'revu.onFeatureBranch', onFeatureBranch);
      void vscode.commands.executeCommand('setContext', 'revu.inGhStack', current?.inGhStack === true);
      void vscode.commands.executeCommand('setContext', 'revu.hasParentOverride', hasOverride);
    })
  );
}

function registerReviewRefresh(
  context: vscode.ExtensionContext,
  state: ReviewState,
  gitStateEvent: vscode.Event<void>,
  renderer: GithubThreadRenderer
): void {
  let lastBranch: string | undefined;
  const branchNow = async (): Promise<string | undefined> =>
    (await isDetachedHead(state.repoRoot)) ? undefined : currentBranch(state.repoRoot);
  const refreshFromGit = async (): Promise<void> => {
    const branch = await branchNow().catch(() => undefined);
    await state.refresh({ external: branch !== lastBranch });
  };
  let saveTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    state.onDidChange(() => {
      const branch = state.snapshot?.stack.current?.branch;
      if (branch !== lastBranch) {
        lastBranch = branch;
        void refreshPrThreads(renderer, state.repoRoot);
      }
    }),
    gitStateEvent(() => void refreshFromGit()),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        void refreshFromGit();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const rel = path.relative(state.repoRoot, doc.uri.fsPath);
      if (doc.uri.scheme !== 'file' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => void state.refresh({ external: false }), 1000);
    }),
    new vscode.Disposable(() => {
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
    })
  );
}

export function deactivate(): void {}
