import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReviewState } from '../reviewState';

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

const repos: string[] = [];

async function makeStack(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-review-state-test-'));
  repos.push(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await commitFile(repo, 'base.txt');
  await git(repo, ['checkout', '-q', '-b', 'a']);
  await commitFile(repo, 'a.txt');
  await git(repo, ['checkout', '-q', '-b', 'b']);
  return repo;
}

async function commitFile(repo: string, name: string): Promise<string> {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), `${name}\n`);
  await git(repo, ['add', name]);
  await git(repo, ['commit', '-m', `add ${name}`]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

suiteTeardown(() => {
  for (const repo of repos) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

suite('review state change check', () => {
  test('refreshIfChanged skips when git state is unchanged and refreshes after a commit', async () => {
    const repo = await makeStack();
    await commitFile(repo, 'first.txt');
    const state = new ReviewState(repo, async () => ({ prs: [] }));
    await state.refresh({ external: true });
    let fired = 0;
    state.onDidChange(() => fired++);

    assert.strictEqual(await state.refreshIfChanged(), false);
    await git(repo, ['config', 'branch.b.revuParent', 'main']);
    assert.strictEqual(await state.refreshIfChanged(), true);
    await commitFile(repo, 'second.txt');
    assert.strictEqual(await state.refreshIfChanged(), true);
    fs.writeFileSync(path.join(repo, 'agent-scratch.txt'), 'uncommitted\n');
    assert.strictEqual(await state.refreshIfChanged(), true);
    assert.strictEqual(fired, 3);
  });
});

suite('review state two-phase refresh', () => {
  test('git state is published before slow PR data arrives', async () => {
    const repo = await makeStack();
    await commitFile(repo, 'first.txt');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = new ReviewState(repo, async () => {
      await gate;
      return { prs: [{ number: 9, url: 'u', state: 'OPEN', headRefName: 'b', baseRefName: 'a' }] };
    });
    const firstChange = new Promise<void>((resolve) => state.onDidChange(() => resolve()));

    const done = state.refresh({ external: true });
    await firstChange;

    assert.strictEqual(state.snapshot?.stack.current?.branch, 'b');
    const prNumber = (): number | undefined => state.snapshot?.stack.current?.pr?.number;
    assert.strictEqual(prNumber(), undefined);
    release();
    await done;
    assert.strictEqual(prNumber(), 9);
  });
});

suite('review state PR data', () => {
  test('a failed PR fetch keeps the last good PR list', async () => {
    const repo = await makeStack();
    await commitFile(repo, 'first.txt');
    let calls = 0;
    const state = new ReviewState(repo, async () => {
      calls++;
      return calls === 1
        ? { prs: [{ number: 4, url: 'u', state: 'OPEN', headRefName: 'b', baseRefName: 'a' }] }
        : { prs: [], prsFailed: true };
    });
    await state.refresh({ external: true });
    await state.refresh({ external: true });

    assert.strictEqual(state.snapshot?.stack.current?.pr?.number, 4);
  });
});

suite('review state gh stack data', () => {
  test('a failed gh stack read keeps the last good stack', async () => {
    const repo = await makeStack();
    await commitFile(repo, 'first.txt');
    const ghStack = {
      trunk: 'main',
      branches: [
        { name: 'a', base: '', isMerged: false, needsRebase: false },
        { name: 'b', base: '', isMerged: false, needsRebase: false },
      ],
    };
    let calls = 0;
    const state = new ReviewState(repo, async () => {
      calls++;
      return calls === 1 ? { prs: [], ghStack } : { prs: [], ghStackFailed: true };
    });
    await state.refresh({ external: true });
    await state.refresh({ external: true });

    assert.strictEqual(state.snapshot?.stack.current?.source, 'gh-stack');
  });
});

suite('review state overlapping fetches', () => {
  test('a slow fetch for a branch no longer checked out does not overwrite newer data', async () => {
    const repo = await makeStack();
    await commitFile(repo, 'first.txt');
    let releaseSlow: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let calls = 0;
    const state = new ReviewState(repo, async () => {
      calls++;
      if (calls === 1) {
        await slow;
        return { prs: [{ number: 1, url: 'u1', state: 'OPEN', headRefName: 'b', baseRefName: 'a' }] };
      }
      return { prs: [{ number: 2, url: 'u2', state: 'OPEN', headRefName: 'a', baseRefName: 'main' }] };
    });
    const first = state.refresh({ external: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await git(repo, ['checkout', '-q', 'a']);
    await state.refresh({ external: true });
    releaseSlow();
    await first;

    assert.strictEqual(state.snapshot?.stack.current?.branch, 'a');
    assert.strictEqual(state.snapshot?.stack.current?.pr?.number, 2);
  });
});
