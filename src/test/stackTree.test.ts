import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewState } from '../reviewState';
import { StackExternal } from '../stack';
import { StackNode, StackTreeProvider } from '../stackTree';

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

async function commitFile(repo: string, name: string): Promise<void> {
  fs.writeFileSync(path.join(repo, name), `${name}\n`);
  await git(repo, ['add', name]);
  await git(repo, ['commit', '-m', `add ${name}`]);
}

async function branchFrom(repo: string, from: string, branch: string): Promise<void> {
  await git(repo, ['checkout', '-q', from]);
  await git(repo, ['checkout', '-q', '-b', branch]);
  await commitFile(repo, `${branch}.txt`);
}

async function makeRepo(): Promise<string> {
  const repo = tempDir('revu-stack-tree-test-');
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await commitFile(repo, 'base.txt');
  return repo;
}

async function setup(
  repo: string,
  external: StackExternal = { prs: [] }
): Promise<{ provider: StackTreeProvider; messages: (string | undefined)[] }> {
  const state = new ReviewState(repo, async () => external);
  await state.refresh();
  const messages: (string | undefined)[] = [];
  const provider = new StackTreeProvider(state, (message) => messages.push(message));
  return { provider, messages };
}

async function outline(provider: StackTreeProvider, nodes?: StackNode[], depth = 0): Promise<string[]> {
  const lines: string[] = [];
  for (const node of nodes ?? (await provider.getChildren())) {
    lines.push(`${'  '.repeat(depth)}${node.branch}`);
    lines.push(...(await outline(provider, await provider.getChildren(node), depth + 1)));
  }
  return lines;
}

async function find(provider: StackTreeProvider, branch: string, nodes?: StackNode[]): Promise<StackNode | undefined> {
  for (const node of nodes ?? (await provider.getChildren())) {
    if (node.branch === branch) {
      return node;
    }
    const found = await find(provider, branch, await provider.getChildren(node));
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function item(provider: StackTreeProvider, branch: string): Promise<vscode.TreeItem> {
  const node = await find(provider, branch);
  assert.ok(node, `expected a row for ${branch}`);
  return provider.getTreeItem(node);
}

suite('stack tree provider', () => {
  suiteTeardown(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shows the parent chain and descendants of the current branch, leaving out siblings', async () => {
    const repo = await makeRepo();
    await branchFrom(repo, 'main', 'a');
    await branchFrom(repo, 'a', 'b');
    await branchFrom(repo, 'b', 'c');
    await branchFrom(repo, 'c', 'd');
    await branchFrom(repo, 'a', 'sibling');
    await git(repo, ['checkout', '-q', 'b']);
    const { provider } = await setup(repo);

    assert.deepStrictEqual(await outline(provider), ['main', '  a', '    b', '      c', '        d']);
  });

  test('on the trunk only the trunk row shows', async () => {
    const repo = await makeRepo();
    await branchFrom(repo, 'main', 'a');
    await git(repo, ['checkout', '-q', 'main']);
    const { provider } = await setup(repo);

    assert.deepStrictEqual(await outline(provider), ['main']);
  });

  test('rows say nothing about PRs when PR data could not be fetched', async () => {
    const repo = await makeRepo();
    await branchFrom(repo, 'main', 'a');
    const { provider } = await setup(repo, { prs: [], prsFailed: true });

    assert.strictEqual((await item(provider, 'a')).description, '↑1 ↓0');
  });

  test('a detached HEAD shows a message and no rows', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-q', '--detach']);
    const { provider, messages } = await setup(repo);

    assert.deepStrictEqual(await provider.getChildren(), []);
    assert.strictEqual(messages.pop(), 'HEAD is detached. Check out a branch to see its stack.');
  });

  test('rows describe the PR and commits ahead of and behind the parent', async () => {
    const repo = await makeRepo();
    await branchFrom(repo, 'main', 'a');
    await branchFrom(repo, 'a', 'b');
    await git(repo, ['checkout', '-q', 'a']);
    await commitFile(repo, 'a2.txt');
    await git(repo, ['checkout', '-q', 'b']);
    const { provider } = await setup(repo, {
      prs: [{ number: 7, url: 'https://example.com/7', state: 'OPEN', headRefName: 'a', baseRefName: 'main' }],
    });

    assert.strictEqual((await item(provider, 'a')).description, '#7 open · ↑2 ↓0');
    assert.strictEqual((await item(provider, 'b')).description, 'no PR · ↑1 ↓1');
  });

  test('rows say when gh stack reports a needed rebase', async () => {
    const repo = await makeRepo();
    await branchFrom(repo, 'main', 'a');
    const base = (await git(repo, ['rev-parse', 'main'])).trim();
    const { provider } = await setup(repo, {
      prs: [],
      ghStack: { trunk: 'main', branches: [{ name: 'a', base, isMerged: false, needsRebase: true }] },
    });

    assert.strictEqual((await item(provider, 'a')).description, 'no PR · ↑1 ↓0 · needs rebase');
  });

  test('the current branch is highlighted and offers no Switch', async () => {
    const repo = await makeRepo();
    await branchFrom(repo, 'main', 'a');
    const { provider } = await setup(repo);

    const current = await item(provider, 'a');
    const trunk = await item(provider, 'main');

    assert.strictEqual((current.iconPath as vscode.ThemeIcon).id, 'circle-filled');
    assert.ok(!/switch/.test(current.contextValue ?? ''));
    assert.ok(/switch/.test(trunk.contextValue ?? ''));
    assert.strictEqual(current.command, undefined);
  });

  test('a branch checked out in another worktree is marked and can open in a new window', async () => {
    const repo = await makeRepo();
    await branchFrom(repo, 'main', 'a');
    await branchFrom(repo, 'a', 'b');
    await git(repo, ['checkout', '-q', 'a']);
    const other = path.join(tempDir('revu-stack-tree-wt-'), 'b');
    await git(repo, ['worktree', 'add', '-q', other, 'b']);
    const { provider } = await setup(repo);

    const row = await item(provider, 'b');

    assert.strictEqual((row.iconPath as vscode.ThemeIcon).id, 'folder-opened');
    assert.ok(/;worktree\b/.test(row.contextValue ?? ''));
    assert.ok(String(row.tooltip).includes(other));
  });

  test('rows with a PR offer Open PR', async () => {
    const repo = await makeRepo();
    await branchFrom(repo, 'main', 'a');
    const { provider } = await setup(repo, {
      prs: [{ number: 3, url: 'https://example.com/3', state: 'MERGED', headRefName: 'a', baseRefName: 'main' }],
    });

    const row = await item(provider, 'a');

    assert.ok(/;pr\b/.test(row.contextValue ?? ''));
    assert.ok(String(row.description).startsWith('#3 merged'));
  });
});
