import * as vscode from 'vscode';
import { ChangesFileNode, registerChangesTree } from './changesTree';
import { registerCheckpointTree } from './checkpointTree';
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
import { checkedOutBranch, isInside, repoRoot } from './git';
import { GitContentProvider, REVU_GIT_SCHEME } from './gitContentProvider';
import { registerGitWatcher } from './gitWatcher';
import { fetchStackExternal } from './github/gh';
import { GithubThreadRenderer } from './github/threadRenderer';
import { disposeLog, logWarning } from './log';
import { ReviewState } from './reviewState';
import { StackNode, registerStackTree } from './stackTree';

let reviewState: ReviewState | undefined;

function refreshAfterCheckpointChange(): void {
  void reviewState?.refresh();
}

function currentPr(state: ReviewState): { branch: string; number: number } | undefined {
  const current = state.snapshot?.stack.current;
  return current?.pr ? { branch: current.branch, number: current.pr.number } : undefined;
}

function withState<T extends unknown[]>(
  action: (state: ReviewState, ...args: T) => Promise<void>
): (...args: T) => Promise<void> | undefined {
  return (...args: T) => (reviewState ? action(reviewState, ...args) : undefined);
}

async function setCheckpointMode(on: boolean): Promise<void> {
  if (!reviewState) {
    return;
  }
  reviewState.setCheckpointMode(on);
  await reviewState.refresh();
}

export function activate(context: vscode.ExtensionContext): void {
  const renderer = new GithubThreadRenderer();
  context.subscriptions.push(
    renderer,
    new vscode.Disposable(disposeLog),
    vscode.workspace.registerTextDocumentContentProvider(REVU_GIT_SCHEME, new GitContentProvider())
  );
  const store = new CommentStore(context.workspaceState);
  const manager = registerComments(context, store);
  context.subscriptions.push(
    vscode.commands.registerCommand('revu.quoteComment', (comment: vscode.Comment | undefined) =>
      quoteComment(manager, comment)
    ),
    vscode.commands.registerCommand(
      'revu.refreshPrThreads',
      withState((state) =>
        refreshPrThreads(renderer, state.repoRoot, currentPr(state), { announce: true })
      )
    ),
    vscode.commands.registerCommand(
      'revu.refreshStack',
      withState((state) => state.refresh({ external: true }))
    ),
    vscode.commands.registerCommand(
      'revu.switchToBranch',
      withState((state, node: StackNode) => switchToBranchCommand(state, node))
    ),
    vscode.commands.registerCommand('revu.openBranchInNewWindow', openBranchInNewWindowCommand),
    vscode.commands.registerCommand('revu.openPr', openPrCommand),
    vscode.commands.registerCommand(
      'revu.pullDefaultBranch',
      withState(pullDefaultBranchCommand)
    ),
    vscode.commands.registerCommand(
      'revu.mergeParent',
      withState(mergeParentCommand)
    ),
    vscode.commands.registerCommand(
      'revu.compareWith',
      withState(compareWithCommand)
    ),
    vscode.commands.registerCommand(
      'revu.resetParent',
      withState(resetParentCommand)
    ),
    vscode.commands.registerCommand('revu.showSinceCheckpoint', () => setCheckpointMode(true)),
    vscode.commands.registerCommand('revu.showAllChanges', () => setCheckpointMode(false)),
    vscode.commands.registerCommand('revu.openChangesFile', (node: ChangesFileNode) =>
      showDiff(node.file, { repoRoot: node.repoRoot, baseRef: node.baseRef })
    ),
        vscode.commands.registerCommand('revu.markSafe', (node) =>
      markSafeCommand(node, refreshAfterCheckpointChange)
    ),
    vscode.commands.registerCommand('revu.moveCheckpoint', (node) =>
      moveCheckpointCommand(node, refreshAfterCheckpointChange)
    ),
    vscode.commands.registerCommand('revu.setCheckpoint', () =>
      setCheckpointCommand(
        refreshAfterCheckpointChange,
        reviewState?.snapshot?.stack.current?.diffBase
      )
    ),
    vscode.commands.registerCommand('revu.removeCheckpoint', () =>
      removeCheckpointCommand(refreshAfterCheckpointChange)
    ),
    vscode.commands.registerCommand('revu.openCommitDiff', openCommitDiff),
    vscode.commands.registerCommand('revu.openCommitFileDiff', openCommitFileDiff),
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
    registerCheckpointGuard(context, root, gitStateEvent);
    registerReviewRefresh(context, state, gitStateEvent, renderer, store);
    await state.refresh();
    registerCheckpointTree(
      context,
      root,
      state.onDidChange,
      () => state.snapshot?.stack.current?.diffBase
    );
    await state.refresh({ external: true });
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
      void vscode.commands.executeCommand(
        'setContext',
        'revu.checkpointMode',
        state.snapshot?.checkpointMode === true
      );
    })
  );
}

function registerReviewRefresh(
  context: vscode.ExtensionContext,
  state: ReviewState,
  gitStateEvent: vscode.Event<void>,
  renderer: GithubThreadRenderer,
  store: CommentStore
): void {
  let lastBranch: string | undefined;
  let lastPrKey: string | undefined;
  const branchNow = (): Promise<string | undefined> => checkedOutBranch(state.repoRoot);
  const refreshFromGit = async (): Promise<void> => {
    const branch = await branchNow().catch(() => undefined);
    await state.refresh({ external: branch !== lastBranch });
  };
  const refreshOnFocus = async (): Promise<void> => {
    try {
      const branch = await branchNow();
      if (branch !== lastBranch) {
        await state.refresh({ external: true });
      } else {
        await state.refreshIfChanged();
      }
    } catch (err) {
      logWarning(`focus refresh failed: ${(err as Error).message}`);
    }
  };
  let saveTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    state.onDidChange(() => {
      const branch = state.branch;
      if (branch !== lastBranch) {
        lastBranch = branch;
        void store.setBranch(branch);
      }
      const pr = currentPr(state);
      const prKey = pr ? `${pr.branch}#${pr.number}` : undefined;
      if (prKey !== lastPrKey) {
        lastPrKey = prKey;
        void refreshPrThreads(renderer, state.repoRoot, pr);
      }
    }),
    gitStateEvent(() => void refreshFromGit()),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        void refreshOnFocus();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file' || !isInside(state.repoRoot, doc.uri.fsPath)) {
        return;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => void state.refreshIfChanged(), 1000);
    }),
    new vscode.Disposable(() => {
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
    })
  );
}

export function deactivate(): void {}
