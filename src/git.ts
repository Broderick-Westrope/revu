import { execFile } from 'child_process';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U' | 'X';
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export const EMPTY_REF_SHA = '0000000000000000000000000000000000000000';

export function git(cwd: string, args: string[], okCodes: number[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: GIT_ENV }, (err, stdout) => {
      if (err && !okCodes.includes((err as { code?: number }).code ?? -1)) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function mergeTree(cwd: string, ours: string, theirs: string): Promise<string> {
  const output = await git(cwd, ['merge-tree', '--write-tree', ours, theirs], [1]);
  return output.split('\n')[0].trim();
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  const ref = (await git(cwd, ['symbolic-ref', 'HEAD'])).trim();
  return ref.replace(/^refs\/heads\//, '');
}

export async function checkedOutBranch(cwd: string): Promise<string | undefined> {
  const ref = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'], [1])).trim();
  return ref ? ref.replace(/^refs\/heads\//, '') : undefined;
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

export async function mergeBase(cwd: string, ref: string): Promise<string | undefined> {
  return (await git(cwd, ['merge-base', 'HEAD', ref], [1])).trim() || undefined;
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
    } else if (rawStatus === 'U') {
      files.push({ path: parts[1], status: 'X' });
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
  const conflicts = parseNameStatus(await git(cwd, ['diff', '--name-status', '--diff-filter=U']));
  for (const conflict of conflicts) {
    const existing = files.find((file) => file.path === conflict.path);
    if (existing) {
      existing.status = 'X';
    } else {
      files.push(conflict);
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
  const args = ['log', '--first-parent', '--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%P'];
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
    const [sha, shortSha, subject, author, date, parentsRaw] = line.split('\0');
    commits.push({ sha, shortSha, subject, author, date, parents: parentsRaw ? parentsRaw.split(' ') : [] });
  }
  return commits;
}

export async function commitChangedFiles(
  cwd: string,
  sha: string,
  baseRef?: string
): Promise<ChangedFile[]> {
  if (baseRef) {
    return parseNameStatus(await git(cwd, ['diff', '--name-status', '-M', baseRef, sha]));
  }
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
    let prunable = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktree = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length);
      } else if (line.startsWith('prunable')) {
        prunable = true;
      }
    }
    if (worktree === undefined || (prunable && main)) {
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
