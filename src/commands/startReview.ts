import * as vscode from 'vscode';
import { CheckpointState, getCheckpointState } from '../checkpoint';
import { currentBranch, defaultBranch, mergeBase, repoRoot } from '../git';
import { fetchPrMetadata, fetchReviewThreads, isGhAvailable, resetGhAvailability } from '../github/gh';
import { GithubThreadRenderer } from '../github/threadRenderer';
import {
  clearActiveScope,
  getActiveScope,
  ReviewScope,
  setActiveScope,
  setPrContext,
} from '../scope';

export async function refreshPrThreads(renderer: GithubThreadRenderer): Promise<void> {
  const scope = getActiveScope();
  if (!scope) {
    return;
  }
  resetGhAvailability();
  try {
    if (!(await isGhAvailable(scope.repoRoot))) {
      return;
    }
    const meta = await fetchPrMetadata(scope.repoRoot);
    if (!meta) {
      setPrContext(undefined);
      renderer.clear();
      return;
    }
    setPrContext(meta);
    const threads = await fetchReviewThreads(scope.repoRoot, meta.number);
    const { shown, skipped } = renderer.renderThreads(scope.repoRoot, threads);
    void vscode.window.showInformationMessage(
      `Revu: PR #${meta.number}: ${shown} threads shown, ${skipped} skipped (outdated).`
    );
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Revu: could not load GitHub PR data: ${(err as Error).message}`
    );
  }
}

export function checkpointScopeFromState(
  state: CheckpointState,
  root: string
): ReviewScope | undefined {
  if (state.kind === 'explicit' || state.kind === 'implicit') {
    return { type: 'checkpoint', baseRef: state.sha, repoRoot: root, branch: state.branch };
  }
  return undefined;
}

export async function resolveCheckpointScope(
  root: string,
  retried = false
): Promise<ReviewScope | undefined> {
  const state = await getCheckpointState(root);
  const scope = checkpointScopeFromState(state, root);
  if (scope) {
    return scope;
  }
  if (state.kind === 'detached') {
    void vscode.window.showErrorMessage('Revu: checkpoint is disabled on a detached HEAD');
    return undefined;
  }
  if (retried) {
    return undefined;
  }
  if (state.kind === 'needsInit') {
    await vscode.commands.executeCommand('revu.setCheckpoint');
    return resolveCheckpointScope(root, true);
  }
  const action = await vscode.window.showWarningMessage(
    'Revu: the checkpoint is orphaned — its commit is no longer on this branch. Pick a new checkpoint to continue.',
    'Pick new checkpoint'
  );
  if (action !== 'Pick new checkpoint') {
    return undefined;
  }
  await vscode.commands.executeCommand('revu.setCheckpoint');
  return resolveCheckpointScope(root, true);
}

export async function startReview(renderer: GithubThreadRenderer): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Revu: no workspace folder open');
    return;
  }

  let root: string;
  try {
    root = await repoRoot(folder.uri.fsPath);
  } catch {
    void vscode.window.showErrorMessage('Revu: workspace is not a git repository');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'Working tree vs HEAD',
        description: 'Uncommitted changes, including untracked files',
        type: 'workingTree' as const,
      },
      {
        label: 'Branch vs merge-base with default branch',
        description: 'All changes on this branch',
        type: 'branch' as const,
      },
      {
        label: 'Since checkpoint',
        description: 'Changes since the last reviewed commit',
        type: 'checkpoint' as const,
      },
    ],
    { placeHolder: 'Select review scope' }
  );
  if (!pick) {
    return;
  }

  let scope: ReviewScope | undefined;
  switch (pick.type) {
    case 'workingTree':
      scope = { type: 'workingTree', baseRef: 'HEAD', repoRoot: root };
      break;
    case 'branch':
      try {
        const defBranch = await defaultBranch(root);
        const branch = await currentBranch(root);
        if (branch === defBranch) {
          void vscode.window.showWarningMessage(
            `You are on ${branch}; branch scope would be empty`
          );
          return;
        }
        const base = await mergeBase(root, defBranch);
        scope = { type: 'branch', baseRef: base, repoRoot: root };
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Revu: could not resolve branch scope: ${(err as Error).message}`
        );
        return;
      }
      break;
    case 'checkpoint':
      scope = await resolveCheckpointScope(root);
      break;
  }
  if (!scope) {
    return;
  }

  setActiveScope(scope);
  await vscode.commands.executeCommand('setContext', 'revu.reviewActive', true);
  void refreshPrThreads(renderer);
}

export async function endReview(renderer: GithubThreadRenderer): Promise<void> {
  clearActiveScope();
  setPrContext(undefined);
  renderer.clear();
  await vscode.commands.executeCommand('setContext', 'revu.reviewActive', false);
}
