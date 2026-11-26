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
} from '../checkpoint';
import { defaultBranch, mergeBase } from '../git';


async function legacyBase(repo: string): Promise<string | undefined> {
  try {
    const def = await defaultBranch(repo);
    return await mergeBase(repo, `refs/heads/${def}`);
  } catch {
    return undefined;
  }
}

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
    const state = await getCheckpointState(repo, await legacyBase(repo));
    assert.deepStrictEqual(state, { kind: 'implicit', branch: 'feature', sha: mainTip });
  });

  test('implicit state uses the given parent diff base instead of the default branch', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'parent']);
    const parentTip = await commitFile(repo, 'p.txt', 'parent\n');
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const state = await getCheckpointState(repo, parentTip);
    assert.deepStrictEqual(state, { kind: 'implicit', branch: 'feature', sha: parentTip });
  });

  test('needsInit when the given parent diff base equals the branch tip', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const tip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const state = await getCheckpointState(repo, tip);
    assert.deepStrictEqual(state, {
      kind: 'needsInit',
      branch: 'feature',
    });
  });

  test('implicit state on trunk uses the given base below unpushed commits', async () => {
    const repo = await makeRepo();
    const pushed = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await commitFile(repo, 'local.txt', 'local\n');
    const state = await getCheckpointState(repo, pushed);
    assert.deepStrictEqual(state, { kind: 'implicit', branch: 'main', sha: pushed });
  });

  test('explicit state after markSafe', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', c2);
    const state = await getCheckpointState(repo, await legacyBase(repo));
    assert.deepStrictEqual(state, { kind: 'explicit', branch: 'feature', sha: c2 });
  });

  test('state re-derives after an external update-ref', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', c2);
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), {
      kind: 'explicit',
      branch: 'feature',
      sha: c2,
    });
    await git(repo, ['update-ref', 'refs/revu/checkpoint/feature', mainTip]);
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), {
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
    const state = await getCheckpointState(repo, await legacyBase(repo));
    assert.deepStrictEqual(state, { kind: 'orphaned', branch: 'feature', sha: c2 });
  });

  test('detached state after checkout --detach', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '--detach']);
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), { kind: 'detached' });
  });

  test('needsInit when no default branch can be determined', async () => {
    const repo = await makeRepo('trunk');
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const state = await getCheckpointState(repo, await legacyBase(repo));
    assert.deepStrictEqual(state, {
      kind: 'needsInit',
      branch: 'feature',
    });
  });

  test('needsInit when on the default branch', async () => {
    const repo = await makeRepo();
    const state = await getCheckpointState(repo, await legacyBase(repo));
    assert.deepStrictEqual(state, { kind: 'needsInit', branch: 'main' });
  });

  test('needsInit when the merge-base equals the branch tip', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const state = await getCheckpointState(repo, await legacyBase(repo));
    assert.deepStrictEqual(state, {
      kind: 'needsInit',
      branch: 'feature',
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
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), {
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
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), {
      kind: 'implicit',
      branch: 'feature',
      sha: mainTip,
    });
    await markSafe(repo, 'feature', c2);
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), {
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
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), {
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
    const { commits, truncated } = await reviewedCommits(repo, c3, await legacyBase(repo));
    assert.strictEqual(truncated, false);
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      [c3, c2]
    );
  });

  test('reviewedCommits lists from the given parent diff base', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'parent']);
    const parentTip = await commitFile(repo, 'p.txt', 'parent\n');
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const { commits } = await reviewedCommits(repo, c2, parentTip);
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      [c2]
    );
  });

  test('reviewedCommits is empty when the checkpoint equals the merge-base', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const { commits, truncated } = await reviewedCommits(repo, mainTip, await legacyBase(repo));
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
    const { commits, truncated } = await reviewedCommits(repo, tip, await legacyBase(repo));
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
    const { commits, truncated } = await reviewedCommits(repo, c2, await legacyBase(repo));
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
    const { commits, truncated } = await reviewedCommits(repo, rootSha, await legacyBase(repo));
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(truncated, false);
  });
});
