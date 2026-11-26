import { git, isAncestor, resolveRef } from './git';

export interface Worktrees {
  main: string;
  byBranch: Map<string, string>;
}

export async function listWorktrees(cwd: string): Promise<Worktrees> {
  const output = await git(cwd, ['worktree', 'list', '--porcelain']);
  let main = '';
  const byBranch = new Map<string, string>();
  for (const block of output.split('\n\n')) {
    let worktree: string | undefined;
    let branch: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktree = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (worktree === undefined) {
      continue;
    }
    if (!main) {
      main = worktree;
    }
    if (branch !== undefined) {
      byBranch.set(branch, worktree);
    }
  }
  return { main, byBranch };
}

export async function hasTrackedChanges(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
}

export async function aheadBehind(
  cwd: string,
  parentRef: string,
  branch: string
): Promise<{ ahead: number; behind: number }> {
  const output = await git(cwd, ['rev-list', '--left-right', '--count', `${parentRef}...${branch}`]);
  const [behind, ahead] = output.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

export interface SwitchInput {
  target: string;
  trunk: string;
  current?: string;
  currentWorktree: string;
  worktrees: Worktrees;
  dirty: boolean;
}

export type SwitchPlan =
  | { kind: 'none' }
  | { kind: 'openFolder'; path: string }
  | { kind: 'switch' }
  | { kind: 'offerWorktree' };

export function planSwitch(input: SwitchInput): SwitchPlan {
  if (input.target === input.current) {
    return { kind: 'none' };
  }
  if (input.target === input.trunk && input.worktrees.main !== input.currentWorktree) {
    return { kind: 'openFolder', path: input.worktrees.main };
  }
  const elsewhere = input.worktrees.byBranch.get(input.target);
  if (elsewhere !== undefined && elsewhere !== input.currentWorktree) {
    return { kind: 'openFolder', path: elsewhere };
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
