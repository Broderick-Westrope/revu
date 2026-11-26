import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommitFileNode, CommitNode, WorkingTreeFileNode, commitDiff } from '../checkpointTree';
import { ChangedFile, changedFiles } from '../git';
import { EMPTY_REF, GitUriQuery, REVU_GIT_SCHEME, makeGitUri } from '../gitContentProvider';
import { showDiff } from './openDiff';

export function clampLine(line: number, fileLineCount: number): number {
  if (fileLineCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(line, 0), fileLineCount - 1);
}

export type WorkingTreeTarget = { kind: 'file'; path: string } | { kind: 'missing' };

export function resolveWorkingTreeTarget(
  filePath: string,
  exists: (p: string) => boolean,
  changesSinceParent: ChangedFile[]
): WorkingTreeTarget {
  if (exists(filePath)) {
    return { kind: 'file', path: filePath };
  }
  const rename = changesSinceParent.find((f) => f.status === 'R' && f.oldPath === filePath);
  if (rename && exists(rename.path)) {
    return { kind: 'file', path: rename.path };
  }
  return { kind: 'missing' };
}

function parseGitUriQuery(uri: vscode.Uri): GitUriQuery | undefined {
  if (uri.scheme !== REVU_GIT_SCHEME) {
    return undefined;
  }
  try {
    return JSON.parse(uri.query) as GitUriQuery;
  } catch {
    return undefined;
  }
}

export async function openCommitFileDiff(node: CommitFileNode): Promise<void> {
  const context = { commitSha: node.commitSha, parentSha: node.parentSha };
  const leftPath = node.file.oldPath ?? node.file.path;
  await vscode.commands.executeCommand(
    'vscode.diff',
    makeGitUri(node.repoRoot, node.parentSha, leftPath, context),
    makeGitUri(node.repoRoot, node.commitSha, node.file.path, context),
    `${path.basename(node.file.path)} (${node.commitSha.slice(0, 7)})`
  );
}

export async function openCommitDiff(node: CommitNode): Promise<void> {
  const { files, parentSha } = await commitDiff(node);
  if (files.length === 0) {
    void vscode.window.showInformationMessage('Revu: commit has no changed files');
    return;
  }
  await openCommitFileDiff({
    kind: 'commitFile',
    file: files[0],
    commitSha: node.commit.sha,
    parentSha,
    repoRoot: node.repoRoot,
  });
}

export async function openWorkingTreeFileDiff(node: WorkingTreeFileNode): Promise<void> {
  await showDiff(node.file, { repoRoot: node.repoRoot, baseRef: node.checkpointSha });
}

export async function compareWithWorkingTree(node?: CommitFileNode): Promise<void> {
  let repoRoot: string;
  let filePath: string;
  let parentSha: string;
  let line: number | undefined;
  if (node && node.kind === 'commitFile') {
    repoRoot = node.repoRoot;
    filePath = node.file.path;
    parentSha = node.parentSha;
  } else {
    const editor = vscode.window.activeTextEditor;
    const query = editor ? parseGitUriQuery(editor.document.uri) : undefined;
    if (!editor || !query?.parentSha) {
      void vscode.window.showInformationMessage(
        'Revu: open a commit diff from the checkpoint view to compare with the working tree'
      );
      return;
    }
    repoRoot = query.repoRoot;
    filePath = query.path;
    parentSha = query.parentSha;
    line = editor.selection.active.line;
  }
  const changesSinceParent =
    parentSha === EMPTY_REF
      ? []
      : await changedFiles(repoRoot, parentSha, false).catch(() => [] as ChangedFile[]);
  const target = resolveWorkingTreeTarget(
    filePath,
    (p) => fs.existsSync(path.join(repoRoot, p)),
    changesSinceParent
  );
  if (target.kind === 'missing') {
    void vscode.window.showInformationMessage(
      `Revu: ${filePath} no longer exists in the working tree; showing its last content`
    );
    await showDiff({ path: filePath, status: 'D' }, { repoRoot, baseRef: parentSha });
    return;
  }
  let options: vscode.TextDocumentShowOptions | undefined;
  if (line !== undefined) {
    try {
      const content = fs.readFileSync(path.join(repoRoot, target.path), 'utf8');
      const clamped = clampLine(line, content.split('\n').length);
      options = { selection: new vscode.Range(clamped, 0, clamped, 0) };
    } catch {
      options = undefined;
    }
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    makeGitUri(repoRoot, parentSha, filePath),
    vscode.Uri.file(path.join(repoRoot, target.path)),
    `${path.basename(target.path)} (working tree)`,
    options
  );
}
