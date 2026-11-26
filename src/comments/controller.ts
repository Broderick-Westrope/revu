import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { renderAll, renderComment } from './export';
import { LocalComment } from './model';
import { CommentStore } from './store';

const DETACHED_MESSAGE = 'Revu: check out a branch to leave local comments (HEAD is detached).';

function toVsCodeComment(comment: LocalComment): vscode.Comment {
  return {
    body: new vscode.MarkdownString(comment.text),
    mode: vscode.CommentMode.Preview,
    author: { name: 'You (local)' },
  };
}

export class CommentManager implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly storeListener: vscode.Disposable;
  private renderedBranch: string | undefined;

  constructor(private readonly store: CommentStore) {
    this.controller = vscode.comments.createCommentController('revu-local', 'Revu (Local)');
    this.controller.options = {
      placeHolder: 'Leave a local review comment…',
      prompt: 'Local only — never posted to GitHub',
    };
    this.setCommentingRanges();
    this.storeListener = store.onDidChange(() => {
      if (store.currentBranch !== this.renderedBranch) {
        this.restore();
        this.setCommentingRanges();
      }
    });
  }

  private setCommentingRanges(): void {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (this.store.currentBranch === undefined) {
          return [];
        }
        if (document.uri.scheme !== 'file') {
          return [];
        }
        if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
          return [];
        }
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      },
    };
  }

  private disposeThreads(): void {
    for (const thread of new Set(this.threads.values())) {
      thread.dispose();
    }
    this.threads.clear();
  }

  restore(): void {
    this.disposeThreads();
    this.renderedBranch = this.store.currentBranch;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    for (const comment of this.store.all()) {
      const absolutePath = path.join(folder.uri.fsPath, comment.path);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      const range = new vscode.Range(comment.startLine - 1, 0, comment.endLine - 1, 0);
      const thread = this.controller.createCommentThread(vscode.Uri.file(absolutePath), range, [
        toVsCodeComment(comment),
      ]);
      thread.label = 'Local';
      thread.contextValue = 'revuLocal';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      this.threads.set(comment.id, thread);
    }
  }

  addComment(comment: LocalComment): boolean {
    if (this.store.currentBranch === undefined) {
      void vscode.window.showWarningMessage(DETACHED_MESSAGE);
      return false;
    }
    void this.store.add(comment);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return true;
    }
    const absolutePath = path.join(folder.uri.fsPath, comment.path);
    const range = new vscode.Range(comment.startLine - 1, 0, comment.endLine - 1, 0);
    const thread = this.controller.createCommentThread(vscode.Uri.file(absolutePath), range, [
      toVsCodeComment(comment),
    ]);
    thread.label = 'Local';
    thread.contextValue = 'revuLocal';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.threads.set(comment.id, thread);
    return true;
  }

  async createComment(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread;
    if (this.store.currentBranch === undefined) {
      void vscode.window.showWarningMessage(DETACHED_MESSAGE);
      return;
    }
    const document = await vscode.workspace.openTextDocument(thread.uri);
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    const startLine = range.start.line;
    const endLine = Math.min(range.end.line, document.lineCount - 1);
    const snippet = document.getText(
      new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length)
    );
    const comment: LocalComment = {
      id: randomUUID(),
      path: vscode.workspace.asRelativePath(thread.uri, false),
      startLine: startLine + 1,
      endLine: endLine + 1,
      codeSnippet: snippet,
      languageId: document.languageId,
      text: reply.text,
      createdAt: new Date().toISOString(),
    };
    await this.store.add(comment);
    thread.comments = [...thread.comments, toVsCodeComment(comment)];
    thread.label = 'Local';
    thread.contextValue = 'revuLocal';
    this.threads.set(comment.id, thread);
  }

  deleteComment(thread: vscode.CommentThread): void {
    for (const [id, tracked] of this.threads) {
      if (tracked === thread) {
        void this.store.remove(id);
        this.threads.delete(id);
      }
    }
    thread.dispose();
  }

  async clearAllComments(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      `Delete all local review comments on ${this.store.currentBranch ?? 'this branch'}? This cannot be undone.`,
      { modal: true },
      'Delete All'
    );
    if (confirmation !== 'Delete All') {
      return;
    }
    await this.store.clear();
    this.disposeThreads();
  }

  commentsForThread(thread: vscode.CommentThread): LocalComment[] {
    const ids = new Set(
      [...this.threads].filter(([, tracked]) => tracked === thread).map(([id]) => id)
    );
    return this.store.all().filter((c) => ids.has(c.id));
  }

  dispose(): void {
    this.storeListener.dispose();
    this.controller.dispose();
  }
}

export function registerComments(
  context: vscode.ExtensionContext,
  store: CommentStore
): CommentManager {
  const manager = new CommentManager(store);
  context.subscriptions.push(
    manager,
    vscode.commands.registerCommand('revu.createComment', (reply: vscode.CommentReply) =>
      manager.createComment(reply)
    ),
    vscode.commands.registerCommand('revu.deleteComment', (thread: vscode.CommentThread) =>
      manager.deleteComment(thread)
    ),
    vscode.commands.registerCommand('revu.clearAllComments', () => manager.clearAllComments()),
    vscode.commands.registerCommand('revu.copyAllComments', async () => {
      const comments = store.all();
      if (comments.length === 0) {
        void vscode.window.showWarningMessage('Revu: no local comments to copy.');
        return;
      }
      await vscode.env.clipboard.writeText(renderAll(comments));
      const noun = comments.length === 1 ? 'comment' : 'comments';
      void vscode.window.showInformationMessage(
        `Revu: copied ${comments.length} ${noun} to the clipboard.`
      );
    }),
    vscode.commands.registerCommand(
      'revu.copyComment',
      async (thread: vscode.CommentThread) => {
        const comments = manager.commentsForThread(thread);
        const first = comments[0];
        if (!first) {
          void vscode.window.showWarningMessage('Revu: no local comment found for this thread.');
          return;
        }
        const rendered = comments.map((c, i) => renderComment(c, i + 1)).join('\n\n');
        await vscode.env.clipboard.writeText(
          `# Review comments\n\n## ${first.path}\n\n${rendered}\n`
        );
        void vscode.window.showInformationMessage('Revu: comment copied to the clipboard.');
      }
    )
  );
  manager.restore();
  return manager;
}
