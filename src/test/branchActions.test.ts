import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SwitchInput,
  aheadBehind,
  hasTrackedChanges,
  listWorktrees,
  mergeParent,
  planSwitch,
  pullDefaultBranch,
  resetParentOverride,
  setParentOverride,
} from '../branchActions';
import { resolveStack } from '../stack';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function configure(repo: string): Promise<void> {
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
}

async function commitFile(repo: string, name: string, content = `${name}\n`): Promise<string> {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), content);
  await git(repo, ['add', name]);
  await git(repo, ['commit', '-m', `add ${name}`]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

async function localRepo(): Promise<string> {
  const repo = tempDir('revu-actions-local-');
  await git(repo, ['init', '-b', 'main']);
  await configure(repo);
  await commitFile(repo, 'base.txt');
  return repo;
}

interface Remote {
  seed: string;
  repo: string;
}

async function cloneWithOrigin(): Promise<Remote> {
  const origin = tempDir('revu-actions-origin-');
  await git(origin, ['init', '--bare', '-b', 'main']);
  const seed = tempDir('revu-actions-seed-');
  await git(seed, ['init', '-b', 'main']);
  await configure(seed);
  await commitFile(seed, 'base.txt');
  await git(seed, ['remote', 'add', 'origin', origin]);
  await git(seed, ['push', '-q', 'origin', 'main']);
  const repo = tempDir('revu-actions-repo-');
  await git(repo, ['clone', '-q', origin, '.']);
  await configure(repo);
  return { seed, repo };
}

async function upstreamCommit(remote: Remote, name: string): Promise<string> {
  const sha = await commitFile(remote.seed, name);
  await git(remote.seed, ['push', '-q', 'origin', 'main']);
  return sha;
}

async function linkedWorktree(repo: string, branch: string): Promise<string> {
  const dir = path.join(tempDir('revu-actions-wt-'), branch);
  await git(repo, ['worktree', 'add', '-q', '-b', branch, dir]);
  return dir;
}

async function rev(repo: string, ref: string): Promise<string> {
  return (await git(repo, ['rev-parse', ref])).trim();
}

suite('branch actions', () => {
  suiteTeardown(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('listWorktrees reports the main worktree and each branch checked out elsewhere', async () => {
    const repo = await localRepo();
    await git(repo, ['branch', 'a']);
    const other = path.join(tempDir('revu-actions-wt-'), 'a');
    await git(repo, ['worktree', 'add', '-q', other, 'a']);

    const worktrees = await listWorktrees(other);

    assert.strictEqual(worktrees.main, repo);
    assert.deepStrictEqual([...worktrees.byBranch.entries()], [
      ['main', repo],
      ['a', other],
    ]);
  });

  test('hasTrackedChanges ignores untracked files and sees tracked edits', async () => {
    const repo = await localRepo();
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'scratch\n');
    assert.strictEqual(await hasTrackedChanges(repo), false);

    fs.writeFileSync(path.join(repo, 'base.txt'), 'edited\n');
    assert.strictEqual(await hasTrackedChanges(repo), true);
  });

  test('aheadBehind counts commits on each side of the parent', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    await commitFile(repo, 'a1.txt');
    await commitFile(repo, 'a2.txt');
    await git(repo, ['checkout', '-q', 'main']);
    await commitFile(repo, 'm1.txt');

    assert.deepStrictEqual(await aheadBehind(repo, 'main', 'a'), { ahead: 2, behind: 1 });
  });

  suite('planSwitch', () => {
    const base: SwitchInput = {
      target: 'b',
      trunk: 'main',
      current: 'a',
      currentWorktree: '/wt/a',
      worktrees: {
        main: '/root',
        byBranch: new Map([
          ['main', '/root'],
          ['a', '/wt/a'],
          ['c', '/wt/c'],
        ]),
      },
      dirty: false,
    };

    test('the current branch needs nothing', () => {
      assert.deepStrictEqual(planSwitch({ ...base, target: 'a' }), { kind: 'none' });
    });

    test('the trunk opens the main worktree', () => {
      assert.deepStrictEqual(planSwitch({ ...base, target: 'main' }), { kind: 'openFolder', path: '/root' });
    });

    test('the trunk switches in place when this is the main worktree', () => {
      const worktrees = { main: '/wt/a', byBranch: new Map([['a', '/wt/a']]) };
      assert.deepStrictEqual(planSwitch({ ...base, target: 'main', worktrees }), { kind: 'switch' });
    });

    test('a branch in another worktree opens that folder', () => {
      assert.deepStrictEqual(planSwitch({ ...base, target: 'c', dirty: true }), {
        kind: 'openFolder',
        path: '/wt/c',
      });
    });

    test('a branch with no worktree switches in place when clean', () => {
      assert.deepStrictEqual(planSwitch(base), { kind: 'switch' });
    });

    test('a branch with no worktree offers a worktree when dirty', () => {
      assert.deepStrictEqual(planSwitch({ ...base, dirty: true }), { kind: 'offerWorktree' });
    });
  });

  suite('pullDefaultBranch', () => {
    test('fast-forwards a clean main worktree on the trunk', async () => {
      const remote = await cloneWithOrigin();
      const feature = await linkedWorktree(remote.repo, 'a');
      const upstream = await upstreamCommit(remote, 'up.txt');

      const result = await pullDefaultBranch(feature, 'main');

      assert.deepStrictEqual(result, { kind: 'fastForwarded' });
      assert.strictEqual(await rev(remote.repo, 'main'), upstream);
    });

    test('reports up to date when nothing new was fetched', async () => {
      const remote = await cloneWithOrigin();

      assert.deepStrictEqual(await pullDefaultBranch(remote.repo, 'main'), { kind: 'upToDate' });
    });

    test('leaves a dirty main worktree behind but still fetches', async () => {
      const remote = await cloneWithOrigin();
      const before = await rev(remote.repo, 'main');
      fs.writeFileSync(path.join(remote.repo, 'base.txt'), 'edited\n');
      const upstream = await upstreamCommit(remote, 'up.txt');

      const result = await pullDefaultBranch(remote.repo, 'main');

      assert.deepStrictEqual(result, { kind: 'stayedBehind', reason: 'dirty' });
      assert.strictEqual(await rev(remote.repo, 'main'), before);
      assert.strictEqual(await rev(remote.repo, 'origin/main'), upstream);
    });

    test('leaves the main worktree alone when it is on another branch', async () => {
      const remote = await cloneWithOrigin();
      await git(remote.repo, ['checkout', '-q', '-b', 'side']);
      await upstreamCommit(remote, 'up.txt');

      const result = await pullDefaultBranch(remote.repo, 'main');

      assert.deepStrictEqual(result, { kind: 'stayedBehind', reason: 'notOnTrunk', branch: 'side' });
    });

    test('reports a diverged local trunk', async () => {
      const remote = await cloneWithOrigin();
      await configure(remote.repo);
      await commitFile(remote.repo, 'local.txt');
      await upstreamCommit(remote, 'up.txt');

      const result = await pullDefaultBranch(remote.repo, 'main');

      assert.deepStrictEqual(result, { kind: 'stayedBehind', reason: 'diverged' });
    });
  });

  suite('mergeParent', () => {
    async function stacked(): Promise<string> {
      const repo = await localRepo();
      await git(repo, ['checkout', '-q', '-b', 'a']);
      await commitFile(repo, 'a1.txt');
      await git(repo, ['checkout', '-q', '-b', 'b']);
      await commitFile(repo, 'b1.txt');
      await git(repo, ['checkout', '-q', 'a']);
      await commitFile(repo, 'a2.txt');
      await git(repo, ['checkout', '-q', 'b']);
      return repo;
    }

    const onA = { branch: 'b', parent: 'a', parentRef: 'a' };

    test('merges new parent commits into the branch', async () => {
      const repo = await stacked();

      const result = await mergeParent(repo, onA, 'main');

      assert.deepStrictEqual(result, { kind: 'merged', checkpointMoved: false });
      assert.ok(fs.existsSync(path.join(repo, 'a2.txt')));
    });

    test('refuses with tracked changes and changes nothing', async () => {
      const repo = await stacked();
      const before = await rev(repo, 'HEAD');
      fs.writeFileSync(path.join(repo, 'b1.txt'), 'edited\n');

      const result = await mergeParent(repo, onA, 'main');

      assert.deepStrictEqual(result, { kind: 'dirty' });
      assert.strictEqual(await rev(repo, 'HEAD'), before);
    });

    test('reports up to date when the parent has nothing new', async () => {
      const repo = await stacked();
      await mergeParent(repo, onA, 'main');

      assert.deepStrictEqual(await mergeParent(repo, onA, 'main'), { kind: 'upToDate' });
    });

    test('leaves a conflicting merge in progress', async () => {
      const repo = await stacked();
      await git(repo, ['checkout', '-q', 'a']);
      await commitFile(repo, 'shared.txt', 'from a\n');
      await git(repo, ['checkout', '-q', 'b']);
      await commitFile(repo, 'shared.txt', 'from b\n');

      const result = await mergeParent(repo, onA, 'main');

      assert.deepStrictEqual(result, { kind: 'conflict' });
      assert.ok(await rev(repo, 'MERGE_HEAD'));
    });

    test('fetches origin first when the parent is the trunk', async () => {
      const remote = await cloneWithOrigin();
      await git(remote.repo, ['checkout', '-q', '-b', 'a']);
      await commitFile(remote.repo, 'a1.txt');
      await upstreamCommit(remote, 'up.txt');

      const result = await mergeParent(
        remote.repo,
        { branch: 'a', parent: 'main', parentRef: 'origin/main' },
        'main'
      );

      assert.deepStrictEqual(result, { kind: 'merged', checkpointMoved: false });
      assert.ok(fs.existsSync(path.join(remote.repo, 'up.txt')));
    });

    test('moves a checkpoint at the pre-merge HEAD to the merge commit', async () => {
      const repo = await stacked();
      await git(repo, ['update-ref', 'refs/revu/checkpoint/b', 'HEAD']);

      const result = await mergeParent(repo, onA, 'main');

      assert.deepStrictEqual(result, { kind: 'merged', checkpointMoved: true });
      assert.strictEqual(await rev(repo, 'refs/revu/checkpoint/b'), await rev(repo, 'HEAD'));
    });

    test('leaves a checkpoint below the pre-merge HEAD where it was', async () => {
      const repo = await stacked();
      const checkpoint = await rev(repo, 'HEAD');
      await commitFile(repo, 'b2.txt');
      await git(repo, ['update-ref', 'refs/revu/checkpoint/b', checkpoint]);

      const result = await mergeParent(repo, onA, 'main');

      assert.deepStrictEqual(result, { kind: 'merged', checkpointMoved: false });
      assert.strictEqual(await rev(repo, 'refs/revu/checkpoint/b'), checkpoint);
    });
  });

  suite('parent override', () => {
    test('setParentOverride makes the named branch the parent', async () => {
      const repo = await localRepo();
      await git(repo, ['checkout', '-q', '-b', 'a']);
      await commitFile(repo, 'a1.txt');
      await git(repo, ['checkout', '-q', '-b', 'b']);
      await commitFile(repo, 'b1.txt');

      await setParentOverride(repo, 'b', 'main');

      assert.strictEqual((await git(repo, ['config', 'branch.b.revuParent'])).trim(), 'main');
      const current = (await resolveStack(repo, { prs: [] })).current;
      assert.strictEqual(current?.parent, 'main');
      assert.strictEqual(current?.source, 'override');
    });

    test('resetParentOverride restores the resolved parent', async () => {
      const repo = await localRepo();
      await git(repo, ['checkout', '-q', '-b', 'a']);
      await commitFile(repo, 'a1.txt');
      await git(repo, ['checkout', '-q', '-b', 'b']);
      await setParentOverride(repo, 'b', 'main');

      await resetParentOverride(repo, 'b');

      assert.strictEqual((await resolveStack(repo, { prs: [] })).current?.parent, 'a');
    });

    test('resetParentOverride without an override does nothing', async () => {
      const repo = await localRepo();

      await resetParentOverride(repo, 'main');
    });
  });
});
