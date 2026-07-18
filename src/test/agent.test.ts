import * as assert from 'assert';
import { computeTimeoutSeconds } from '../guide/agent';

suite('computeTimeoutSeconds', () => {
  test('small prompt returns the base timeout', () => {
    assert.strictEqual(computeTimeoutSeconds(1000, 120, 600), 120);
    assert.strictEqual(computeTimeoutSeconds(0, 120, 600), 120);
  });

  test('scales with prompt size above the base', () => {
    assert.strictEqual(computeTimeoutSeconds(150000, 120, 600), 210);
  });

  test('huge prompt is capped at the max', () => {
    assert.strictEqual(computeTimeoutSeconds(10_000_000, 120, 600), 600);
  });
});
