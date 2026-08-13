import * as vscode from 'vscode';
import { CheckpointState, getCheckpointState } from './checkpoint';
import { changedFiles } from './git';
import { GithubThreadRenderer } from './github/threadRenderer';
import { activateScope } from './commands/activateScope';
import { showDiff } from './commands/openDiff';
import { ReviewScope, getActiveScope } from './scope';

export type GuardAction = 'orphanPrompt' | 'branchPrompt' | 'none';

export function guardAction(
  state: CheckpointState,
  scope: ReviewScope | undefined,
  currentBranch: string | undefined,
  promptedOrphanShas: ReadonlySet<string>
): GuardAction {
  if (state.kind === 'detached') {
    return 'none';
  }
  if (state.kind === 'orphaned' && !promptedOrphanShas.has(state.sha)) {
    return 'orphanPrompt';
  }
  if (
    scope?.type === 'checkpoint' &&
    currentBranch !== undefined &&
    scope.branch !== currentBranch
  ) {
    return 'branchPrompt';
  }
  return 'none';
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

export async function promptOrphan(
  root: string,
  state: { branch: string; sha: string }
): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    `Revu: the checkpoint on branch "${state.branch}" is orphaned — its commit is no longer on this branch (rebase or amend).`,
    'Pick new checkpoint',
    'Show recovery comparison'
  );
  if (action === 'Pick new checkpoint') {
    await vscode.commands.executeCommand('revu.setCheckpoint');
    return;
  }
  if (action === 'Show recovery comparison') {
    let files;
    try {
      files = await changedFiles(root, state.sha, false);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Revu: could not compare against the orphaned checkpoint: ${(err as Error).message}`
      );
      return;
    }
    if (files.length === 0) {
      void vscode.window.showInformationMessage(
        'Revu: no differences against the orphaned checkpoint'
      );
      return;
    }
    await showDiff(files[0], { repoRoot: root, baseRef: state.sha });
  }
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
  } else {
    await promptOrphan(root, state);
  }
  return resolveCheckpointScope(root, true);
}

async function promptBranchSwitch(
  root: string,
  scope: ReviewScope,
  branch: string,
  renderer: GithubThreadRenderer
): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    `Revu: the active checkpoint review is for branch "${scope.branch}", but you are now on "${branch}".`,
    'Restart review on this branch',
    'End review'
  );
  if (action === 'Restart review on this branch') {
    await vscode.commands.executeCommand('revu.endReview');
    const next = await resolveCheckpointScope(root);
    if (next) {
      await activateScope(next, renderer);
    }
    return;
  }
  if (action === 'End review') {
    await vscode.commands.executeCommand('revu.endReview');
  }
}

export function registerCheckpointGuard(
  context: vscode.ExtensionContext,
  root: string,
  watcherEvent: vscode.Event<void>,
  renderer: GithubThreadRenderer
): void {
  const promptedOrphanShas = new Set<string>();
  let checking = false;
  const check = async (): Promise<void> => {
    if (checking) {
      return;
    }
    checking = true;
    try {
      const state = await getCheckpointState(root);
      if (state.kind !== 'orphaned') {
        promptedOrphanShas.clear();
      }
      const scope = getActiveScope();
      const branch = state.kind === 'detached' ? undefined : state.branch;
      const action = guardAction(state, scope, branch, promptedOrphanShas);
      if (action === 'orphanPrompt' && state.kind === 'orphaned') {
        promptedOrphanShas.add(state.sha);
        await promptOrphan(root, state);
      } else if (action === 'branchPrompt' && scope && branch !== undefined) {
        await promptBranchSwitch(root, scope, branch, renderer);
      }
    } catch (err) {
      console.warn('Revu: checkpoint guard check failed', err);
    } finally {
      checking = false;
    }
  };
  context.subscriptions.push(watcherEvent(() => void check()));
}
