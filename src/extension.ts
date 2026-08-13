import * as vscode from 'vscode';
import { startReview, endReview, refreshPrThreads } from './commands/startReview';
import { openDiff } from './commands/openDiff';
import { generateGuide } from './commands/generateGuide';
import { quoteComment } from './commands/quoteComment';
import { registerComments } from './comments/controller';
import { CommentStore } from './comments/store';
import { repoRoot } from './git';
import { GitContentProvider, REVU_GIT_SCHEME } from './gitContentProvider';
import { registerGitWatcher } from './gitWatcher';
import { GithubThreadRenderer } from './github/threadRenderer';
import { GuideCache, guideDisposables } from './guide/cache';
import { registerGuideTree } from './guide/treeView';
import { registerGuideWebview } from './guide/webview';
import { scopeDisposables } from './scope';

let gitStateEvent: vscode.Event<void> | undefined;

export function onDidChangeGitState(): vscode.Event<void> | undefined {
  return gitStateEvent;
}

export function activate(context: vscode.ExtensionContext): void {
  const guideCache = new GuideCache(context.workspaceState);
  const renderer = new GithubThreadRenderer();
  context.subscriptions.push(
    renderer,
    ...scopeDisposables(),
    ...guideDisposables(),
    vscode.workspace.registerTextDocumentContentProvider(REVU_GIT_SCHEME, new GitContentProvider()),
    vscode.commands.registerCommand('revu.startReview', () => startReview(renderer)),
    vscode.commands.registerCommand('revu.endReview', () => endReview(renderer)),
    vscode.commands.registerCommand('revu.refreshPrThreads', () => refreshPrThreads(renderer)),
    vscode.commands.registerCommand('revu.openDiff', openDiff),
    vscode.commands.registerCommand('revu.generateGuide', () => generateGuide(guideCache))
  );
  const store = new CommentStore(context.workspaceState);
  const manager = registerComments(context, store);
  context.subscriptions.push(
    vscode.commands.registerCommand('revu.quoteComment', (comment: vscode.Comment | undefined) =>
      quoteComment(manager, comment)
    )
  );
  registerGuideTree(context, guideCache);
  registerGuideWebview(context, guideCache);
  void vscode.commands.executeCommand('setContext', 'revu.reviewActive', false);
  void (async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    let root: string;
    try {
      root = await repoRoot(folder.uri.fsPath);
    } catch {
      return;
    }
    gitStateEvent = registerGitWatcher(context, root);
  })();
}

export function deactivate(): void {}
