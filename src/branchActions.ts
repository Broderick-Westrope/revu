import { git } from './git';

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
