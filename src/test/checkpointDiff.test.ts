import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CheckpointTreeProvider,
  CommitNode,
} from '../checkpointTree';
import {
  clampLine,
  resolveWorkingTreeTarget,
} from '../commands/checkpointDiff';
import { ChangedFile, listCommits } from '../git';
import { GitUriQuery, makeGitUri } from '../gitContentProvider';

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-checkpoint-diff-test-'));
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

suite('checkpoint diff URIs', () => {
  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('commit file nodes produce URIs embedding resolved 40-char SHAs, never ref names', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'feature']);
    await commitFile(repo, 'f1.txt', 'one\n');
    const provider = new CheckpointTreeProvider(repo, () => undefined);
    const roots = await provider.getChildren();
    const commit = roots.find((n): n is CommitNode => n.kind === 'commit');
    assert.ok(commit);
    const files = await provider.getChildren(commit);
    const file = files[0];
    assert.strictEqual(file.kind, 'commitFile');
    if (file.kind !== 'commitFile') {
      return;
    }
    const context = { commitSha: file.commitSha, parentSha: file.parentSha };
    const left = makeGitUri(file.repoRoot, file.parentSha, file.file.path, context);
    const right = makeGitUri(file.repoRoot, file.commitSha, file.file.path, context);
    const leftQuery = JSON.parse(left.query) as GitUriQuery;
    const rightQuery = JSON.parse(right.query) as GitUriQuery;
    assert.match(leftQuery.ref, /^[0-9a-f]{40}$/);
    assert.match(rightQuery.ref, /^[0-9a-f]{40}$/);
    assert.match(rightQuery.commitSha ?? '', /^[0-9a-f]{40}$/);
    assert.match(rightQuery.parentSha ?? '', /^[0-9a-f]{40}$/);
    assert.notStrictEqual(rightQuery.ref, 'feature');
    assert.notStrictEqual(rightQuery.ref, 'HEAD');
  });

  test('parent resolution: normal commits list the parent SHA, root commits list none', async () => {
    const repo = await makeRepo();
    const rootSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await commitFile(repo, 'f1.txt', 'one\n');
    const commits = await listCommits(repo, 'HEAD');
    assert.deepStrictEqual(
      commits.map((c) => c.parents),
      [[rootSha], []]
    );
  });

  test('makeGitUri without commit context omits the optional fields', () => {
    const uri = makeGitUri('/repo', 'a'.repeat(40), 'file.txt');
    const query = JSON.parse(uri.query) as GitUriQuery;
    assert.strictEqual(query.commitSha, undefined);
    assert.strictEqual(query.parentSha, undefined);
  });
});

suite('clampLine', () => {
  test('keeps a line inside the file', () => {
    assert.strictEqual(clampLine(5, 10), 5);
  });

  test('clamps past-the-end lines to the last line', () => {
    assert.strictEqual(clampLine(50, 10), 9);
  });

  test('clamps negative lines to zero', () => {
    assert.strictEqual(clampLine(-3, 10), 0);
  });

  test('empty file resolves to line zero', () => {
    assert.strictEqual(clampLine(7, 0), 0);
  });
});

suite('resolveWorkingTreeTarget', () => {
  const noChanges: ChangedFile[] = [];

  test('existing file resolves to itself', () => {
    const target = resolveWorkingTreeTarget('a.txt', (p) => p === 'a.txt', noChanges);
    assert.deepStrictEqual(target, { kind: 'file', path: 'a.txt' });
  });

  test('missing file follows a rename when the target exists', () => {
    const changes: ChangedFile[] = [{ oldPath: 'a.txt', path: 'b.txt', status: 'R' }];
    const target = resolveWorkingTreeTarget('a.txt', (p) => p === 'b.txt', changes);
    assert.deepStrictEqual(target, { kind: 'file', path: 'b.txt' });
  });

  test('missing file with no rename is missing', () => {
    const target = resolveWorkingTreeTarget('a.txt', () => false, noChanges);
    assert.deepStrictEqual(target, { kind: 'missing' });
  });

  test('rename whose target was also deleted is missing', () => {
    const changes: ChangedFile[] = [{ oldPath: 'a.txt', path: 'b.txt', status: 'R' }];
    const target = resolveWorkingTreeTarget('a.txt', () => false, changes);
    assert.deepStrictEqual(target, { kind: 'missing' });
  });
});
