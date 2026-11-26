import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  changedFiles,
  defaultBranch,
  mergeBase,
  repoRoot,
  showFile,
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

suite('git wrapper', () => {
  let repo: string;

  suiteSetup(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-git-test-'));
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'modify-me.txt'), 'original content\nline two\nline three\n');
    fs.writeFileSync(path.join(repo, 'delete-me.txt'), 'to be deleted\n');
    fs.writeFileSync(
      path.join(repo, 'rename-me.txt'),
      'stable content that stays identical across the rename\nso git -M detects it\n'
    );
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'initial commit']);

    fs.writeFileSync(path.join(repo, 'modify-me.txt'), 'changed content\nline two\nline three\n');
    fs.unlinkSync(path.join(repo, 'delete-me.txt'));
    await git(repo, ['mv', 'rename-me.txt', 'renamed.txt']);
    fs.writeFileSync(path.join(repo, 'added.txt'), 'newly added file\n');
    await git(repo, ['add', 'added.txt']);
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked file\n');
  });

  suiteTeardown(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('repoRoot resolves the repository root', async () => {
    const root = await repoRoot(repo);
    assert.strictEqual(fs.realpathSync(root), fs.realpathSync(repo));
  });

  test('defaultBranch falls back to main when origin/HEAD is absent', async () => {
    assert.strictEqual(await defaultBranch(repo), 'main');
  });

  test('mergeBase resolves to a commit SHA', async () => {
    const base = await mergeBase(repo, 'main');
    assert.match(base ?? '', /^[0-9a-f]{40}$/);
  });

  test('changedFiles reports modify, add, delete, rename', async () => {
    const files = await changedFiles(repo, 'HEAD', false);
    const byPath = new Map(files.map((f) => [f.path, f]));
    assert.strictEqual(byPath.get('modify-me.txt')?.status, 'M');
    assert.strictEqual(byPath.get('added.txt')?.status, 'A');
    assert.strictEqual(byPath.get('delete-me.txt')?.status, 'D');
    const renamed = byPath.get('renamed.txt');
    assert.strictEqual(renamed?.status, 'R');
    assert.strictEqual(renamed?.oldPath, 'rename-me.txt');
    assert.strictEqual(files.length, 4);
  });

  test('changedFiles includes untracked files when requested', async () => {
    const files = await changedFiles(repo, 'HEAD', true);
    const untracked = files.find((f) => f.path === 'untracked.txt');
    assert.strictEqual(untracked?.status, 'U');
    assert.strictEqual(files.length, 5);
  });

  test('showFile returns file content at a ref', async () => {
    const content = await showFile(repo, 'HEAD', 'modify-me.txt');
    assert.strictEqual(content, 'original content\nline two\nline three\n');
  });

});

suite('git wrapper during a conflicted merge', () => {
  let repo: string;
  let base: string;

  suiteSetup(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-git-conflict-test-'));
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    await git(repo, ['config', 'rerere.enabled', 'false']);
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'base\n');
    fs.writeFileSync(path.join(repo, 'restored.txt'), 'base\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);
    base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'feature\n');
    fs.writeFileSync(path.join(repo, 'restored.txt'), 'feature\n');
    await git(repo, ['commit', '-am', 'feature']);
    await git(repo, ['checkout', 'main']);
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'main\n');
    fs.writeFileSync(path.join(repo, 'restored.txt'), 'main\n');
    await git(repo, ['commit', '-am', 'main']);
    await git(repo, ['checkout', 'feature']);
    await assert.rejects(git(repo, ['merge', '--no-edit', 'main']));
    fs.writeFileSync(path.join(repo, 'restored.txt'), 'base\n');
  });

  suiteTeardown(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('changedFiles marks a conflicted file as a conflict', async () => {
    const files = await changedFiles(repo, base, true);
    assert.deepStrictEqual(
      files.find((f) => f.path === 'conflict.txt'),
      { path: 'conflict.txt', status: 'X' }
    );
  });

  test('changedFiles keeps a conflicted file whose content matches the base', async () => {
    const files = await changedFiles(repo, base, true);
    assert.deepStrictEqual(
      files.find((f) => f.path === 'restored.txt'),
      { path: 'restored.txt', status: 'X' }
    );
  });
});
