import * as vscode from 'vscode';
import { activateScope } from './activateScope';
import { resolveCheckpointScope } from '../checkpointGuard';
import { currentBranch, defaultBranch, mergeBase, repoRoot } from '../git';
import { GithubThreadRenderer } from '../github/threadRenderer';
import { clearActiveScope, ReviewScope, setPrContext } from '../scope';

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

  await activateScope(scope, renderer);
}

export async function endReview(renderer: GithubThreadRenderer): Promise<void> {
  clearActiveScope();
  setPrContext(undefined);
  renderer.clear();
  await vscode.commands.executeCommand('setContext', 'revu.reviewActive', false);
}
