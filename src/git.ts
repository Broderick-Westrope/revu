import { execFile } from 'child_process';
import { createHash } from 'crypto';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function defaultBranch(cwd: string): Promise<string> {
  try {
    const ref = (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    return ref.replace(/^origin\//, '');
  } catch {
    for (const candidate of ['main', 'master']) {
      try {
        await git(cwd, ['rev-parse', '--verify', candidate]);
        return candidate;
      } catch {
        continue;
      }
    }
    throw new Error('Could not determine default branch');
  }
}

export async function mergeBase(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['merge-base', 'HEAD', ref])).trim();
}

export async function changedFiles(
  cwd: string,
  baseRef: string,
  includeUntracked: boolean
): Promise<ChangedFile[]> {
  const output = await git(cwd, ['diff', '--name-status', '-M', baseRef]);
  const files: ChangedFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const rawStatus = parts[0];
    if (rawStatus.startsWith('R')) {
      files.push({ oldPath: parts[1], path: parts[2], status: 'R' });
    } else if (rawStatus === 'A' || rawStatus === 'M' || rawStatus === 'D') {
      files.push({ path: parts[1], status: rawStatus });
    }
  }
  if (includeUntracked) {
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
    for (const line of untracked.split('\n')) {
      if (line.trim()) {
        files.push({ path: line, status: 'U' });
      }
    }
  }
  return files;
}

export async function showFile(cwd: string, ref: string, path: string): Promise<string> {
  return git(cwd, ['show', `${ref}:${path}`]);
}

export async function nameStatusHash(
  cwd: string,
  baseRef: string,
  includeUntracked: boolean
): Promise<string> {
  const nameStatus = await git(cwd, ['diff', '--name-status', '-M', baseRef]);
  let input = nameStatus;
  if (includeUntracked) {
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
    input += '\n' + untracked;
  }
  return createHash('sha256').update(input).digest('hex');
}

export async function diffText(cwd: string, baseRef: string, path?: string): Promise<string> {
  const args = ['diff', baseRef];
  if (path) {
    args.push('--', path);
  }
  return git(cwd, args);
}
