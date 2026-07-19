import * as assert from 'assert';
import { ChangedFile } from '../git';
import { Guide, parseGuide, reconcileGuide } from '../guide/model';
import { buildPrompt, MAX_PROMPT_CHARS } from '../guide/prompt';

function makeDiffSection(path: string, bodyLines: number): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
  ];
  for (let i = 0; i < bodyLines - 3; i++) {
    lines.push(`+line ${i} of ${path}`);
  }
  return lines.join('\n');
}

const validGuide: Guide = {
  summary: 'A change to the auth service and its tests.',
  groups: [
    {
      title: 'Auth service refactor',
      theme: 'Token refresh logic extracted into a helper',
      attention: ['Check the retry loop bounds'],
      files: [{ path: 'src/auth.ts', note: 'core change' }, { path: 'src/auth.test.ts' }],
    },
  ],
};

suite('guide prompt builder', () => {
  const files: ChangedFile[] = [
    { path: 'src/a.ts', status: 'M' },
    { path: 'src/b.ts', status: 'A' },
  ];

  test('includes file_list and diff sections with full diff when under limits', () => {
    const diff = [makeDiffSection('src/a.ts', 10), makeDiffSection('src/b.ts', 10)].join('\n');
    const prompt = buildPrompt(files, diff);
    assert.ok(prompt.includes('<file_list>'));
    assert.ok(prompt.includes('</file_list>'));
    assert.ok(prompt.includes('<diff>'));
    assert.ok(prompt.includes('</diff>'));
    assert.ok(prompt.includes('M\tsrc/a.ts'));
    assert.ok(prompt.includes('A\tsrc/b.ts'));
    assert.ok(prompt.includes('<file path="src/a.ts" status="M" truncated="false">'));
    assert.ok(prompt.includes('<file path="src/b.ts" status="A" truncated="false">'));
    assert.ok(prompt.includes('diff --git a/src/a.ts b/src/a.ts'));
    assert.ok(prompt.includes('line 5 of src/b.ts'));
    assert.doesNotMatch(prompt, /<file [^>]*truncated="true"/);
  });

  test('places instructions and schema after the diff', () => {
    const diff = makeDiffSection('src/a.ts', 10);
    const prompt = buildPrompt([files[0]], diff);
    const diffEnd = prompt.indexOf('</diff>');
    const instructions = prompt.indexOf('<instructions>');
    const schema = prompt.indexOf('<schema>');
    assert.ok(diffEnd !== -1);
    assert.ok(instructions > diffEnd);
    assert.ok(schema > instructions);
  });

  test('keeps long per-file diffs intact when under the total cap', () => {
    const diff = makeDiffSection('src/a.ts', 500);
    const prompt = buildPrompt([files[0]], diff);
    assert.ok(prompt.includes('line 490 of src/a.ts'));
    assert.doesNotMatch(prompt, /<file [^>]*truncated="true"/);
    assert.ok(!prompt.includes('[... truncated'));
  });

  test('drops whole largest diff bodies first when over the total character cap', () => {
    const manyFiles: ChangedFile[] = [];
    const sections: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = `src/big-${i}.ts`;
      manyFiles.push({ path: p, status: 'M' });
      sections.push(makeDiffSection(p, 400));
    }
    manyFiles.push({ path: 'src/small.ts', status: 'M' });
    sections.push(makeDiffSection('src/small.ts', 10));
    const prompt = buildPrompt(manyFiles, sections.join('\n'));
    assert.ok(prompt.length <= MAX_PROMPT_CHARS + 1000);
    assert.match(prompt, /<file path="src\/big-\d+\.ts" status="M" truncated="true" \/>/);
    assert.ok(prompt.includes('M\tsrc/big-0.ts'));
    assert.ok(prompt.includes('<file path="src/small.ts" status="M" truncated="false">'));
    assert.ok(prompt.includes('line 5 of src/small.ts'));
  });

  test('includes pull_request section only when provided', () => {
    const diff = makeDiffSection('src/a.ts', 10);
    const withPr = buildPrompt([files[0]], diff, 'Title: Fix auth');
    assert.ok(withPr.includes('<pull_request>'));
    assert.ok(withPr.includes('Title: Fix auth'));
    const withoutPr = buildPrompt([files[0]], diff);
    assert.ok(!withoutPr.includes('<pull_request>'));
  });
});

suite('parseGuide', () => {
  const json = JSON.stringify(validGuide);

  test('parses clean JSON', () => {
    const guide = parseGuide(json);
    assert.strictEqual(guide.summary, validGuide.summary);
    assert.strictEqual(guide.groups.length, 1);
    assert.strictEqual(guide.groups[0].files[0].path, 'src/auth.ts');
    assert.strictEqual(guide.groups[0].files[0].note, 'core change');
    assert.strictEqual(guide.groups[0].files[1].note, undefined);
  });

  test('parses a ```json fenced block', () => {
    const raw = `Here is the guide:\n\`\`\`json\n${json}\n\`\`\`\nDone.`;
    const guide = parseGuide(raw);
    assert.strictEqual(guide.groups[0].title, 'Auth service refactor');
  });

  test('parses prose-wrapped JSON via balanced-brace extraction', () => {
    const raw = `Sure! The guide is ${json} and that covers everything. Note: {unbalanced`;
    const guide = parseGuide(raw);
    assert.strictEqual(guide.groups[0].theme, 'Token refresh logic extracted into a helper');
  });

  test('balanced-brace extraction handles braces inside strings', () => {
    const tricky: Guide = {
      ...validGuide,
      summary: 'Uses ${interpolation} and } braces { in text',
    };
    const raw = `prefix ${JSON.stringify(tricky)} trailing } garbage }`;
    const guide = parseGuide(raw);
    assert.strictEqual(guide.summary, 'Uses ${interpolation} and } braces { in text');
  });

  test('parses JSON following an <analysis> preamble', () => {
    const raw = `<analysis>\nTheme 1: auth refactor -> src/auth.ts, src/auth.test.ts\n</analysis>\n${json}`;
    const guide = parseGuide(raw);
    assert.strictEqual(guide.summary, validGuide.summary);
    assert.strictEqual(guide.groups[0].title, 'Auth service refactor');
  });

  test('throws on garbage input', () => {
    assert.throws(() => parseGuide('no json here at all'), /No JSON object found/);
    assert.throws(() => parseGuide('{"summary": "x", "groups": []}'), /groups/);
    assert.throws(
      () =>
        parseGuide(
          JSON.stringify({ summary: 'x', groups: [{ title: 't', theme: 'th', attention: [], files: [] }] })
        ),
      /at least one file/
    );
    assert.throws(() => parseGuide('{"broken": '), /No JSON object found|not valid JSON/);
  });
});

suite('reconcileGuide', () => {
  const changedPaths = ['src/auth.ts', 'src/auth.test.ts', 'src/util.ts'];

  function guideWith(groups: Guide['groups']): Guide {
    return { summary: 'sum', groups };
  }

  test('is a no-op on a well-formed guide', () => {
    const guide = guideWith([
      {
        title: 'Auth',
        theme: 'auth changes',
        attention: [],
        files: [{ path: 'src/auth.ts' }, { path: 'src/auth.test.ts' }],
      },
      { title: 'Util', theme: 'util changes', attention: [], files: [{ path: 'src/util.ts' }] },
    ]);
    assert.deepStrictEqual(reconcileGuide(guide, changedPaths), guide);
  });

  test('drops invented paths and drops groups left empty', () => {
    const guide = guideWith([
      {
        title: 'Auth',
        theme: 'auth changes',
        attention: [],
        files: [
          { path: 'src/auth.ts' },
          { path: 'src/auth.test.ts' },
          { path: 'src/util.ts' },
          { path: 'src/invented.ts' },
        ],
      },
      { title: 'Ghost', theme: 'nothing real', attention: [], files: [{ path: 'src/fake.ts' }] },
    ]);
    const result = reconcileGuide(guide, changedPaths);
    assert.strictEqual(result.groups.length, 1);
    assert.deepStrictEqual(
      result.groups[0].files.map((f) => f.path),
      changedPaths
    );
  });

  test('appends missing paths in an Other changes group', () => {
    const guide = guideWith([
      { title: 'Auth', theme: 'auth changes', attention: [], files: [{ path: 'src/auth.ts' }] },
    ]);
    const result = reconcileGuide(guide, changedPaths);
    assert.strictEqual(result.groups.length, 2);
    const other = result.groups[1];
    assert.strictEqual(other.title, 'Other changes');
    assert.strictEqual(other.theme, 'Files not classified by the guide generator');
    assert.deepStrictEqual(other.attention, []);
    assert.deepStrictEqual(other.files, [{ path: 'src/auth.test.ts' }, { path: 'src/util.ts' }]);
  });

  test('keeps only the first occurrence of duplicated paths', () => {
    const guide = guideWith([
      {
        title: 'Auth',
        theme: 'auth changes',
        attention: [],
        files: [{ path: 'src/auth.ts', note: 'first' }, { path: 'src/util.ts' }],
      },
      {
        title: 'Dupes',
        theme: 'repeats',
        attention: [],
        files: [{ path: 'src/auth.ts', note: 'second' }],
      },
      { title: 'Tests', theme: 'test changes', attention: [], files: [{ path: 'src/auth.test.ts' }] },
    ]);
    const result = reconcileGuide(guide, changedPaths);
    assert.deepStrictEqual(
      result.groups.map((g) => g.title),
      ['Auth', 'Tests']
    );
    assert.strictEqual(result.groups[0].files[0].note, 'first');
  });
});
