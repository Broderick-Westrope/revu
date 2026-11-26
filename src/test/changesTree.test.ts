import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { markSafe } from '../checkpoint';
import { ChangesNode, ChangesTreeProvider } from '../changesTree';
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-changes-tree-test-'));
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

interface Captured {
  message?: string;
  description?: string;
}

async function setup(repo: string): Promise<{ provider: ChangesTreeProvider; state: ReviewState; captured: Captured }> {
  const state = new ReviewState(repo, async () => ({ prs: [] }));
  await state.refresh();
  const captured: Captured = {};
  const provider = new ChangesTreeProvider(
    state,
    (message) => {
      captured.message = message;
    },
    (description) => {
      captured.description = description;
    }
  );
  return { provider, state, captured };
}

async function filePaths(provider: ChangesTreeProvider, nodes?: ChangesNode[]): Promise<string[]> {
  const result: string[] = [];
  for (const node of nodes ?? (await provider.getChildren())) {
    if (node.kind === 'file') {
      result.push(node.file.path);
    } else {
      result.push(...(await filePaths(provider, await provider.getChildren(node))));
    }
  }
  return result.sort();
}

suite('changes tree provider', () => {
  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('lists only the branch changes against its parent, grouped by folder', async () => {
    const repo = await makeStack();
    await commitFile(repo, 'src/b.ts');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    const { provider, captured } = await setup(repo);

    const roots = await provider.getChildren();

    assert.deepStrictEqual(
      roots.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.file.path)),
      ['src/', 'untracked.txt']
    );
    assert.deepStrictEqual(await filePaths(provider), ['src/b.ts', 'untracked.txt']);
    assert.strictEqual(captured.description, 'vs a (inferred)');
  });

  test('checkpoint mode lists only files changed after the checkpoint', async () => {
    const repo = await makeStack();
    const first = await commitFile(repo, 'first.txt');
    await commitFile(repo, 'second.txt');
    await markSafe(repo, 'b', first);
    const { provider, state, captured } = await setup(repo);

    assert.deepStrictEqual(await filePaths(provider), ['first.txt', 'second.txt']);
    state.setCheckpointMode(true);
    await state.refresh();

    assert.deepStrictEqual(await filePaths(provider), ['second.txt']);
    assert.strictEqual(captured.description, 'vs a (inferred) · since checkpoint');
  });

  test('checkpoint mode without a checkpoint lists the same files', async () => {
    const repo = await makeStack();
    await commitFile(repo, 'first.txt');
    const { provider, state } = await setup(repo);
    state.setCheckpointMode(true);
    await state.refresh();

    assert.deepStrictEqual(await filePaths(provider), ['first.txt']);
  });

  test('on the trunk branch the view says so', async () => {
    const repo = await makeStack();
    await git(repo, ['checkout', '-q', 'main']);
    const { provider, captured } = await setup(repo);

    await provider.getChildren();

    assert.strictEqual(captured.description, 'on trunk');
  });
});
