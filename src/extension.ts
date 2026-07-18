import * as vscode from 'vscode';
import { startReview, endReview } from './commands/startReview';
import { openDiff } from './commands/openDiff';
import { generateGuide } from './commands/generateGuide';
import { registerComments } from './comments/controller';
import { CommentStore } from './comments/store';
import { GitContentProvider, REVU_GIT_SCHEME } from './gitContentProvider';
import { GuideCache } from './guide/cache';

export function activate(context: vscode.ExtensionContext): void {
  const guideCache = new GuideCache(context.workspaceState);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REVU_GIT_SCHEME, new GitContentProvider()),
    vscode.commands.registerCommand('revu.startReview', startReview),
    vscode.commands.registerCommand('revu.endReview', endReview),
    vscode.commands.registerCommand('revu.openDiff', openDiff),
    vscode.commands.registerCommand('revu.generateGuide', () => generateGuide(guideCache))
  );
  const store = new CommentStore(context.workspaceState);
  registerComments(context, store);
}

export function deactivate(): void {}
