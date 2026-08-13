import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startLogsWatcher } from '../gitWatcher';

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

async function until(condition: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met within timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const repos: string[] = [];

async function initRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-git-watcher-test-'));
  repos.push(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  return repo;
}

async function commitFile(repo: string, name: string, content: string): Promise<void> {
  fs.writeFileSync(path.join(repo, name), content);
  await git(repo, ['add', name]);
  await git(repo, ['commit', '-m', `add ${name}`]);
}

suite('git watcher', () => {
  suiteTeardown(() => {
    for (const repo of repos) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('fires after a commit made via the git CLI', async () => {
    const repo = await initRepo();
    await commitFile(repo, 'a.txt', 'one\n');
    const dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
    let fired = 0;
    let failed = 0;
    const watcher = startLogsWatcher(
      dir,
      () => {
        fired += 1;
      },
      () => {
        failed += 1;
      },
      { debounceMs: 50 }
    );
    try {
      await commitFile(repo, 'b.txt', 'two\n');
      await until(() => fired > 0);
      assert.strictEqual(failed, 0);
    } finally {
      watcher.dispose();
    }
  });

  test('debounces bursts of git activity into few events', async () => {
    const repo = await initRepo();
    await commitFile(repo, 'a.txt', 'one\n');
    const dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
    let fired = 0;
    const watcher = startLogsWatcher(
      dir,
      () => {
        fired += 1;
      },
      () => {},
      { debounceMs: 200 }
    );
    try {
      await commitFile(repo, 'b.txt', 'two\n');
      await commitFile(repo, 'c.txt', 'three\n');
      await commitFile(repo, 'd.txt', 'four\n');
      await until(() => fired > 0);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.ok(fired <= 2, `expected at most 2 events, got ${fired}`);
    } finally {
      watcher.dispose();
    }
  });

  test('missing logs dir: registration does not throw and fires after the first commit', async () => {
    const repo = await initRepo();
    const dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
    assert.ok(!fs.existsSync(path.join(dir, 'logs')));
    let fired = 0;
    let failed = 0;
    const watcher = startLogsWatcher(
      dir,
      () => {
        fired += 1;
      },
      () => {
        failed += 1;
      },
      { debounceMs: 50, pollIntervalMs: 100 }
    );
    try {
      await commitFile(repo, 'a.txt', 'one\n');
      await until(() => fired > 0);
      assert.strictEqual(failed, 0);
    } finally {
      watcher.dispose();
    }
  });

  test('dispose stops events', async () => {
    const repo = await initRepo();
    await commitFile(repo, 'a.txt', 'one\n');
    const dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
    let fired = 0;
    const watcher = startLogsWatcher(
      dir,
      () => {
        fired += 1;
      },
      () => {},
      { debounceMs: 50 }
    );
    watcher.dispose();
    await commitFile(repo, 'b.txt', 'two\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(fired, 0);
  });
});
