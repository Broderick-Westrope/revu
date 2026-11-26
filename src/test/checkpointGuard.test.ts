import * as assert from 'assert';
import { guardAction } from '../checkpointGuard';

const sha = 'a'.repeat(40);

suite('checkpoint guard', () => {
  test('an orphaned checkpoint prompts to re-pick', () => {
    assert.strictEqual(
      guardAction({ kind: 'orphaned', branch: 'feature', sha }, new Set()),
      'orphanPrompt'
    );
  });

  test('an already-prompted orphan SHA is deduped', () => {
    assert.strictEqual(
      guardAction({ kind: 'orphaned', branch: 'feature', sha }, new Set([sha])),
      'none'
    );
  });

  test('detached HEAD and healthy checkpoints do nothing', () => {
    assert.strictEqual(guardAction({ kind: 'detached' }, new Set()), 'none');
    assert.strictEqual(guardAction({ kind: 'explicit', branch: 'feature', sha }, new Set()), 'none');
  });
});
