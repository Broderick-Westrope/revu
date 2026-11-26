import {
  CommitInfo,
  EMPTY_REF_SHA,
  currentBranch,
  deleteRef,
  isAncestor,
  isDetachedHead,
  listCommits,
  resolveRef,
  updateRef,
} from './git';

export const CHECKPOINT_REF_PREFIX = 'refs/revu/checkpoint/';

export function checkpointRef(branch: string): string {
  return CHECKPOINT_REF_PREFIX + branch;
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export type CheckpointState =
  | { kind: 'explicit'; branch: string; sha: string }
  | { kind: 'implicit'; branch: string; sha: string }
  | { kind: 'needsInit'; branch: string }
  | { kind: 'orphaned'; branch: string; sha: string }
  | { kind: 'detached' };

export async function getCheckpointState(
  repoRoot: string,
  implicitBase: string | undefined
): Promise<CheckpointState> {
  if (await isDetachedHead(repoRoot)) {
    return { kind: 'detached' };
  }
  const branch = await currentBranch(repoRoot);
  const sha = await resolveRef(repoRoot, checkpointRef(branch));
  if (sha) {
    const branchTip = await resolveRef(repoRoot, branchRef(branch));
    if (branchTip && (await isAncestor(repoRoot, sha, branchTip))) {
      return { kind: 'explicit', branch, sha };
    }
    return { kind: 'orphaned', branch, sha };
  }
  if (!implicitBase) {
    return { kind: 'needsInit', branch };
  }
  const branchTip = await resolveRef(repoRoot, branchRef(branch));
  if (implicitBase === branchTip) {
    return { kind: 'needsInit', branch };
  }
  return { kind: 'implicit', branch, sha: implicitBase };
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
  return listCommits(repoRoot, `${checkpointSha}..${branchRef(branch)}`);
}

export const REVIEWED_COMMITS_CAP = 25;

export interface ReviewedCommits {
  commits: CommitInfo[];
  truncated: boolean;
}

export async function reviewedCommits(
  repoRoot: string,
  checkpointSha: string,
  implicitBase: string | undefined
): Promise<ReviewedCommits> {
  const range = implicitBase ? `${implicitBase}..${checkpointSha}` : checkpointSha;
  const commits = await listCommits(repoRoot, range, REVIEWED_COMMITS_CAP + 1);
  return {
    commits: commits.slice(0, REVIEWED_COMMITS_CAP),
    truncated: commits.length > REVIEWED_COMMITS_CAP,
  };
}
