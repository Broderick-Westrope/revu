import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile } from '../git';
import { EMPTY_REF, makeGitUri } from '../gitContentProvider';

export interface DiffBase {
  repoRoot: string;
  baseRef: string;
}

export async function showDiff(
  changed: ChangedFile,
  base: DiffBase,
  options?: vscode.TextDocumentShowOptions
): Promise<void> {
  const { repoRoot, baseRef } = base;
  const fileUri = (p: string): vscode.Uri => vscode.Uri.file(path.join(repoRoot, p));

  switch (changed.status) {
    case 'M':
    case 'A':
    case 'U':
      await vscode.commands.executeCommand(
        'vscode.diff',
        makeGitUri(repoRoot, baseRef, changed.path),
        fileUri(changed.path),
        `${path.basename(changed.path)} (Revu)`,
        options
      );
      break;
    case 'X':
      await vscode.commands.executeCommand(
        'vscode.diff',
        makeGitUri(repoRoot, baseRef, changed.oldPath ?? changed.path),
        fileUri(changed.path),
        `${path.basename(changed.path)} (conflict)`,
        options
      );
      break;
    case 'D':
      await vscode.commands.executeCommand(
        'vscode.diff',
        makeGitUri(repoRoot, baseRef, changed.path),
        makeGitUri(repoRoot, EMPTY_REF, changed.path),
        `${path.basename(changed.path)} (deleted)`,
        options
      );
      break;
    case 'R': {
      const oldPath = changed.oldPath ?? changed.path;
      await vscode.commands.executeCommand(
        'vscode.diff',
        makeGitUri(repoRoot, baseRef, oldPath),
        fileUri(changed.path),
        `${path.basename(oldPath)} → ${path.basename(changed.path)}`,
        options
      );
      break;
    }
  }
}
