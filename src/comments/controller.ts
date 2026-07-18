import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LocalComment } from './model';
import { CommentStore } from './store';

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

  constructor(private readonly store: CommentStore) {
    this.controller = vscode.comments.createCommentController('revu-local', 'Revu (Local)');
    this.controller.options = {
      placeHolder: 'Leave a local review comment…',
      prompt: 'Local only — never posted to GitHub',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
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

  restore(): void {
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

  async createComment(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread;
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
    this.store.add(comment);
    thread.comments = [...thread.comments, toVsCodeComment(comment)];
    thread.label = 'Local';
    thread.contextValue = 'revuLocal';
    this.threads.set(comment.id, thread);
  }

  deleteComment(thread: vscode.CommentThread): void {
    for (const [id, tracked] of this.threads) {
      if (tracked === thread) {
        this.store.remove(id);
        this.threads.delete(id);
      }
    }
    thread.dispose();
  }

  async clearAllComments(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      'Delete all local review comments? This cannot be undone.',
      { modal: true },
      'Delete All'
    );
    if (confirmation !== 'Delete All') {
      return;
    }
    this.store.clear();
    for (const thread of this.threads.values()) {
      thread.dispose();
    }
    this.threads.clear();
  }

  commentsForThread(thread: vscode.CommentThread): LocalComment[] {
    const ids = new Set(
      [...this.threads].filter(([, tracked]) => tracked === thread).map(([id]) => id)
    );
    return this.store.all().filter((c) => ids.has(c.id));
  }

  dispose(): void {
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
    vscode.commands.registerCommand('revu.clearAllComments', () => manager.clearAllComments())
  );
  manager.restore();
  return manager;
}
