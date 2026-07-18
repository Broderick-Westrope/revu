import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile } from '../git';
import { makeGitUri } from '../gitContentProvider';
import { getActiveScope } from '../scope';

export async function openDiff(file: ChangedFile | string): Promise<void> {
  const scope = getActiveScope();
  if (!scope) {
    void vscode.window.showErrorMessage('Revu: no active review. Run "Revu: Start Review" first.');
    return;
  }

  const changed: ChangedFile = typeof file === 'string' ? { path: file, status: 'M' } : file;
  const { repoRoot, baseRef } = scope;
  const fileUri = (p: string): vscode.Uri => vscode.Uri.file(path.join(repoRoot, p));

  switch (changed.status) {
    case 'M':
    case 'A':
    case 'U':
      await vscode.commands.executeCommand(
        'vscode.diff',
        makeGitUri(repoRoot, baseRef, changed.path),
        fileUri(changed.path),
        `${path.basename(changed.path)} (Revu)`
      );
      break;
    case 'D':
      await vscode.commands.executeCommand(
        'vscode.diff',
        makeGitUri(repoRoot, baseRef, changed.path),
        makeGitUri(repoRoot, 'EMPTY', changed.path),
        `${path.basename(changed.path)} (deleted)`
      );
      break;
    case 'R': {
      const oldPath = changed.oldPath ?? changed.path;
      await vscode.commands.executeCommand(
        'vscode.diff',
        makeGitUri(repoRoot, baseRef, oldPath),
        fileUri(changed.path),
        `${path.basename(oldPath)} → ${path.basename(changed.path)}`
      );
      break;
    }
  }
}
