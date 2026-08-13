import * as assert from 'assert';
import { guardAction } from '../checkpointGuard';
import { ReviewScope } from '../scope';

const sha = 'a'.repeat(40);

const checkpointScope: ReviewScope = {
  type: 'checkpoint',
  baseRef: sha,
  repoRoot: '/r',
  branch: 'feature',
};

const workingTreeScope: ReviewScope = { type: 'workingTree', baseRef: 'HEAD', repoRoot: '/r' };

suite('checkpoint guard', () => {
  test('orphaned with no active scope prompts to re-pick', () => {
    assert.strictEqual(
      guardAction({ kind: 'orphaned', branch: 'feature', sha }, undefined, 'feature', new Set()),
      'orphanPrompt'
    );
  });

  test('orphaned with a matching checkpoint scope prompts to re-pick', () => {
    assert.strictEqual(
      guardAction(
        { kind: 'orphaned', branch: 'feature', sha },
        checkpointScope,
        'feature',
        new Set()
      ),
      'orphanPrompt'
    );
  });

  test('already-prompted orphan SHA is deduped', () => {
    assert.strictEqual(
      guardAction(
        { kind: 'orphaned', branch: 'feature', sha },
        undefined,
        'feature',
        new Set([sha])
      ),
      'none'
    );
  });

  test('branch mismatch with an active checkpoint scope prompts to restart or end', () => {
    assert.strictEqual(
      guardAction(
        { kind: 'implicit', branch: 'other', sha: 'b'.repeat(40) },
        checkpointScope,
        'other',
        new Set()
      ),
      'branchPrompt'
    );
  });

  test('branch mismatch without an active checkpoint scope does nothing', () => {
    assert.strictEqual(
      guardAction(
        { kind: 'implicit', branch: 'other', sha: 'b'.repeat(40) },
        workingTreeScope,
        'other',
        new Set()
      ),
      'none'
    );
    assert.strictEqual(
      guardAction(
        { kind: 'implicit', branch: 'other', sha: 'b'.repeat(40) },
        undefined,
        'other',
        new Set()
      ),
      'none'
    );
  });

  test('detached HEAD does nothing', () => {
    assert.strictEqual(guardAction({ kind: 'detached' }, checkpointScope, undefined, new Set()), 'none');
  });

  test('orphaned with a workingTree scope active still prompts', () => {
    assert.strictEqual(
      guardAction(
        { kind: 'orphaned', branch: 'feature', sha },
        workingTreeScope,
        'feature',
        new Set()
      ),
      'orphanPrompt'
    );
  });

  test('matching branch with an active checkpoint scope does nothing', () => {
    assert.strictEqual(
      guardAction({ kind: 'explicit', branch: 'feature', sha }, checkpointScope, 'feature', new Set()),
      'none'
    );
  });

  test('deduped orphan with a branch mismatch still prompts for the branch switch', () => {
    const staleScope: ReviewScope = { ...checkpointScope, branch: 'old-branch' };
    assert.strictEqual(
      guardAction(
        { kind: 'orphaned', branch: 'feature', sha },
        staleScope,
        'feature',
        new Set([sha])
      ),
      'branchPrompt'
    );
  });
});
