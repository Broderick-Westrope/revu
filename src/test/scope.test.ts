import * as assert from 'assert';
import { ReviewScope, scopeIncludesUntracked, scopeKey } from '../scope';

suite('scope', () => {
  test('scopeKey is stable for existing scope types', () => {
    assert.strictEqual(
      scopeKey({ type: 'workingTree', baseRef: 'HEAD', repoRoot: '/r' }),
      'workingTree'
    );
    assert.strictEqual(
      scopeKey({ type: 'branch', baseRef: 'abc123', repoRoot: '/r' }),
      'branch:abc123'
    );
  });

  test('scopeKey for checkpoint scopes is branch-stable across baseRef changes', () => {
    const a: ReviewScope = {
      type: 'checkpoint',
      baseRef: 'a'.repeat(40),
      repoRoot: '/r',
      branch: 'feature-x',
    };
    const b: ReviewScope = { ...a, baseRef: 'b'.repeat(40) };
    assert.strictEqual(scopeKey(a), 'checkpoint:feature-x');
    assert.strictEqual(scopeKey(b), 'checkpoint:feature-x');
  });

  test('scopeIncludesUntracked truth table', () => {
    assert.strictEqual(
      scopeIncludesUntracked({ type: 'workingTree', baseRef: 'HEAD', repoRoot: '/r' }),
      true
    );
    assert.strictEqual(
      scopeIncludesUntracked({
        type: 'checkpoint',
        baseRef: 'a'.repeat(40),
        repoRoot: '/r',
        branch: 'feature-x',
      }),
      true
    );
    assert.strictEqual(
      scopeIncludesUntracked({ type: 'branch', baseRef: 'abc123', repoRoot: '/r' }),
      false
    );
  });
});
