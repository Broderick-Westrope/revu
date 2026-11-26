import { GIT_ENV, listWorktrees } from './git';
import { run } from './exec';

export async function addWorktree(repoRoot: string, branch: string): Promise<string | undefined> {
  await run('wtp', ['add', branch], { cwd: repoRoot, env: GIT_ENV });
  return (await listWorktrees(repoRoot)).byBranch.get(branch);
}
