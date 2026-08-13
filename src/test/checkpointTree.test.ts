import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { markSafe } from '../checkpoint';
import {
  CheckpointNode,
  CheckpointTreeProvider,
  CommitNode,
  resolveParentSha,
  summaryDescription,
} from '../checkpointTree';

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-checkpoint-tree-test-'));
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

interface Captured {
  message: string | undefined;
  description: string | undefined;
}

function makeProvider(repo: string): { provider: CheckpointTreeProvider; captured: Captured } {
  const captured: Captured = { message: undefined, description: undefined };
  const provider = new CheckpointTreeProvider(
    repo,
    (message) => {
      captured.message = message;
    },
    (description) => {
      captured.description = description;
    }
  );
  return { provider, captured };
}

function commitNodes(nodes: CheckpointNode[]): CommitNode[] {
  return nodes.filter((n): n is CommitNode => n.kind === 'commit');
}

suite('checkpoint tree provider', () => {
  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('implicit state lists working tree root first then commits newest-first', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    const { provider, captured } = makeProvider(repo);
    const roots = await provider.getChildren();
    assert.strictEqual(roots[0].kind, 'workingTreeRoot');
    const commits = commitNodes(roots);
    assert.deepStrictEqual(
      commits.map((n) => n.commit.sha),
      [c3, c2]
    );
    assert.strictEqual(captured.message, undefined);
    assert.strictEqual(captured.description, '2 commits');
  });

  test('commit nodes carry resolved 40-char parent SHAs', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const { provider } = makeProvider(repo);
    const commits = commitNodes(await provider.getChildren());
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0].commit.sha, c2);
    assert.strictEqual(commits[0].parentSha, mainTip);
    assert.match(commits[0].parentSha, /^[0-9a-f]{40}$/);
  });

  test('commit node children list that commit\'s changed files', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const { provider } = makeProvider(repo);
    const commits = commitNodes(await provider.getChildren());
    const files = await provider.getChildren(commits[0]);
    assert.strictEqual(files.length, 1);
    const file = files[0];
    assert.strictEqual(file.kind, 'commitFile');
    if (file.kind === 'commitFile') {
      assert.strictEqual(file.file.path, 'f1.txt');
      assert.strictEqual(file.commitSha, c2);
    }
  });

  test('working tree root children include untracked files', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    const { provider, captured } = makeProvider(repo);
    const roots = await provider.getChildren();
    assert.strictEqual(captured.description, '1 commit + dirty working tree');
    const files = await provider.getChildren(roots[0]);
    const paths = files.map((n) => (n.kind === 'workingTreeFile' ? n.file.path : ''));
    assert.ok(paths.includes('f1.txt'));
    assert.ok(paths.includes('untracked.txt'));
  });

  test('after markSafe only later commits remain', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    await markSafe(repo, 'feature', c2);
    const { provider } = makeProvider(repo);
    const commits = commitNodes(await provider.getChildren());
    assert.deepStrictEqual(
      commits.map((n) => n.commit.sha),
      [c3]
    );
  });

  test('orphaned state shows a message and a recovery node', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await markSafe(repo, 'feature', c2);
    fs.writeFileSync(path.join(repo, 'f1.txt'), 'rewritten\n');
    await git(repo, ['add', 'f1.txt']);
    await git(repo, ['commit', '--amend', '-m', 'rewritten']);
    const { provider, captured } = makeProvider(repo);
    const roots = await provider.getChildren();
    assert.match(captured.message ?? '', /orphaned/);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].kind, 'recoveryRoot');
    const files = await provider.getChildren(roots[0]);
    assert.ok(files.length > 0);
  });

  test('detached HEAD shows a message and no nodes', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '--detach']);
    const { provider, captured } = makeProvider(repo);
    const roots = await provider.getChildren();
    assert.deepStrictEqual(roots, []);
    assert.match(captured.message ?? '', /detached HEAD/);
  });

  test('needsInit shows a message prompting Set Checkpoint', async () => {
    const repo = await makeRepo();
    const { provider, captured } = makeProvider(repo);
    const roots = await provider.getChildren();
    assert.deepStrictEqual(roots, []);
    assert.match(captured.message ?? '', /Set Checkpoint/);
  });
});

suite('checkpoint tree helpers', () => {
  test('summaryDescription pluralises and flags dirt', () => {
    assert.strictEqual(summaryDescription(0, false), '0 commits');
    assert.strictEqual(summaryDescription(1, false), '1 commit');
    assert.strictEqual(summaryDescription(2, true), '2 commits + dirty working tree');
  });

  test('resolveParentSha returns EMPTY for a root commit', async () => {
    const repo = await makeRepo();
    const rootSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    assert.strictEqual(await resolveParentSha(repo, rootSha), 'EMPTY');
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    assert.strictEqual(await resolveParentSha(repo, c2), rootSha);
  });
});
