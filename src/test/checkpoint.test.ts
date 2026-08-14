import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  REVIEWED_COMMITS_CAP,
  getCheckpointState,
  markSafe,
  removeCheckpoint,
  reviewedCommits,
  unreviewedCommits,
  workingTreeSummary,
} from '../checkpoint';

function run(cwd: string, cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function git(cwd: string, args: string[]): Promise<string> {
  return run(cwd, 'git', args);
}

const repos: string[] = [];

async function makeRepo(defaultBranchName = 'main'): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-checkpoint-test-'));
  repos.push(repo);
  await git(repo, ['init', '-b', defaultBranchName]);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base content\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base commit']);
  return repo;
}

async function commitFile(repo: string, name: string, content: string): Promise<string> {
  fs.writeFileSync(path.join(repo, name), content);
  await git(repo, ['add', name]);
  await git(repo, ['commit', '-m', `add ${name}`]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

suite('checkpoint state', () => {
  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('implicit state on a fresh branch uses the merge-base with the default branch', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const state = await getCheckpointState(repo);
    assert.deepStrictEqual(state, { kind: 'implicit', branch: 'feature', sha: mainTip });
  });

  test('explicit state after markSafe', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', c2);
    const state = await getCheckpointState(repo);
    assert.deepStrictEqual(state, { kind: 'explicit', branch: 'feature', sha: c2 });
  });

  test('state re-derives after an external update-ref', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', c2);
    assert.deepStrictEqual(await getCheckpointState(repo), {
      kind: 'explicit',
      branch: 'feature',
      sha: c2,
    });
    await git(repo, ['update-ref', 'refs/revu/checkpoint/feature', mainTip]);
    assert.deepStrictEqual(await getCheckpointState(repo), {
      kind: 'explicit',
      branch: 'feature',
      sha: mainTip,
    });
  });

  test('orphaned state after the marked commit is rewritten', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', c2);
    await git(repo, ['commit', '--amend', '-m', 'rewritten']);
    const state = await getCheckpointState(repo);
    assert.deepStrictEqual(state, { kind: 'orphaned', branch: 'feature', sha: c2 });
  });

  test('detached state after checkout --detach', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '--detach']);
    assert.deepStrictEqual(await getCheckpointState(repo), { kind: 'detached' });
  });

  test('needsInit when no default branch can be determined', async () => {
    const repo = await makeRepo('trunk');
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const state = await getCheckpointState(repo);
    assert.deepStrictEqual(state, {
      kind: 'needsInit',
      branch: 'feature',
      reason: 'noDefaultBranch',
    });
  });

  test('needsInit when on the default branch', async () => {
    const repo = await makeRepo();
    const state = await getCheckpointState(repo);
    assert.deepStrictEqual(state, { kind: 'needsInit', branch: 'main', reason: 'onDefaultBranch' });
  });

  test('needsInit when the merge-base equals the branch tip', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const state = await getCheckpointState(repo);
    assert.deepStrictEqual(state, {
      kind: 'needsInit',
      branch: 'feature',
      reason: 'onDefaultBranch',
    });
  });

  test('markSafe with a stale expected old SHA rejects', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    await markSafe(repo, 'feature', c2);
    await assert.rejects(markSafe(repo, 'feature', c3, mainTip));
    await markSafe(repo, 'feature', c3, c2);
    assert.deepStrictEqual(await getCheckpointState(repo), {
      kind: 'explicit',
      branch: 'feature',
      sha: c3,
    });
  });

  test('markSafe rejects when creating a ref that already exists', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', c2);
    await assert.rejects(markSafe(repo, 'feature', c2));
  });

  test('markSafe surfaces a directory/file ref conflict with the conflicting ref named', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await markSafe(repo, 'foo', mainTip);
    await git(repo, ['checkout', '-b', 'foo/bar']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await assert.rejects(markSafe(repo, 'foo/bar', c2), (err: Error) => {
      assert.match(err.message, /refs\/revu\/checkpoint\/foo/);
      return true;
    });
  });

  test('a tag sharing the branch name does not shadow the branch', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    await git(repo, ['tag', 'feature', mainTip]);
    assert.deepStrictEqual(await getCheckpointState(repo), {
      kind: 'implicit',
      branch: 'feature',
      sha: mainTip,
    });
    await markSafe(repo, 'feature', c2);
    assert.deepStrictEqual(await getCheckpointState(repo), {
      kind: 'explicit',
      branch: 'feature',
      sha: c2,
    });
    const commits = await unreviewedCommits(repo, c2, 'feature');
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      [c3]
    );
  });

  test('removeCheckpoint deletes the ref and state returns to implicit', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', c2);
    await removeCheckpoint(repo, 'feature');
    assert.deepStrictEqual(await getCheckpointState(repo), {
      kind: 'implicit',
      branch: 'feature',
      sha: mainTip,
    });
  });
});

suite('unreviewed range', () => {
  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('unreviewedCommits shrinks as the checkpoint advances', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    let commits = await unreviewedCommits(repo, mainTip, 'feature');
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      [c3, c2]
    );
    await markSafe(repo, 'feature', c2);
    commits = await unreviewedCommits(repo, c2, 'feature');
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      [c3]
    );
    await markSafe(repo, 'feature', c3, c2);
    commits = await unreviewedCommits(repo, c3, 'feature');
    assert.deepStrictEqual(commits, []);
  });

  test('workingTreeSummary matches git diff --name-status plus untracked files', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', mainTip);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'modified content\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
    const { files, dirty } = await workingTreeSummary(repo, mainTip);
    assert.strictEqual(dirty, true);
    const untracked = files.filter((f) => f.status === 'U').map((f) => f.path);
    assert.deepStrictEqual(untracked, ['untracked.txt']);
    const rawDiff = await git(repo, [
      'diff',
      '--name-status',
      '-M',
      'refs/revu/checkpoint/feature',
    ]);
    const expectedTracked = rawDiff
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => line.split('\t').pop())
      .sort();
    const actualTracked = files
      .filter((f) => f.status !== 'U')
      .map((f) => f.path)
      .sort();
    assert.deepStrictEqual(actualTracked, expectedTracked);
    const rawUntracked = await git(repo, ['ls-files', '--others', '--exclude-standard']);
    const expectedUntracked = rawUntracked.split('\n').filter((line) => line.trim());
    assert.deepStrictEqual(untracked, expectedUntracked);
  });

  test('workingTreeSummary reports a clean working tree as not dirty', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const { files, dirty } = await workingTreeSummary(repo, mainTip);
    assert.strictEqual(dirty, false);
    assert.deepStrictEqual(
      files.map((f) => f.path),
      ['f1.txt']
    );
  });
});

suite('reviewed range', () => {
  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('reviewedCommits lists merge-base..checkpoint newest-first', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    await commitFile(repo, 'f3.txt', 'three\n');
    const { commits, truncated } = await reviewedCommits(repo, c3);
    assert.strictEqual(truncated, false);
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      [c3, c2]
    );
  });

  test('reviewedCommits is empty when the checkpoint equals the merge-base', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const { commits, truncated } = await reviewedCommits(repo, mainTip);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(truncated, false);
  });

  test('reviewedCommits caps at the limit and flags truncation', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    let tip = '';
    const shas: string[] = [];
    for (let i = 0; i < 30; i++) {
      tip = await commitFile(repo, `f${i}.txt`, `content ${i}\n`);
      shas.push(tip);
    }
    const { commits, truncated } = await reviewedCommits(repo, tip);
    assert.strictEqual(truncated, true);
    assert.strictEqual(commits.length, REVIEWED_COMMITS_CAP);
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      shas.reverse().slice(0, REVIEWED_COMMITS_CAP)
    );
  });

  test('reviewedCommits falls back to listing from the checkpoint without a default branch', async () => {
    const repo = await makeRepo('trunk');
    const rootSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const { commits, truncated } = await reviewedCommits(repo, c2);
    assert.strictEqual(truncated, false);
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      [c2, rootSha]
    );
  });

  test('reviewedCommits is empty when the checkpoint is below the merge-base', async () => {
    const repo = await makeRepo();
    const rootSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await commitFile(repo, 'main.txt', 'main\n');
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const { commits, truncated } = await reviewedCommits(repo, rootSha);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(truncated, false);
  });
});
