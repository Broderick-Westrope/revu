import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EMPTY_REF_SHA,
  checkedOutBranch,
  commitChangedFiles,
  deleteRef,
  gitDir,
  isAncestor,
  listCommits,
  resolveRef,
  updateRef,
} from '../git';

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

suite('git ref and history primitives', () => {
  let repo: string;
  let rootSha: string;
  let secondSha: string;
  let sideSha: string;
  let mergeSha: string;

  suiteSetup(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-checkpoint-git-test-'));
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'first\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'root file\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'root commit']);
    rootSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    await git(repo, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(repo, 'side.txt'), 'side branch\n');
    await git(repo, ['add', 'side.txt']);
    await git(repo, ['commit', '-m', 'side commit']);
    sideSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    await git(repo, ['checkout', 'main']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    fs.unlinkSync(path.join(repo, 'b.txt'));
    fs.writeFileSync(path.join(repo, 'c.txt'), 'added\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'second commit']);
    secondSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    await git(repo, ['merge', '--no-ff', '-m', 'merge side', 'side']);
    mergeSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  });

  suiteTeardown(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('resolveRef returns undefined for a missing ref', async () => {
    assert.strictEqual(await resolveRef(repo, 'refs/revu/checkpoint/missing'), undefined);
  });

  test('resolveRef resolves an existing ref to a commit SHA', async () => {
    const sha = await resolveRef(repo, 'main');
    assert.strictEqual(sha, mergeSha);
  });

  test('updateRef creates a ref guarded by the empty-ref sentinel', async () => {
    await updateRef(repo, 'refs/revu/checkpoint/main', rootSha, EMPTY_REF_SHA);
    assert.strictEqual(await resolveRef(repo, 'refs/revu/checkpoint/main'), rootSha);
  });

  test('updateRef with the empty-ref sentinel rejects when the ref exists', async () => {
    await assert.rejects(
      updateRef(repo, 'refs/revu/checkpoint/main', secondSha, EMPTY_REF_SHA)
    );
  });

  test('updateRef advances a ref when the expected old SHA matches', async () => {
    await updateRef(repo, 'refs/revu/checkpoint/main', secondSha, rootSha);
    assert.strictEqual(await resolveRef(repo, 'refs/revu/checkpoint/main'), secondSha);
  });

  test('updateRef rejects when the expected old SHA is stale', async () => {
    await assert.rejects(updateRef(repo, 'refs/revu/checkpoint/main', mergeSha, rootSha));
    assert.strictEqual(await resolveRef(repo, 'refs/revu/checkpoint/main'), secondSha);
  });

  test('deleteRef removes a ref', async () => {
    await deleteRef(repo, 'refs/revu/checkpoint/main');
    assert.strictEqual(await resolveRef(repo, 'refs/revu/checkpoint/main'), undefined);
  });

  test('isAncestor is true for an ancestor and false otherwise', async () => {
    assert.strictEqual(await isAncestor(repo, rootSha, mergeSha), true);
    assert.strictEqual(await isAncestor(repo, secondSha, sideSha), false);
  });

  test('listCommits follows first-parent order across a merge', async () => {
    const commits = await listCommits(repo, `${rootSha}..main`);
    assert.deepStrictEqual(
      commits.map((c) => c.sha),
      [mergeSha, secondSha]
    );
    assert.strictEqual(commits[0].subject, 'merge side');
    assert.strictEqual(commits[1].subject, 'second commit');
    assert.strictEqual(commits[1].author, 'Test User');
    assert.match(commits[1].shortSha, /^[0-9a-f]{7,}$/);
    assert.match(commits[1].date, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepStrictEqual(commits[0].parents, [secondSha, sideSha]);
    assert.deepStrictEqual(commits[1].parents, [rootSha]);
    assert.ok(!commits.some((c) => c.sha === sideSha));
  });

  test('listCommits gives a root commit an empty parents list', async () => {
    const commits = await listCommits(repo, rootSha);
    assert.strictEqual(commits.length, 1);
    assert.deepStrictEqual(commits[0].parents, []);
  });

  test('commitChangedFiles reports changes against the first parent', async () => {
    const files = await commitChangedFiles(repo, secondSha);
    const byPath = new Map(files.map((f) => [f.path, f]));
    assert.strictEqual(byPath.get('a.txt')?.status, 'M');
    assert.strictEqual(byPath.get('b.txt')?.status, 'D');
    assert.strictEqual(byPath.get('c.txt')?.status, 'A');
    assert.strictEqual(files.length, 3);
  });

  test('commitChangedFiles handles a root commit', async () => {
    const files = await commitChangedFiles(repo, rootSha);
    const byPath = new Map(files.map((f) => [f.path, f]));
    assert.strictEqual(byPath.get('a.txt')?.status, 'A');
    assert.strictEqual(byPath.get('b.txt')?.status, 'A');
    assert.strictEqual(files.length, 2);
  });

  test('checkedOutBranch names the branch and is undefined on a detached HEAD', async () => {
    assert.strictEqual(await checkedOutBranch(repo), 'main');
    await git(repo, ['checkout', '--detach']);
    assert.strictEqual(await checkedOutBranch(repo), undefined);
    await git(repo, ['checkout', 'main']);
  });

  test('gitDir returns an absolute path', async () => {
    const dir = await gitDir(repo);
    assert.ok(path.isAbsolute(dir));
    assert.strictEqual(fs.realpathSync(dir), fs.realpathSync(path.join(repo, '.git')));
  });

  test('gitDir in a linked worktree returns the worktree-private dir with logs/HEAD', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-worktree-test-'));
    const worktreePath = path.join(worktree, 'wt');
    try {
      await git(repo, ['worktree', 'add', worktreePath, 'side']);
      const dir = await gitDir(worktreePath);
      assert.ok(path.isAbsolute(dir));
      assert.notStrictEqual(fs.realpathSync(dir), fs.realpathSync(path.join(repo, '.git')));
      assert.ok(fs.existsSync(path.join(dir, 'logs', 'HEAD')));
    } finally {
      await git(repo, ['worktree', 'remove', '--force', worktreePath]).catch(() => {});
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });
});
