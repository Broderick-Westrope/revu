import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCheckpointState, markSafe, removeCheckpoint } from '../checkpoint';
import { expectedOldSha, staleConflictRef } from '../commands/checkpoint';
import { EMPTY_REF_SHA } from '../git';

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
    const state = await getCheckpointState(repo);
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
    const state = await getCheckpointState(repo);
    assert.strictEqual(state.kind, 'implicit');
    await markSafe(repo, 'feature', c2, expectedOldSha(state));
    assert.deepStrictEqual(await getCheckpointState(repo), {
      kind: 'explicit',
      branch: 'feature',
      sha: c2,
    });
  });

  test('setting a checkpoint on a needsInit branch creates the ref', async () => {
    const repo = await makeRepo();
    const rootSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const state = await getCheckpointState(repo);
    assert.strictEqual(state.kind, 'needsInit');
    await markSafe(repo, 'feature', rootSha, expectedOldSha(state));
    assert.deepStrictEqual(await getCheckpointState(repo), {
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
    assert.deepStrictEqual(await getCheckpointState(repo), {
      kind: 'implicit',
      branch: 'feature',
      sha: mainTip,
    });
  });
});
