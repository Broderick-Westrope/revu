import { checkpointRef } from './checkpoint';
import {
  Worktrees,
  git,
  hasTrackedChanges,
  isAncestor,
  listWorktrees,
  resolveRef,
  updateRef,
} from './git';

export interface SwitchInput {
  target: string;
  trunk: string;
  current?: string;
  currentWorktree: string;
  worktrees: Worktrees;
  dirty: boolean;
  sameGhStack: boolean;
}

export type SwitchPlan =
  | { kind: 'none' }
  | { kind: 'openFolder'; path: string }
  | { kind: 'switch' }
  | { kind: 'offerWorktree' }
  | { kind: 'createWorktree' }
  | { kind: 'refuseDirty' };

export function planSwitch(input: SwitchInput): SwitchPlan {
  if (input.target === input.current) {
    return { kind: 'none' };
  }
  if (input.target === input.trunk) {
    if (input.worktrees.main !== input.currentWorktree) {
      return { kind: 'openFolder', path: input.worktrees.main };
    }
    return input.dirty ? { kind: 'refuseDirty' } : { kind: 'switch' };
  }
  const elsewhere = input.worktrees.byBranch.get(input.target);
  if (elsewhere !== undefined && elsewhere !== input.currentWorktree) {
    return { kind: 'openFolder', path: elsewhere };
  }
  if (!input.sameGhStack) {
    return { kind: 'createWorktree' };
  }
  return input.dirty ? { kind: 'offerWorktree' } : { kind: 'switch' };
}

export type PullResult =
  | { kind: 'fastForwarded' }
  | { kind: 'upToDate' }
  | { kind: 'stayedBehind'; reason: 'dirty' | 'diverged' }
  | { kind: 'stayedBehind'; reason: 'notOnTrunk'; branch?: string };

export async function pullDefaultBranch(cwd: string, trunk: string): Promise<PullResult> {
  await git(cwd, ['fetch', 'origin']);
  const upstream = `origin/${trunk}`;
  const local = await resolveRef(cwd, `refs/heads/${trunk}`);
  if (local && (await isAncestor(cwd, upstream, local))) {
    return { kind: 'upToDate' };
  }
  const worktrees = await listWorktrees(cwd);
  if (worktrees.byBranch.get(trunk) !== worktrees.main) {
    const branch = [...worktrees.byBranch].find(([, dir]) => dir === worktrees.main)?.[0];
    return { kind: 'stayedBehind', reason: 'notOnTrunk', branch };
  }
  if (await hasTrackedChanges(worktrees.main)) {
    return { kind: 'stayedBehind', reason: 'dirty' };
  }
  try {
    await git(worktrees.main, ['merge', '--ff-only', upstream]);
  } catch {
    return { kind: 'stayedBehind', reason: 'diverged' };
  }
  return { kind: 'fastForwarded' };
}

export interface MergeTarget {
  branch: string;
  parent: string;
  parentRef: string;
}

export type MergeResult =
  | { kind: 'dirty' }
  | { kind: 'upToDate' }
  | { kind: 'conflict' }
  | { kind: 'merged'; checkpointMoved: boolean };

export async function mergeParent(
  cwd: string,
  target: MergeTarget,
  trunk: string
): Promise<MergeResult> {
  if (await hasTrackedChanges(cwd)) {
    return { kind: 'dirty' };
  }
  if (target.parent === trunk && target.parentRef === `origin/${trunk}`) {
    await git(cwd, ['fetch', 'origin']);
  }
  const before = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  try {
    await git(cwd, ['merge', '--no-edit', target.parentRef]);
  } catch (err) {
    if (await resolveRef(cwd, 'MERGE_HEAD')) {
      return { kind: 'conflict' };
    }
    throw err;
  }
  const after = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (after === before) {
    return { kind: 'upToDate' };
  }
  const ref = checkpointRef(target.branch);
  if ((await resolveRef(cwd, ref)) !== before) {
    return { kind: 'merged', checkpointMoved: false };
  }
  await updateRef(cwd, ref, after, before);
  return { kind: 'merged', checkpointMoved: true };
}

