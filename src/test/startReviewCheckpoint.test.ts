import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCheckpointState, markSafe } from '../checkpoint';
import { markSafeCommand, syncCheckpointScope } from '../commands/checkpoint';
import { checkpointScopeFromState } from '../checkpointGuard';
import {
  ReviewScope,
  clearActiveScope,
  getActiveScope,
  onDidChangeScope,
  setActiveScope,
} from '../scope';

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-start-review-cp-test-'));
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

suite('start review checkpoint scope', () => {
  teardown(() => {
    clearActiveScope();
  });

  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('explicit state produces a checkpoint scope with a resolved 40-char SHA', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await commitFile(repo, 'f2.txt', 'two\n');
    await markSafe(repo, 'feature', c2);
    const state = await getCheckpointState(repo);
    const scope = checkpointScopeFromState(state, repo);
    assert.ok(scope);
    assert.strictEqual(scope.type, 'checkpoint');
    assert.strictEqual(scope.branch, 'feature');
    assert.strictEqual(scope.repoRoot, repo);
    assert.match(scope.baseRef, /^[0-9a-f]{40}$/);
    assert.strictEqual(scope.baseRef, c2);
  });

  test('implicit state produces a checkpoint scope based at the merge-base', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const state = await getCheckpointState(repo);
    const scope = checkpointScopeFromState(state, repo);
    assert.ok(scope);
    assert.match(scope.baseRef, /^[0-9a-f]{40}$/);
    assert.strictEqual(scope.baseRef, mainTip);
  });

  test('orphaned and detached states produce no scope', () => {
    const sha = 'a'.repeat(40);
    assert.strictEqual(
      checkpointScopeFromState({ kind: 'orphaned', branch: 'feature', sha }, '/r'),
      undefined
    );
    assert.strictEqual(checkpointScopeFromState({ kind: 'detached' }, '/r'), undefined);
    assert.strictEqual(
      checkpointScopeFromState(
        { kind: 'needsInit', branch: 'feature', reason: 'onDefaultBranch' },
        '/r'
      ),
      undefined
    );
  });

  test('mark-safe during an active checkpoint review advances the scope and fires the event', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    await markSafe(repo, 'feature', c2);
    setActiveScope({ type: 'checkpoint', baseRef: c2, repoRoot: repo, branch: 'feature' });
    const events: (ReviewScope | undefined)[] = [];
    const sub = onDidChangeScope((scope) => events.push(scope));
    try {
      let refreshed = false;
      await markSafeCommand(
        {
          kind: 'commit',
          commit: {
            sha: c3,
            shortSha: c3.slice(0, 7),
            subject: 's',
            author: 'a',
            date: 'd',
            parents: [c2],
          },
          parentSha: c2,
          repoRoot: repo,
          reviewed: false,
          isCheckpoint: false,
        },
        () => {
          refreshed = true;
        }
      );
      assert.strictEqual(refreshed, true);
      assert.strictEqual(getActiveScope()?.baseRef, c3);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.baseRef, c3);
    } finally {
      sub.dispose();
    }
  });

  test('syncCheckpointScope leaves other scopes and branches untouched', () => {
    const sha = 'a'.repeat(40);
    setActiveScope({ type: 'workingTree', baseRef: 'HEAD', repoRoot: '/r' });
    syncCheckpointScope('/r', 'feature', sha);
    assert.strictEqual(getActiveScope()?.baseRef, 'HEAD');
    setActiveScope({ type: 'checkpoint', baseRef: sha, repoRoot: '/r', branch: 'other' });
    syncCheckpointScope('/r', 'feature', 'b'.repeat(40));
    assert.strictEqual(getActiveScope()?.baseRef, sha);
  });
});
