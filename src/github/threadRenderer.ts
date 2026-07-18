import * as path from 'path';
import * as vscode from 'vscode';
import { GhReviewThread, GhThreadComment } from './model';

export interface GhCommentSource {
  thread: GhReviewThread;
  comment: GhThreadComment;
  uri: vscode.Uri;
  range: vscode.Range;
}

const commentSources = new WeakMap<vscode.Comment, GhCommentSource>();

export function getCommentSource(comment: vscode.Comment): GhCommentSource | undefined {
  return commentSources.get(comment);
}

export interface RenderResult {
  shown: number;
  skipped: number;
}

function toBody(comment: GhThreadComment, diffHunk: string): vscode.MarkdownString {
  const parts = [comment.body];
  if (diffHunk) {
    parts.push('', '```diff', diffHunk, '```');
  }
  return new vscode.MarkdownString(parts.join('\n'));
}

export class GithubThreadRenderer implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private threads: vscode.CommentThread[] = [];

  constructor() {
    this.controller = vscode.comments.createCommentController(
      'revu-github',
      'GitHub (read-only)'
    );
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: () => [],
    };
  }

  renderThreads(repoRoot: string, threads: GhReviewThread[]): RenderResult {
    this.clear();
    let shown = 0;
    let skipped = 0;
    for (const thread of threads) {
      if (thread.line === null) {
        skipped += 1;
        continue;
      }
      const startLine = thread.startLine ?? thread.line;
      const range = new vscode.Range(startLine - 1, 0, thread.line - 1, 0);
      const uri = vscode.Uri.file(path.join(repoRoot, thread.path));
      const comments = thread.comments.map((comment) => {
        const rendered: vscode.Comment = {
          body: toBody(comment, thread.diffHunk),
          mode: vscode.CommentMode.Preview,
          author: { name: `@${comment.author} (GitHub)` },
        };
        commentSources.set(rendered, { thread, comment, uri, range });
        return rendered;
      });
      const vsThread = this.controller.createCommentThread(uri, range, comments);
      vsThread.canReply = false;
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      vsThread.label = thread.isResolved ? 'GitHub · resolved' : 'GitHub';
      vsThread.contextValue = 'revuGithub';
      this.threads.push(vsThread);
      shown += 1;
    }
    return { shown, skipped };
  }

  clear(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}
