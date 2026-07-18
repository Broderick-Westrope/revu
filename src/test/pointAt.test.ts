import * as assert from 'assert';
import { parseLineRange } from '../guide/pointAt';

suite('parseLineRange', () => {
  test('parses a hyphenated range', () => {
    assert.deepStrictEqual(parseLineRange('Lines 10-20: x'), { start: 10, end: 20 });
  });

  test('parses a single line with end defaulting to start', () => {
    assert.deepStrictEqual(parseLineRange('Line 7: y'), { start: 7, end: 7 });
  });

  test('parses an en-dash range', () => {
    assert.deepStrictEqual(parseLineRange('Lines 3–8: z'), { start: 3, end: 8 });
  });

  test('is case-insensitive and tolerates spaces around the dash', () => {
    assert.deepStrictEqual(parseLineRange('lines 1 - 4: w'), { start: 1, end: 4 });
  });

  test('returns undefined when there is no match', () => {
    assert.strictEqual(parseLineRange('Refactors the retry loop'), undefined);
    assert.strictEqual(parseLineRange('See lines 10-20'), undefined);
  });

  test('returns undefined for undefined input', () => {
    assert.strictEqual(parseLineRange(undefined), undefined);
  });
});
