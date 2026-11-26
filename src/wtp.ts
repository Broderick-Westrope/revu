import { execFile } from 'child_process';
import { listWorktrees } from './git';

function wtp(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'wtp',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stderr }));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

export async function addWorktree(repoRoot: string, branch: string): Promise<string | undefined> {
  await wtp(repoRoot, ['add', branch]);
  return (await listWorktrees(repoRoot)).byBranch.get(branch);
}
