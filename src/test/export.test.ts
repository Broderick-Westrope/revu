import * as assert from 'assert';
import { renderAll, renderComment } from '../comments/export';
import { LocalComment } from '../comments/model';

function makeComment(overrides: Partial<LocalComment>): LocalComment {
  return {
    id: 'id',
    path: 'src/foo/bar.ts',
    startLine: 1,
    endLine: 1,
    codeSnippet: 'code',
    languageId: 'typescript',
    text: 'comment text',
    createdAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

suite('markdown export', () => {
  test('renderComment renders a multi-line comment with quoted thread and diff hunk', () => {
    const comment = makeComment({
      path: 'src/foo/bar.ts',
      startLine: 42,
      endLine: 48,
      languageId: 'ts',
      codeSnippet: '// captured code snippet',
      text: 'My comment text here.',
      quotedThread: {
        author: 'alice',
        body: 'Why are we retrying here instead of failing fast?',
        path: 'src/foo/bar.ts',
        line: 44,
        diffHunk: '(diff hunk context)',
      },
    });
    const expected = [
      '### Comment 1 (lines 42-48)',
      '',
      '```ts',
      '// captured code snippet',
      '```',
      '',
      '> **Quoted PR comment** (@alice, on src/foo/bar.ts line 44):',
      '> Why are we retrying here instead of failing fast?',
      '>',
      '> ```',
      '> (diff hunk context)',
      '> ```',
      '',
      'My comment text here.',
    ].join('\n');
    assert.strictEqual(renderComment(comment), expected);
  });

  test('renderComment renders single-line label and omits quoted thread when absent', () => {
    const comment = makeComment({
      startLine: 42,
      endLine: 42,
      languageId: 'go',
      codeSnippet: 'return err',
      text: 'Wrap this error.',
    });
    const expected = [
      '### Comment 2 (line 42)',
      '',
      '```go',
      'return err',
      '```',
      '',
      'Wrap this error.',
    ].join('\n');
    assert.strictEqual(renderComment(comment, 2), expected);
  });

  test('renderComment omits diff hunk sub-block when absent', () => {
    const comment = makeComment({
      startLine: 3,
      endLine: 3,
      languageId: 'ts',
      codeSnippet: 'doThing();',
      text: 'Agreed with the thread.',
      quotedThread: {
        author: 'bob',
        body: 'Should this be async?',
        path: 'src/foo/bar.ts',
      },
    });
    const expected = [
      '### Comment 1 (line 3)',
      '',
      '```ts',
      'doThing();',
      '```',
      '',
      '> **Quoted PR comment** (@bob, on src/foo/bar.ts):',
      '> Should this be async?',
      '',
      'Agreed with the thread.',
    ].join('\n');
    assert.strictEqual(renderComment(comment), expected);
  });

  test('renderAll groups by file and orders comments by start line', () => {
    const comments = [
      makeComment({
        id: 'c1',
        path: 'src/foo/bar.ts',
        startLine: 42,
        endLine: 48,
        languageId: 'ts',
        codeSnippet: '// captured code snippet',
        text: 'My comment text here.',
        quotedThread: {
          author: 'alice',
          body: 'Why are we retrying here instead of failing fast?',
          path: 'src/foo/bar.ts',
          line: 44,
          diffHunk: '(diff hunk context)',
        },
      }),
      makeComment({
        id: 'c2',
        path: 'src/baz.go',
        startLine: 7,
        endLine: 7,
        languageId: 'go',
        codeSnippet: 'return err',
        text: 'Wrap this error.',
      }),
      makeComment({
        id: 'c3',
        path: 'src/foo/bar.ts',
        startLine: 5,
        endLine: 6,
        languageId: 'ts',
        codeSnippet: 'const a = 1;\nconst b = 2;',
        text: 'Combine these.',
      }),
    ];
    const expected = [
      '# Review comments',
      '',
      '## src/baz.go',
      '',
      '### Comment 1 (line 7)',
      '',
      '```go',
      'return err',
      '```',
      '',
      'Wrap this error.',
      '',
      '## src/foo/bar.ts',
      '',
      '### Comment 1 (lines 5-6)',
      '',
      '```ts',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      'Combine these.',
      '',
      '### Comment 2 (lines 42-48)',
      '',
      '```ts',
      '// captured code snippet',
      '```',
      '',
      '> **Quoted PR comment** (@alice, on src/foo/bar.ts line 44):',
      '> Why are we retrying here instead of failing fast?',
      '>',
      '> ```',
      '> (diff hunk context)',
      '> ```',
      '',
      'My comment text here.',
      '',
    ].join('\n');
    assert.strictEqual(renderAll(comments), expected);
  });

  test('renderAll with no comments renders only the heading', () => {
    assert.strictEqual(renderAll([]), '# Review comments\n\n\n');
  });
});
