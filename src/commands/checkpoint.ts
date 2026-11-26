import * as vscode from 'vscode';
import {
  CheckpointState,
  getCheckpointState,
  markSafe,
  removeCheckpoint,
} from '../checkpoint';
import { CommitNode } from '../checkpointTree';
import {
  EMPTY_REF_SHA,
  defaultBranch,
  deleteRef,
  isAncestor,
  listCommits,
  mergeBase,
  repoRoot,
  resolveRef,
} from '../git';

export function expectedOldSha(state: CheckpointState): string | undefined {
  switch (state.kind) {
    case 'explicit':
    case 'orphaned':
      return state.sha;
    case 'implicit':
    case 'needsInit':
      return EMPTY_REF_SHA;
    case 'detached':
      return undefined;
  }
}

export function staleConflictRef(message: string): string | undefined {
  const match = /'(refs\/revu\/checkpoint\/[^']+)' exists/.exec(message);
  return match?.[1];
}

async function workspaceRepoRoot(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Revu: no workspace folder open');
    return undefined;
  }
  try {
    return await repoRoot(folder.uri.fsPath);
  } catch {
    void vscode.window.showErrorMessage('Revu: workspace is not a git repository');
    return undefined;
  }
}

async function markSafeAt(
  root: string,
  branch: string,
  sha: string,
  state: CheckpointState
): Promise<boolean> {
  const expected = expectedOldSha(state);
  if (expected === undefined) {
    void vscode.window.showErrorMessage('Revu: checkpoint is disabled on a detached HEAD');
    return false;
  }
  try {
    await markSafe(root, branch, sha, expected);
    return true;
  } catch (err) {
    const message = (err as Error).message;
    const conflict = staleConflictRef(message);
    if (conflict) {
      const action = await vscode.window.showErrorMessage(
        `Revu: cannot create the checkpoint ref because stale ref "${conflict}" is in the way. Delete it (or run "Revu: Remove Checkpoint" after checking out that branch name).`,
        'Delete stale ref'
      );
      if (action === 'Delete stale ref') {
        try {
          await deleteRef(root, conflict);
          await markSafe(root, branch, sha, expected);
        } catch (retryErr) {
          void vscode.window.showErrorMessage(
            `Revu: could not move checkpoint: ${(retryErr as Error).message}`
          );
          return false;
        }
            return true;
      }
      return false;
    }
    void vscode.window.showErrorMessage(`Revu: could not move checkpoint: ${message}`);
    return false;
  }
}

async function moveCheckpointTo(node: CommitNode, refresh: () => void): Promise<void> {
  const state = await getCheckpointState(node.repoRoot);
  if (state.kind === 'detached') {
    void vscode.window.showErrorMessage('Revu: checkpoint is disabled on a detached HEAD');
    return;
  }
  const branchTip = await resolveRef(node.repoRoot, `refs/heads/${state.branch}`);
  if (!branchTip || !(await isAncestor(node.repoRoot, node.commit.sha, branchTip))) {
    void vscode.window.showErrorMessage(
      `Revu: commit ${node.commit.shortSha} is not on branch "${state.branch}" — the checkpoint view may be stale. Refresh it and try again.`
    );
    return;
  }
  if (await markSafeAt(node.repoRoot, state.branch, node.commit.sha, state)) {
    refresh();
  }
}

export async function markSafeCommand(node: CommitNode, refresh: () => void): Promise<void> {
  await moveCheckpointTo(node, refresh);
}

export async function moveCheckpointCommand(node: CommitNode, refresh: () => void): Promise<void> {
  await moveCheckpointTo(node, refresh);
}

export async function setCheckpointCommand(refresh: () => void): Promise<void> {
  const root = await workspaceRepoRoot();
  if (!root) {
    return;
  }
  const state = await getCheckpointState(root);
  if (state.kind === 'detached') {
    void vscode.window.showErrorMessage('Revu: checkpoint is disabled on a detached HEAD');
    return;
  }
  const commits = (await listCommits(root, 'HEAD')).slice(0, 50);
  const items: (vscode.QuickPickItem & { sha: string })[] = commits.map((commit) => ({
    label: commit.subject,
    description: commit.shortSha,
    detail: `${commit.author} — ${commit.date}`,
    sha: commit.sha,
  }));
  try {
    const def = await defaultBranch(root);
    const base = await mergeBase(root, def);
    items.push({
      label: `Merge-base with ${def}`,
      description: base.slice(0, 7),
      sha: base,
    });
  } catch {}
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick the checkpoint commit (everything up to it counts as reviewed)',
  });
  if (!pick) {
    return;
  }
  if (await markSafeAt(root, state.branch, pick.sha, state)) {
    refresh();
  }
}

export async function removeCheckpointCommand(refresh: () => void): Promise<void> {
  const root = await workspaceRepoRoot();
  if (!root) {
    return;
  }
  const state = await getCheckpointState(root);
  if (state.kind === 'detached') {
    void vscode.window.showErrorMessage('Revu: checkpoint is disabled on a detached HEAD');
    return;
  }
  if (state.kind === 'implicit' || state.kind === 'needsInit') {
    void vscode.window.showInformationMessage('Revu: no checkpoint ref exists for this branch');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Remove the checkpoint for branch "${state.branch}"? Unreviewed state falls back to the merge-base.`,
    { modal: true },
    'Remove'
  );
  if (confirm !== 'Remove') {
    return;
  }
  await removeCheckpoint(root, state.branch);
  refresh();
}
