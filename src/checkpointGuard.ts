import * as vscode from 'vscode';
import { CheckpointState, getCheckpointState } from './checkpoint';
import { changedFiles } from './git';
import { showDiff } from './commands/openDiff';
import { logWarning } from './log';

export type GuardAction = 'orphanPrompt' | 'none';

export function guardAction(
  state: CheckpointState,
  promptedOrphanShas: ReadonlySet<string>
): GuardAction {
  if (state.kind === 'orphaned' && !promptedOrphanShas.has(state.sha)) {
    return 'orphanPrompt';
  }
  return 'none';
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

export function registerCheckpointGuard(
  context: vscode.ExtensionContext,
  root: string,
  watcherEvent: vscode.Event<void>
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
      if (guardAction(state, promptedOrphanShas) === 'orphanPrompt' && state.kind === 'orphaned') {
        promptedOrphanShas.add(state.sha);
        await promptOrphan(root, state);
      }
    } catch (err) {
      logWarning(`checkpoint guard check failed: ${(err as Error).message}`);
    } finally {
      checking = false;
    }
  };
  context.subscriptions.push(watcherEvent(() => void check()));
}
