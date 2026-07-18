import * as vscode from 'vscode';
import { currentBranch, defaultBranch, mergeBase, repoRoot } from '../git';
import { clearActiveScope, ReviewScope, setActiveScope } from '../scope';

export async function startReview(): Promise<void> {
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
    ],
    { placeHolder: 'Select review scope' }
  );
  if (!pick) {
    return;
  }

  let scope: ReviewScope;
  if (pick.type === 'workingTree') {
    scope = { type: 'workingTree', baseRef: 'HEAD', repoRoot: root };
  } else {
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
  }

  setActiveScope(scope);
  await vscode.commands.executeCommand('setContext', 'revu.reviewActive', true);
}

export async function endReview(): Promise<void> {
  clearActiveScope();
  await vscode.commands.executeCommand('setContext', 'revu.reviewActive', false);
}
