import * as vscode from 'vscode';
import { startReview, endReview, refreshPrThreads } from './commands/startReview';
import { openDiff } from './commands/openDiff';
import { generateGuide } from './commands/generateGuide';
import { registerComments } from './comments/controller';
import { CommentStore } from './comments/store';
import { GitContentProvider, REVU_GIT_SCHEME } from './gitContentProvider';
import { GithubThreadRenderer } from './github/threadRenderer';
import { GuideCache } from './guide/cache';
import { registerGuideTree } from './guide/treeView';

export function activate(context: vscode.ExtensionContext): void {
  const guideCache = new GuideCache(context.workspaceState);
  const renderer = new GithubThreadRenderer();
  context.subscriptions.push(
    renderer,
    vscode.workspace.registerTextDocumentContentProvider(REVU_GIT_SCHEME, new GitContentProvider()),
    vscode.commands.registerCommand('revu.startReview', () => startReview(renderer)),
    vscode.commands.registerCommand('revu.endReview', () => endReview(renderer)),
    vscode.commands.registerCommand('revu.refreshPrThreads', () => refreshPrThreads(renderer)),
    vscode.commands.registerCommand('revu.openDiff', openDiff),
    vscode.commands.registerCommand('revu.generateGuide', () => generateGuide(guideCache))
  );
  const store = new CommentStore(context.workspaceState);
  registerComments(context, store);
  registerGuideTree(context, guideCache);
  void vscode.commands.executeCommand('setContext', 'revu.reviewActive', false);
}

export function deactivate(): void {}
