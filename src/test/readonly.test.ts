import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');
const SELF = 'readonly.test.ts';
const TEST_DIR = 'test';

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === SRC_ROOT && entry.name === TEST_DIR) {
        continue;
      }
      results.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && entry.name !== SELF) {
      results.push(full);
    }
  }
  return results;
}

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'gh pr comment invocation', pattern: /gh\s+pr\s+comment|['"]pr['"],\s*['"]comment['"]/ },
  { name: 'gh pr review invocation', pattern: /gh\s+pr\s+review|['"]pr['"],\s*['"]review['"]/ },
  {
    name: 'gh api with a non-GET method',
    pattern: /(?:-X|--method)['"=\s,:]*(?:POST|PATCH|PUT|DELETE)/i,
  },
  { name: 'GraphQL mutation', pattern: /\bmutation\b/i },
  { name: 'git push invocation', pattern: /\bgit\s+push\b|['"]push['"]/ },
  {
    name: 'gh stack invocation other than view',
    pattern:
      /\bgh\s+stack\s+(?:push|submit|sync|merge|rebase|link|init|add|checkout|unstack|modify|up|down|top|bottom|switch|trunk)\b|['"]stack['"],\s*['"](?!view['"])/,
  },
];

function violationsIn(content: string): string[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(content)).map(({ name }) => name);
}

suite('read-only GitHub guard', () => {
  test('src contains no GitHub write paths', () => {
    const files = collectSourceFiles(SRC_ROOT);
    assert.ok(files.length > 0, 'expected source files to scan');
    const violations: string[] = [];
    for (const file of files) {
      for (const name of violationsIn(fs.readFileSync(file, 'utf8'))) {
        violations.push(`${path.relative(SRC_ROOT, file)}: ${name}`);
      }
    }
    assert.deepStrictEqual(violations, []);
  });

  test('patterns catch git push and every gh stack subcommand but view', () => {
    const samples = [
      "exec('git push origin main')",
      "git(root, ['push', 'origin', 'main'])",
      "execFile('git', ['push'])",
      ...['push', 'submit', 'sync', 'merge', 'rebase', 'link', 'init', 'add', 'checkout', 'unstack'].flatMap((sub) => [
        `exec('gh stack ${sub}')`,
        `gh(cwd, ['stack', '${sub}'])`,
      ]),
    ];
    const missed = samples.filter((sample) => violationsIn(sample).length === 0);
    assert.deepStrictEqual(missed, []);
  });

  test("patterns allow Revu's own git merge", () => {
    assert.deepStrictEqual(violationsIn("git(root, ['merge', '--no-edit', parentRef])"), []);
    assert.deepStrictEqual(violationsIn("gh(cwd, ['stack', 'view', '--json'])"), []);
  });
});
