import * as assert from 'assert';
import { parseGhStackView, parsePrList, parseThreadsResponse } from '../github/gh';

interface FixtureComment {
  body: string;
  diffHunk: string;
  createdAt: string;
  url: string;
  author: { login: string } | null;
}

interface FixtureThread {
  path: string;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  comments: { nodes: FixtureComment[] };
}

function makeComment(overrides: Partial<FixtureComment> = {}): FixtureComment {
  return {
    body: 'Looks good overall.',
    diffHunk: '@@ -1,3 +1,4 @@\n context\n+added line',
    createdAt: '2026-07-18T10:00:00Z',
    url: 'https://github.com/acme/widgets/pull/12#discussion_r1',
    author: { login: 'alice' },
    ...overrides,
  };
}

function makeResponse(threads: FixtureThread[]): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads,
          },
        },
      },
    },
  });
}

suite('github thread parsing', () => {
  test('parses a normal single-comment thread', () => {
    const json = makeResponse([
      {
        path: 'src/foo.ts',
        line: 12,
        startLine: 10,
        isResolved: false,
        comments: { nodes: [makeComment()] },
      },
    ]);
    const threads = parseThreadsResponse(json);
    assert.strictEqual(threads.length, 1);
    assert.deepStrictEqual(threads[0], {
      path: 'src/foo.ts',
      line: 12,
      startLine: 10,
      isResolved: false,
      diffHunk: '@@ -1,3 +1,4 @@\n context\n+added line',
      comments: [
        {
          author: 'alice',
          body: 'Looks good overall.',
          createdAt: '2026-07-18T10:00:00Z',
          url: 'https://github.com/acme/widgets/pull/12#discussion_r1',
        },
      ],
    });
  });

  test('preserves null line for outdated threads', () => {
    const json = makeResponse([
      {
        path: 'src/old.ts',
        line: null,
        startLine: null,
        isResolved: true,
        comments: { nodes: [makeComment()] },
      },
    ]);
    const threads = parseThreadsResponse(json);
    assert.strictEqual(threads.length, 1);
    assert.strictEqual(threads[0].line, null);
    assert.strictEqual(threads[0].startLine, null);
    assert.strictEqual(threads[0].isResolved, true);
  });

  test('parses multi-comment threads using the first diffHunk', () => {
    const json = makeResponse([
      {
        path: 'src/foo.ts',
        line: 5,
        startLine: null,
        isResolved: false,
        comments: {
          nodes: [
            makeComment({ body: 'First question', diffHunk: '@@ hunk one @@' }),
            makeComment({
              body: 'Follow-up answer',
              diffHunk: '@@ hunk two @@',
              author: { login: 'bob' },
              url: 'https://github.com/acme/widgets/pull/12#discussion_r2',
            }),
          ],
        },
      },
    ]);
    const threads = parseThreadsResponse(json);
    assert.strictEqual(threads[0].diffHunk, '@@ hunk one @@');
    assert.strictEqual(threads[0].comments.length, 2);
    assert.strictEqual(threads[0].comments[0].author, 'alice');
    assert.strictEqual(threads[0].comments[1].author, 'bob');
    assert.strictEqual(threads[0].comments[1].body, 'Follow-up answer');
  });

  test('parses a merged multi-page document with many nodes', () => {
    const threads: FixtureThread[] = Array.from({ length: 3 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      startLine: null,
      isResolved: false,
      comments: { nodes: [makeComment({ body: `Comment ${i}` })] },
    }));
    const parsed = parseThreadsResponse(makeResponse(threads));
    assert.strictEqual(parsed.length, 3);
    assert.deepStrictEqual(
      parsed.map((t) => t.path),
      ['src/file0.ts', 'src/file1.ts', 'src/file2.ts']
    );
  });

  test('falls back to ghost for deleted authors and empty diffHunk for empty threads', () => {
    const json = makeResponse([
      {
        path: 'src/foo.ts',
        line: 3,
        startLine: null,
        isResolved: false,
        comments: { nodes: [makeComment({ author: null })] },
      },
      {
        path: 'src/bar.ts',
        line: 9,
        startLine: null,
        isResolved: false,
        comments: { nodes: [] },
      },
    ]);
    const threads = parseThreadsResponse(json);
    assert.strictEqual(threads[0].comments[0].author, 'ghost');
    assert.strictEqual(threads[1].diffHunk, '');
    assert.deepStrictEqual(threads[1].comments, []);
  });

  test('returns empty array when reviewThreads is missing', () => {
    assert.deepStrictEqual(parseThreadsResponse('{"data":{}}'), []);
  });

  test('merges concatenated JSON documents from older gh --paginate output', () => {
    const pageOne = makeResponse([
      {
        path: 'src/page1.ts',
        line: 1,
        startLine: null,
        isResolved: false,
        comments: { nodes: [makeComment({ body: 'Page one, with "quotes" and }braces{' })] },
      },
    ]);
    const pageTwo = makeResponse([
      {
        path: 'src/page2.ts',
        line: 2,
        startLine: null,
        isResolved: true,
        comments: { nodes: [makeComment({ body: 'Page two' })] },
      },
    ]);
    const threads = parseThreadsResponse(`${pageOne}\n${pageTwo}`);
    assert.strictEqual(threads.length, 2);
    assert.deepStrictEqual(
      threads.map((t) => t.path),
      ['src/page1.ts', 'src/page2.ts']
    );
    assert.strictEqual(threads[0].comments[0].body, 'Page one, with "quotes" and }braces{');
    assert.strictEqual(threads[1].isResolved, true);
  });

  test('merges concatenated JSON documents without newline separators', () => {
    const pageOne = makeResponse([
      {
        path: 'src/a.ts',
        line: 1,
        startLine: null,
        isResolved: false,
        comments: { nodes: [makeComment()] },
      },
    ]);
    const pageTwo = makeResponse([
      {
        path: 'src/b.ts',
        line: 2,
        startLine: null,
        isResolved: false,
        comments: { nodes: [makeComment()] },
      },
    ]);
    const threads = parseThreadsResponse(pageOne + pageTwo);
    assert.deepStrictEqual(
      threads.map((t) => t.path),
      ['src/a.ts', 'src/b.ts']
    );
  });
});

suite('github stack and PR list parsing', () => {
  test('parses gh stack view JSON into layers trunk-first', () => {
    const json = JSON.stringify({
      trunk: 'main',
      currentBranch: 'api',
      branches: [
        { name: 'auth', head: 'h1', base: 'b1', isCurrent: false, isMerged: true, isQueued: false, needsRebase: false, pr: { number: 1, url: 'u1', state: 'MERGED' } },
        { name: 'api', head: 'h2', base: 'b2', isCurrent: true, isMerged: false, isQueued: false, needsRebase: true },
      ],
    });

    assert.deepStrictEqual(parseGhStackView(json), {
      trunk: 'main',
      branches: [
        { name: 'auth', base: 'b1', isMerged: true, needsRebase: false },
        { name: 'api', base: 'b2', isMerged: false, needsRebase: true },
      ],
    });
  });

  test('drops PRs opened from forks so a same-named local branch is not matched', () => {
    const json = JSON.stringify([
      { number: 8, url: 'u8', state: 'OPEN', headRefName: 'main', baseRefName: 'main', isCrossRepository: true },
    ]);

    assert.deepStrictEqual(parsePrList(json), []);
  });

  test('parses gh pr list JSON and drops unknown states', () => {
    const json = JSON.stringify([
      { number: 4, url: 'u4', state: 'OPEN', headRefName: 'b', baseRefName: 'a' },
      { number: 5, url: 'u5', state: 'WEIRD', headRefName: 'c', baseRefName: 'main' },
    ]);

    assert.deepStrictEqual(parsePrList(json), [
      { number: 4, url: 'u4', state: 'OPEN', headRefName: 'b', baseRefName: 'a' },
    ]);
  });
});
