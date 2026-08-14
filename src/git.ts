import { execFile } from 'child_process';
import { createHash } from 'crypto';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
}

export const EMPTY_REF_SHA = '0000000000000000000000000000000000000000';

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
  const ref = (await git(cwd, ['symbolic-ref', 'HEAD'])).trim();
  return ref.replace(/^refs\/heads\//, '');
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

function parseNameStatus(output: string): ChangedFile[] {
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
  return files;
}

export async function changedFiles(
  cwd: string,
  baseRef: string,
  includeUntracked: boolean
): Promise<ChangedFile[]> {
  const output = await git(cwd, ['diff', '--name-status', '-M', baseRef]);
  const files = parseNameStatus(output);
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

export async function resolveRef(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch {
    return undefined;
  }
}

export async function updateRef(
  cwd: string,
  ref: string,
  newSha: string,
  oldSha?: string
): Promise<void> {
  const args = ['update-ref', ref, newSha];
  if (oldSha !== undefined) {
    args.push(oldSha);
  }
  await git(cwd, args);
}

export async function deleteRef(cwd: string, ref: string): Promise<void> {
  await git(cwd, ['update-ref', '-d', ref]);
}

export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 1) {
      return false;
    }
    throw err;
  }
}

export async function listCommits(
  cwd: string,
  range: string,
  maxCount?: number
): Promise<CommitInfo[]> {
  const args = ['log', '--first-parent', '--format=%H%x00%h%x00%s%x00%an%x00%cI'];
  if (maxCount !== undefined) {
    args.push(`--max-count=${maxCount}`);
  }
  args.push(range);
  const output = await git(cwd, args);
  const commits: CommitInfo[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [sha, shortSha, subject, author, date] = line.split('\0');
    commits.push({ sha, shortSha, subject, author, date });
  }
  return commits;
}

export async function commitChangedFiles(cwd: string, sha: string): Promise<ChangedFile[]> {
  const parent = await resolveRef(cwd, `${sha}^`);
  if (parent) {
    const output = await git(cwd, ['diff', '--name-status', '-M', `${sha}^`, sha]);
    return parseNameStatus(output);
  }
  const output = await git(cwd, [
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '-r',
    '--root',
    sha,
  ]);
  return parseNameStatus(output);
}

export async function isDetachedHead(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() === 'HEAD';
}

export async function gitDir(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).trim().length > 0;
}

