import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { markSafe } from '../checkpoint';
import {
  CheckpointNode,
  CheckpointTreeProvider,
  CommitNode,
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

function makeProvider(
  repo: string,
  implicitBase?: string
): { provider: CheckpointTreeProvider; captured: Captured } {
  const captured: Captured = { message: undefined, description: undefined };
  const provider = new CheckpointTreeProvider(
    repo,
    () => implicitBase,
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

  test('implicit state lists only commits newest-first', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    const { provider, captured } = makeProvider(repo);
    const roots = await provider.getChildren();
    assert.deepStrictEqual(
      roots.map((n) => (n.kind === 'commit' ? n.commit.sha : n.kind)),
      [c3, c2]
    );
    assert.strictEqual(captured.message, undefined);
    assert.strictEqual(captured.description, '2 commits');
  });

  test('the parent diff base bounds both commit lists', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'parent']);
    const parentTip = await commitFile(repo, 'p.txt', 'parent\n');
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    await markSafe(repo, 'feature', c2);
    const { provider } = makeProvider(repo, parentTip);
    const commits = commitNodes(await provider.getChildren());
    assert.deepStrictEqual(
      commits.map((n) => n.commit.sha),
      [c3, c2]
    );
  });

  test('implicit state starts from the parent diff base', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'parent']);
    const parentTip = await commitFile(repo, 'p.txt', 'parent\n');
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const { provider } = makeProvider(repo, parentTip);
    const commits = commitNodes(await provider.getChildren());
    assert.deepStrictEqual(
      commits.map((n) => n.commit.sha),
      [c2]
    );
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

  test('a dirty working tree shows in the summary description', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    const { provider, captured } = makeProvider(repo);
    await provider.getChildren();
    assert.strictEqual(captured.description, '1 commit + dirty working tree');
  });

  test('after markSafe later commits stay unreviewed and earlier ones render as reviewed', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    await markSafe(repo, 'feature', c2);
    const { provider, captured } = makeProvider(repo);
    const commits = commitNodes(await provider.getChildren());
    assert.deepStrictEqual(
      commits.map((n) => n.commit.sha),
      [c3, c2]
    );
    assert.deepStrictEqual(
      commits.map((n) => n.reviewed),
      [false, true]
    );
    assert.deepStrictEqual(
      commits.map((n) => n.isCheckpoint),
      [false, true]
    );
    assert.strictEqual(captured.description, '1 commit · 1 reviewed');
  });

  test('reviewed commit nodes carry resolved 40-char parent SHAs', async () => {
    const repo = await makeRepo();
    const mainTip = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await commitFile(repo, 'f2.txt', 'two\n');
    await markSafe(repo, 'feature', c2);
    const { provider } = makeProvider(repo);
    const commits = commitNodes(await provider.getChildren());
    const reviewed = commits.filter((n) => n.reviewed);
    assert.strictEqual(reviewed.length, 1);
    assert.strictEqual(reviewed[0].parentSha, mainTip);
    assert.match(reviewed[0].parentSha, /^[0-9a-f]{40}$/);
  });

  test('getTreeItem distinguishes unreviewed, reviewed, and checkpoint commits', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    const c3 = await commitFile(repo, 'f2.txt', 'two\n');
    await commitFile(repo, 'f3.txt', 'three\n');
    await markSafe(repo, 'feature', c3);
    const { provider } = makeProvider(repo);
    const commits = commitNodes(await provider.getChildren());
    const bySha = new Map(commits.map((n) => [n.commit.sha, provider.getTreeItem(n)]));
    const unreviewedItem = commits.find((n) => !n.reviewed);
    assert.ok(unreviewedItem);
    const plain = provider.getTreeItem(unreviewedItem);
    assert.strictEqual(plain.contextValue, 'revu.commit');
    assert.strictEqual(plain.description, unreviewedItem.commit.shortSha);
    assert.strictEqual((plain.iconPath as vscode.ThemeIcon).id, 'git-commit');
    const checkpointItem = bySha.get(c3);
    assert.ok(checkpointItem);
    assert.strictEqual(checkpointItem.contextValue, 'revu.checkpointCommit');
    assert.match(String(checkpointItem.description), / · checkpoint$/);
    assert.strictEqual((checkpointItem.iconPath as vscode.ThemeIcon).id, 'milestone');
    const reviewedItem = bySha.get(c2);
    assert.ok(reviewedItem);
    assert.strictEqual(reviewedItem.contextValue, 'revu.reviewedCommit');
    assert.match(String(reviewedItem.description), / · reviewed$/);
    assert.strictEqual((reviewedItem.iconPath as vscode.ThemeIcon).id, 'check');
    assert.strictEqual(reviewedItem.command?.command, 'revu.openCommitDiff');
  });

  test('reviewed commit children list that commit\'s changed files', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    const c2 = await commitFile(repo, 'f1.txt', 'one\n');
    await commitFile(repo, 'f2.txt', 'two\n');
    await markSafe(repo, 'feature', c2);
    const { provider } = makeProvider(repo);
    const commits = commitNodes(await provider.getChildren());
    const reviewed = commits.find((n) => n.reviewed);
    assert.ok(reviewed);
    const files = await provider.getChildren(reviewed);
    assert.strictEqual(files.length, 1);
    const file = files[0];
    assert.strictEqual(file.kind, 'commitFile');
    if (file.kind === 'commitFile') {
      assert.strictEqual(file.file.path, 'f1.txt');
      assert.strictEqual(file.commitSha, c2);
    }
  });

  test('truncated reviewed listing appends a terminal overflow node and 25+ summary', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    let tip = '';
    for (let i = 0; i < 30; i++) {
      tip = await commitFile(repo, `f${i}.txt`, `content ${i}\n`);
    }
    await commitFile(repo, 'unreviewed.txt', 'later\n');
    await markSafe(repo, 'feature', tip);
    const { provider, captured } = makeProvider(repo);
    const roots = await provider.getChildren();
    const last = roots[roots.length - 1];
    assert.strictEqual(last.kind, 'reviewedOverflow');
    const item = provider.getTreeItem(last);
    assert.strictEqual(item.label, 'Older reviewed commits hidden (showing 25)');
    assert.strictEqual(item.command, undefined);
    assert.deepStrictEqual(await provider.getChildren(last), []);
    assert.strictEqual(commitNodes(roots).filter((n) => n.reviewed).length, 25);
    assert.strictEqual(captured.description, '1 commit · 25+ reviewed');
  });

  test('implicit state yields zero reviewed nodes', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const { provider, captured } = makeProvider(repo);
    const roots = await provider.getChildren();
    const commits = commitNodes(roots);
    assert.deepStrictEqual(
      commits.map((n) => n.reviewed),
      [false]
    );
    assert.ok(!roots.some((n) => n.kind === 'reviewedOverflow'));
    assert.strictEqual(captured.description, '1 commit');
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
  test('summaryDescription pluralises, flags dirt, and appends the reviewed count', () => {
    assert.strictEqual(summaryDescription(0, false, 0, false), '0 commits');
    assert.strictEqual(summaryDescription(1, false, 0, false), '1 commit');
    assert.strictEqual(summaryDescription(2, true, 0, false), '2 commits + dirty working tree');
    assert.strictEqual(
      summaryDescription(3, true, 5, false),
      '3 commits + dirty working tree · 5 reviewed'
    );
    assert.strictEqual(summaryDescription(1, false, 25, true), '1 commit · 25+ reviewed');
  });
});
