import * as vscode from 'vscode';
import { startReview, endReview } from './commands/startReview';
import { openDiff } from './commands/openDiff';
import { GitContentProvider, REVU_GIT_SCHEME } from './gitContentProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REVU_GIT_SCHEME, new GitContentProvider()),
    vscode.commands.registerCommand('revu.startReview', startReview),
    vscode.commands.registerCommand('revu.endReview', endReview),
    vscode.commands.registerCommand('revu.openDiff', openDiff)
  );
}

export function deactivate(): void {}
