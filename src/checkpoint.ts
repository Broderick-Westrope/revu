import {
  ChangedFile,
  CommitInfo,
  EMPTY_REF_SHA,
  changedFiles,
  currentBranch,
  defaultBranch,
  deleteRef,
  hasUncommittedChanges,
  isAncestor,
  isDetachedHead,
  listCommits,
  mergeBase,
  resolveRef,
  updateRef,
} from './git';

export const CHECKPOINT_REF_PREFIX = 'refs/revu/checkpoint/';

export function checkpointRef(branch: string): string {
  return CHECKPOINT_REF_PREFIX + branch;
}

export type CheckpointState =
  | { kind: 'explicit'; branch: string; sha: string }
  | { kind: 'implicit'; branch: string; sha: string }
  | { kind: 'needsInit'; branch: string; reason: 'noDefaultBranch' | 'onDefaultBranch' }
  | { kind: 'orphaned'; branch: string; sha: string }
  | { kind: 'detached' };

export async function getCheckpointState(repoRoot: string): Promise<CheckpointState> {
  if (await isDetachedHead(repoRoot)) {
    return { kind: 'detached' };
  }
  const branch = await currentBranch(repoRoot);
  const sha = await resolveRef(repoRoot, checkpointRef(branch));
  if (sha) {
    const branchTip = await resolveRef(repoRoot, branch);
    if (branchTip && (await isAncestor(repoRoot, sha, branchTip))) {
      return { kind: 'explicit', branch, sha };
    }
    return { kind: 'orphaned', branch, sha };
  }
  let base: string;
  try {
    const def = await defaultBranch(repoRoot);
    if (branch === def) {
      return { kind: 'needsInit', branch, reason: 'onDefaultBranch' };
    }
    base = await mergeBase(repoRoot, def);
  } catch {
    return { kind: 'needsInit', branch, reason: 'noDefaultBranch' };
  }
  const branchTip = await resolveRef(repoRoot, branch);
  if (base === branchTip) {
    return { kind: 'needsInit', branch, reason: 'onDefaultBranch' };
  }
  return { kind: 'implicit', branch, sha: base };
}

export async function markSafe(
  repoRoot: string,
  branch: string,
  sha: string,
  expectedOldSha?: string
): Promise<void> {
  await updateRef(repoRoot, checkpointRef(branch), sha, expectedOldSha ?? EMPTY_REF_SHA);
}

export async function removeCheckpoint(repoRoot: string, branch: string): Promise<void> {
  await deleteRef(repoRoot, checkpointRef(branch));
}

export async function unreviewedCommits(
  repoRoot: string,
  checkpointSha: string,
  branch: string
): Promise<CommitInfo[]> {
  return listCommits(repoRoot, `${checkpointSha}..${branch}`);
}

export async function workingTreeSummary(
  repoRoot: string,
  checkpointSha: string
): Promise<{ files: ChangedFile[]; dirty: boolean }> {
  const files = await changedFiles(repoRoot, checkpointSha, true);
  const dirty = await hasUncommittedChanges(repoRoot);
  return { files, dirty };
}
