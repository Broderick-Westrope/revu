import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getCheckpointState,
  markSafe,
  removeCheckpoint,
  reviewedCommits,
  unreviewedCommits,
} from '../checkpoint';
import {
  checkpointPickItems,
  expectedOldSha,
  moveCheckpointCommand,
  staleConflictRef,
} from '../commands/checkpoint';
import { CommitNode } from '../checkpointTree';
import { EMPTY_REF_SHA, defaultBranch, mergeBase } from '../git';


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

async function makeRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-checkpoint-cmd-test-'));
  repos.push(repo);
  await git(repo, ['init', '-b', 'main']);
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

function commitNode(repo: string, sha: string, parentSha: string): CommitNode {
  return {
    kind: 'commit',
    commit: {
      sha,
      shortSha: sha.slice(0, 7),
      subject: 's',
      author: 'a',
      date: 'd',
      parents: [parentSha],
    },
    parentSha,
    repoRoot: repo,
    reviewed: true,
    isCheckpoint: false,
  };
}

suite('checkpoint commands', () => {
  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('expectedOldSha maps state to the CAS guard', () => {
    const sha = 'a'.repeat(40);
    assert.strictEqual(expectedOldSha({ kind: 'explicit', branch: 'b', sha }), sha);
    assert.strictEqual(expectedOldSha({ kind: 'orphaned', branch: 'b', sha }), sha);
    assert.strictEqual(
      expectedOldSha({ kind: 'implicit', branch: 'b', sha }),
      EMPTY_REF_SHA
    );
    assert.strictEqual(
      expectedOldSha({ kind: 'needsInit', branch: 'b', reason: 'onDefaultBranch' }),
      EMPTY_REF_SHA
    );
    assert.strictEqual(expectedOldSha({ kind: 'detached' }), undefined);
  });

  test('staleConflictRef extracts the conflicting ref from a git D/F error', () => {
    const message =
      "error: cannot lock ref 'refs/revu/checkpoint/foo/bar': 'refs/revu/checkpoint/foo' exists; cannot create 'refs/revu/checkpoint/foo/bar'";
    assert.strictEqual(staleConflictRef(message), 'refs/revu/checkpoint/foo');
    assert.strictEqual(staleConflictRef('fatal: something else entirely'), undefined);
  });

  test('an external ref move between read and mark rejects without clobbering the ref', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    const c4 = await commitFile(repo, 'f3.txt', 'three\n');
    await markSafe(repo, 'feature', c2);
    const state = await getCheckpointState(repo, await legacyBase(repo));
    const expected = expectedOldSha(state);
    await git(repo, ['update-ref', 'refs/revu/checkpoint/feature', c3]);
    await assert.rejects(markSafe(repo, 'feature', c4, expected));
    const refSha = (await git(repo, ['rev-parse', 'refs/revu/checkpoint/feature'])).trim();
    assert.strictEqual(refSha, c3);
  });

  test('marking safe on an implicit state creates the ref guarded by the sentinel', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const state = await getCheckpointState(repo, await legacyBase(repo));
    assert.strictEqual(state.kind, 'implicit');
    await markSafe(repo, 'feature', c2, expectedOldSha(state));
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), {
      kind: 'explicit',
      branch: 'feature',
      sha: c2,
    });
  });

  test('setting a checkpoint on a needsInit branch creates the ref', async () => {
    const repo = await makeRepo();
    const rootSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const state = await getCheckpointState(repo, await legacyBase(repo));
    assert.strictEqual(state.kind, 'needsInit');
    await markSafe(repo, 'feature', rootSha, expectedOldSha(state));
    assert.deepStrictEqual(await getCheckpointState(repo, await legacyBase(repo)), {
      kind: 'explicit',
      branch: 'feature',
      sha: rootSha,
    });
  });

  test('removeCheckpoint returns the state to implicit', async () => {
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

  test('moving the checkpoint backwards returns later commits to the unreviewed state', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    const c4 = await commitFile(repo, 'f3.txt', 'three\n');
    await markSafe(repo, 'feature', c4);
    let refreshed = false;
    await moveCheckpointCommand(commitNode(repo, c2, mainTip), () => {
      refreshed = true;
    });
    assert.strictEqual(refreshed, true);
    const refSha = (await git(repo, ['rev-parse', 'refs/revu/checkpoint/feature'])).trim();
    assert.strictEqual(refSha, c2);
    const unreviewed = await unreviewedCommits(repo, c2, 'feature');
    assert.deepStrictEqual(
      unreviewed.map((c) => c.sha),
      [c4, c3]
    );
    const reviewed = await reviewedCommits(repo, c2, await legacyBase(repo));
    assert.deepStrictEqual(
      reviewed.commits.map((c) => c.sha),
      [c2]
    );
  });

  test('a concurrent external move rejects a backwards move without clobbering the ref', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    const c4 = await commitFile(repo, 'f3.txt', 'three\n');
    await markSafe(repo, 'feature', c3);
    const state = await getCheckpointState(repo, await legacyBase(repo));
    const expected = expectedOldSha(state);
    await git(repo, ['update-ref', 'refs/revu/checkpoint/feature', c4]);
    await assert.rejects(markSafe(repo, 'feature', c2, expected));
    const refSha = (await git(repo, ['rev-parse', 'refs/revu/checkpoint/feature'])).trim();
    assert.strictEqual(refSha, c4);
  });

  test('moving to a commit not on the current branch leaves the ref and skips refresh', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await git(repo, ['checkout', '-b', 'side', 'main']);
    const sideSha = await commitFile(repo, 'side.txt', 'side\n');
    await git(repo, ['checkout', 'feature']);
    await markSafe(repo, 'feature', c2);
    let refreshed = false;
    await moveCheckpointCommand(commitNode(repo, sideSha, mainTip), () => {
      refreshed = true;
    });
    assert.strictEqual(refreshed, false);
    const refSha = (await git(repo, ['rev-parse', 'refs/revu/checkpoint/feature'])).trim();
    assert.strictEqual(refSha, c2);
  });

  test('the picker offers the merge-base with the parent when a parent diff base is given', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'parent']);
    const parentTip = await commitFile(repo, 'p.txt', 'parent\n');
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const items = await checkpointPickItems(repo, parentTip);
    const last = items[items.length - 1];
    assert.strictEqual(last.label, 'Merge-base with parent');
    assert.strictEqual(last.sha, parentTip);
  });

  test('the picker falls back to the merge-base with the default branch', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const items = await checkpointPickItems(repo);
    const last = items[items.length - 1];
    assert.strictEqual(last.label, 'Merge-base with main');
    assert.strictEqual(last.sha, mainTip);
  });
});
