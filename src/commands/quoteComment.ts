import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { CommentManager } from '../comments/controller';
import { LocalComment } from '../comments/model';
import { getCommentSource } from '../github/threadRenderer';

export async function quoteComment(
  manager: CommentManager,
  comment: vscode.Comment | undefined
): Promise<void> {
  const source = comment ? getCommentSource(comment) : undefined;
  if (!source) {
    void vscode.window.showWarningMessage('Revu: could not find the GitHub comment to quote.');
    return;
  }
  const text = await vscode.window.showInputBox({
    prompt: 'Your local comment (the GitHub comment and its code context will be attached)',
  });
  if (!text) {
    return;
  }
  let startLine = source.range.start.line;
  let endLine = source.range.end.line;
  let codeSnippet = '';
  let languageId = 'plaintext';
  try {
    const document = await vscode.workspace.openTextDocument(source.uri);
    endLine = Math.min(endLine, document.lineCount - 1);
    startLine = Math.min(startLine, endLine);
    codeSnippet = document.getText(
      new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length)
    );
    languageId = document.languageId;
  } catch {
    codeSnippet = '';
  }
  const local: LocalComment = {
    id: randomUUID(),
    path: source.thread.path,
    startLine: startLine + 1,
    endLine: endLine + 1,
    codeSnippet,
    languageId,
    text,
    createdAt: new Date().toISOString(),
    quotedThread: {
      author: source.comment.author,
      body: source.comment.body,
      path: source.thread.path,
      line: source.thread.line ?? undefined,
      diffHunk: source.thread.diffHunk || undefined,
      url: source.comment.url,
    },
  };
  manager.addComment(local);
  void vscode.window.showInformationMessage('Revu: quoted into a local comment.');
}
