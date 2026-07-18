import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');
const SELF = 'readonly.test.ts';

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
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
];

suite('read-only GitHub guard', () => {
  test('src contains no GitHub write paths', () => {
    const files = collectSourceFiles(SRC_ROOT);
    assert.ok(files.length > 0, 'expected source files to scan');
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(SRC_ROOT, file)}: ${name}`);
        }
      }
    }
    assert.deepStrictEqual(violations, []);
  });
});
