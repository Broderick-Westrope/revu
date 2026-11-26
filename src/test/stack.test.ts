import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StackExternal, resolveStack } from '../stack';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function cloneWithOrigin(): Promise<string> {
  const origin = tempDir('revu-stack-origin-');
  await git(origin, ['init', '--bare', '-b', 'main']);
  const seed = tempDir('revu-stack-seed-');
  await git(seed, ['init', '-b', 'main']);
  await configure(seed);
  await commitFile(seed, 'base.txt');
  await git(seed, ['remote', 'add', 'origin', origin]);
  await git(seed, ['push', '-q', 'origin', 'main']);
  const repo = tempDir('revu-stack-repo-');
  await git(repo, ['clone', '-q', origin, '.']);
  await configure(repo);
  return repo;
}

async function localRepo(): Promise<string> {
  const repo = tempDir('revu-stack-local-');
  await git(repo, ['init', '-b', 'main']);
  await configure(repo);
  await commitFile(repo, 'base.txt');
  return repo;
}

const noExternal: StackExternal = { prs: [] };

function changedNames(output: string): string[] {
  return output
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.split('\t').pop() as string)
    .sort();
}

suite('stack parent resolution', () => {
  suiteTeardown(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('trunk is origin/main, so a stale local main adds no upstream files', async () => {
    const repo = await cloneWithOrigin();
    const upstream = tempDir('revu-stack-upstream-');
    await git(upstream, ['clone', '-q', (await git(repo, ['remote', 'get-url', 'origin'])).trim(), '.']);
    await configure(upstream);
    await commitFile(upstream, 'upstream.txt');
    await git(upstream, ['push', '-q', 'origin', 'main']);
    await git(repo, ['fetch', '-q', 'origin']);
    await git(repo, ['checkout', '-q', '-b', 'feat', 'origin/main']);
    await git(repo, ['branch', '--unset-upstream']);
    await commitFile(repo, 'feat.txt');

    const result = await resolveStack(repo, noExternal);

    assert.strictEqual(result.trunk.ref, 'origin/main');
    assert.strictEqual(result.current?.parent, 'main');
    assert.strictEqual(result.current?.source, 'trunk');
    const diff = await git(repo, ['diff', '--name-status', result.current!.diffBase]);
    assert.deepStrictEqual(changedNames(diff), ['feat.txt']);
  });

  test('trunk falls back to the local default branch without an origin remote', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'feat']);
    await commitFile(repo, 'feat.txt');

    const result = await resolveStack(repo, noExternal);

    assert.strictEqual(result.trunk.ref, 'main');
    assert.strictEqual(result.current?.source, 'trunk');
  });

  test('a branch created from a named branch keeps it as parent after both move', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    await commitFile(repo, 'a1.txt');
    await git(repo, ['branch', 'b', 'a']);

    let result = await resolveStack(repo, noExternal);
    assert.strictEqual(result.branches.get('b')?.parent, 'a');
    assert.strictEqual(result.branches.get('b')?.source, 'inferred');

    await git(repo, ['checkout', '-q', 'b']);
    await commitFile(repo, 'b1.txt');
    await git(repo, ['checkout', '-q', 'a']);
    await commitFile(repo, 'a2.txt');
    await git(repo, ['checkout', '-q', 'b']);

    result = await resolveStack(repo, noExternal);
    assert.strictEqual(result.current?.branch, 'b');
    assert.strictEqual(result.current?.parent, 'a');
    assert.strictEqual(result.branches.get('a')?.parent, 'main');
    const diff = await git(repo, ['diff', '--name-status', result.current!.diffBase]);
    assert.deepStrictEqual(changedNames(diff), ['b1.txt']);
  });

  test('branches created from HEAD in worktrees chain to their creators, not their children', async () => {
    const repo = await localRepo();
    await git(repo, ['branch', 'a']);
    const wa = tempDir('revu-stack-wa-');
    await git(repo, ['worktree', 'add', '-q', wa, 'a']);
    await commitFile(wa, 'a1.txt');
    const wb = path.join(tempDir('revu-stack-wbp-'), 'wb');
    await git(wa, ['worktree', 'add', '-q', '-b', 'b', wb]);
    await commitFile(wb, 'b1.txt');
    const wd = path.join(tempDir('revu-stack-wdp-'), 'wd');
    await git(wb, ['worktree', 'add', '-q', '-b', 'd', wd]);
    await commitFile(wd, 'd1.txt');
    await commitFile(wa, 'a2.txt');
    await commitFile(wb, 'b2.txt');

    const result = await resolveStack(wb, noExternal);

    assert.strictEqual(result.branches.get('a')?.parent, 'main');
    assert.strictEqual(result.branches.get('b')?.parent, 'a');
    assert.strictEqual(result.branches.get('d')?.parent, 'b');
  });

  test('an override wins over inference', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    await commitFile(repo, 'a1.txt');
    await git(repo, ['checkout', '-q', '-b', 'other', 'main']);
    await commitFile(repo, 'o1.txt');
    await git(repo, ['checkout', '-q', '-b', 'b', 'a']);
    await commitFile(repo, 'b1.txt');
    await git(repo, ['config', 'branch.b.revuParent', 'other']);

    const result = await resolveStack(repo, noExternal);

    assert.strictEqual(result.current?.parent, 'other');
    assert.strictEqual(result.current?.source, 'override');
  });

  test('an override naming a deleted branch falls through with a warning', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'b']);
    await commitFile(repo, 'b1.txt');
    await git(repo, ['config', 'branch.b.revuParent', 'gone']);

    const result = await resolveStack(repo, noExternal);

    assert.strictEqual(result.current?.parent, 'main');
    assert.strictEqual(result.current?.warning, 'override target missing');
  });

  test('overrides pointing at each other fall back to trunk with a cycle warning', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    await commitFile(repo, 'a1.txt');
    await git(repo, ['checkout', '-q', '-b', 'b']);
    await commitFile(repo, 'b1.txt');
    await git(repo, ['config', 'branch.a.revuParent', 'b']);
    await git(repo, ['config', 'branch.b.revuParent', 'a']);

    const result = await resolveStack(repo, noExternal);

    assert.strictEqual(result.current?.parent, 'main');
    assert.strictEqual(result.current?.warning, 'parent cycle');
  });

  test('gh stack layers take the nearest unmerged layer below as parent', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    const aBase = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await commitFile(repo, 'a1.txt');
    const bBase = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-q', '-b', 'b']);
    await commitFile(repo, 'b1.txt');
    const ghStack = {
      trunk: 'main',
      branches: [
        { name: 'a', base: aBase, isMerged: false, needsRebase: false },
        { name: 'b', base: bBase, isMerged: false, needsRebase: false },
      ],
    };

    let result = await resolveStack(repo, { prs: [], ghStack });
    assert.strictEqual(result.current?.parent, 'a');
    assert.strictEqual(result.current?.source, 'gh-stack');
    assert.strictEqual(result.current?.diffBase, bBase);

    ghStack.branches[0].isMerged = true;
    result = await resolveStack(repo, { prs: [], ghStack });
    assert.strictEqual(result.current?.parent, 'main');
    assert.strictEqual(result.current?.source, 'gh-stack');
  });

  test('gh stack layers carry membership and needsRebase even when an override wins', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    const aBase = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await commitFile(repo, 'a1.txt');
    const bBase = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-q', '-b', 'b']);
    await commitFile(repo, 'b1.txt');
    await git(repo, ['config', 'branch.b.revuParent', 'main']);
    const ghStack = {
      trunk: 'main',
      branches: [
        { name: 'a', base: aBase, isMerged: false, needsRebase: false },
        { name: 'b', base: bBase, isMerged: false, needsRebase: true },
      ],
    };

    const result = await resolveStack(repo, { prs: [], ghStack });

    assert.strictEqual(result.current?.source, 'override');
    assert.strictEqual(result.current?.inGhStack, true);
    assert.strictEqual(result.current?.needsRebase, true);
    assert.strictEqual(result.branches.get('a')?.inGhStack, true);
    assert.strictEqual(result.branches.get('a')?.needsRebase, false);
  });

  test('branches outside a gh stack are not marked as members', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    await commitFile(repo, 'a1.txt');

    const result = await resolveStack(repo, noExternal);

    assert.strictEqual(result.current?.inGhStack, undefined);
    assert.strictEqual(result.current?.needsRebase, undefined);
  });

  test("an open PR's base names the parent", async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    await commitFile(repo, 'a1.txt');
    await git(repo, ['checkout', '-q', '-b', 'other', 'main']);
    await commitFile(repo, 'o1.txt');
    await git(repo, ['checkout', '-q', '-b', 'b', 'a']);
    await commitFile(repo, 'b1.txt');
    const prs = [
      { number: 7, url: 'https://example.test/7', state: 'OPEN' as const, headRefName: 'b', baseRefName: 'other' },
    ];

    const result = await resolveStack(repo, { prs });

    assert.strictEqual(result.current?.parent, 'other');
    assert.strictEqual(result.current?.source, 'pr');
    assert.strictEqual(result.current?.pr?.number, 7);
  });

  test('a branch whose PR merged is never inferred as a parent', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    await commitFile(repo, 'a1.txt');
    await git(repo, ['checkout', '-q', '-b', 'b']);
    await commitFile(repo, 'b1.txt');
    const prs = [
      { number: 3, url: 'https://example.test/3', state: 'MERGED' as const, headRefName: 'a', baseRefName: 'main' },
    ];

    const result = await resolveStack(repo, { prs });

    assert.strictEqual(result.current?.parent, 'main');
  });
  test('a branch restacked after its parent was rebased keeps the parent', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'a']);
    const oldA = await commitFile(repo, 'a1.txt');
    await git(repo, ['checkout', '-q', '-b', 'b']);
    await commitFile(repo, 'b1.txt');
    await git(repo, ['checkout', '-q', 'main']);
    await commitFile(repo, 'main2.txt');
    await git(repo, ['checkout', '-q', 'a']);
    await git(repo, ['rebase', '-q', 'main']);
    await git(repo, ['rebase', '-q', '--onto', 'a', oldA, 'b']);

    const result = await resolveStack(repo, noExternal);

    assert.strictEqual(result.current?.branch, 'b');
    assert.strictEqual(result.current?.parent, 'a');
    const diff = await git(repo, ['diff', '--name-status', result.current!.diffBase]);
    assert.deepStrictEqual(changedNames(diff), ['b1.txt']);
  });

  test('a gh stack base below the merge-base with the parent is ignored', async () => {
    const repo = await localRepo();
    const stale = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const fresh = await commitFile(repo, 'main2.txt');
    await git(repo, ['checkout', '-q', '-b', 'a']);
    await commitFile(repo, 'a1.txt');
    const ghStack = {
      trunk: 'main',
      branches: [{ name: 'a', base: stale, isMerged: false, needsRebase: false }],
    };

    const result = await resolveStack(repo, { prs: [], ghStack });

    assert.strictEqual(result.current?.diffBase, fresh);
  });

  test('without a creation reflog the fallback never picks a branch cut from this one', async () => {
    const repo = await localRepo();
    await git(repo, ['checkout', '-q', '-b', 'b']);
    await commitFile(repo, 'b1.txt');
    await git(repo, ['checkout', '-q', '-b', 'd']);
    await commitFile(repo, 'd1.txt');
    await git(repo, ['checkout', '-q', 'b']);
    await commitFile(repo, 'b2.txt');
    fs.rmSync(path.join(repo, '.git', 'logs', 'refs', 'heads', 'b'));

    const result = await resolveStack(repo, noExternal);

    assert.strictEqual(result.current?.parent, 'main');
    assert.strictEqual(result.current?.warning, undefined);
    assert.strictEqual(result.branches.get('d')?.parent, 'b');
  });
});
