import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCheckpointState, markSafe, removeCheckpoint } from '../checkpoint';

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
