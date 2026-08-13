import * as vscode from 'vscode';
import { showFile } from './git';

export const REVU_GIT_SCHEME = 'revu-git';

export interface GitUriQuery {
  ref: string;
  repoRoot: string;
  path: string;
  commitSha?: string;
  parentSha?: string;
}

export function makeGitUri(
  repoRoot: string,
  ref: string,
  path: string,
  context?: { commitSha: string; parentSha: string }
): vscode.Uri {
  const query: GitUriQuery = { ref, repoRoot, path, ...context };
  return vscode.Uri.from({
    scheme: REVU_GIT_SCHEME,
    path: '/' + path,
    query: JSON.stringify(query),
  });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let query: GitUriQuery;
    try {
      query = JSON.parse(uri.query) as GitUriQuery;
    } catch {
      return '';
    }
    if (query.ref === 'EMPTY') {
      return '';
    }
    try {
      return await showFile(query.repoRoot, query.ref, query.path);
    } catch {
      return '';
    }
  }
}
