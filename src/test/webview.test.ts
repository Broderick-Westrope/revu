import * as assert from 'assert';
import * as vscode from 'vscode';
import { GuideCache } from '../guide/cache';
import { Guide } from '../guide/model';
import { escapeHtml, renderGuideHtml, renderInline } from '../guide/webview';

const guide: Guide = {
  summary: 'Overall summary of the change.',
  groups: [
    {
      title: 'Auth service refactor',
      theme: 'Token refresh logic extracted into a helper',
      attention: ['Check the retry loop bounds', 'Watch for off-by-one errors'],
      files: [{ path: 'src/auth.ts', note: 'core change' }, { path: 'src/auth.test.ts' }],
    },
    {
      title: 'Docs',
      theme: 'README updates',
      attention: [],
      files: [{ path: 'README.md' }],
    },
  ],
};

suite('renderGuideHtml', () => {
  const html = renderGuideHtml(guide, 'test-nonce');

  test('includes summary, numbered group headings, theme, attention, and files in order', () => {
    assert.ok(html.includes('Overall summary of the change.'));
    assert.ok(html.includes('1. Auth service refactor'));
    assert.ok(html.includes('2. Docs'));
    assert.ok(html.includes('Token refresh logic extracted into a helper'));
    assert.ok(html.includes('Check the retry loop bounds'));
    assert.ok(html.includes('Watch for off-by-one errors'));
    assert.ok(html.includes('data-path="src/auth.ts"'));
    assert.ok(html.includes('core change'));
    assert.ok(html.includes('data-path="README.md"'));
    assert.ok(html.indexOf('1. Auth service refactor') < html.indexOf('2. Docs'));
    assert.ok(html.indexOf('Overall summary') < html.indexOf('1. Auth service refactor'));
  });

  test('applies the nonce to the CSP and script tag', () => {
    assert.ok(html.includes(`script-src 'nonce-test-nonce'`));
    assert.ok(html.includes('<script nonce="test-nonce">'));
    assert.ok(html.includes('Content-Security-Policy'));
  });

  test('escapes HTML in guide-derived text', () => {
    const hostile: Guide = {
      summary: 'summary <img src=x onerror=alert(1)>',
      groups: [
        {
          title: 'evil <script>alert(1)</script> title',
          theme: 'theme & <b>bold</b>',
          attention: ['note "quoted" <i>'],
          files: [{ path: 'a<b>.ts', note: "note with 'quotes'" }],
        },
      ],
    };
    const out = renderGuideHtml(hostile, 'n');
    assert.ok(!out.includes('<script>alert(1)</script>'));
    assert.ok(out.includes('evil &lt;script&gt;alert(1)&lt;/script&gt; title'));
    assert.ok(out.includes('summary &lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(out.includes('theme &amp; &lt;b&gt;bold&lt;/b&gt;'));
    assert.ok(out.includes('note &quot;quoted&quot; &lt;i&gt;'));
    assert.ok(out.includes('a&lt;b&gt;.ts'));
    assert.ok(out.includes('note with &#39;quotes&#39;'));
  });

  test('omits the attention list when empty', () => {
    const docsSection = html.slice(html.indexOf('2. Docs'));
    assert.ok(!docsSection.includes('class="attention"'));
  });

  test('marks read files with the visited class and check mark', () => {
    const out = renderGuideHtml(guide, 'n', new Set(['src/auth.ts']));
    assert.ok(out.includes('class="file visited" data-path="src/auth.ts"'));
    assert.ok(out.includes('class="file" data-path="README.md"'));
    const authRow = out.slice(out.indexOf('data-path="src/auth.ts"'), out.indexOf('data-path="src/auth.test.ts"'));
    assert.ok(authRow.includes('✓'));
  });

  test('renders unread rows with an unread toggle', () => {
    assert.ok(!html.includes('class="file visited"'));
    assert.ok(html.includes('<button class="check" title="Toggle read">○</button>'));
  });
});

suite('escapeHtml', () => {
  test('escapes all special characters', () => {
    assert.strictEqual(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    assert.strictEqual(escapeHtml('plain text'), 'plain text');
  });
});

suite('renderInline', () => {
  test('renders backtick spans as code elements', () => {
    assert.strictEqual(renderInline('call `foo()` here'), 'call <code>foo()</code> here');
  });

  test('escapes HTML inside code spans', () => {
    assert.strictEqual(renderInline('`<script>`'), '<code>&lt;script&gt;</code>');
  });

  test('leaves an unmatched backtick literal', () => {
    assert.strictEqual(renderInline('a ` b'), 'a ` b');
  });

  test('escapes HTML outside code spans', () => {
    assert.strictEqual(renderInline('<b>`x`</b>'), '&lt;b&gt;<code>x</code>&lt;/b&gt;');
  });

  test('handles multiple spans non-greedily', () => {
    assert.strictEqual(renderInline('`a` and `b`'), '<code>a</code> and <code>b</code>');
  });
});

function stubMemento(): vscode.Memento {
  const data = new Map<string, unknown>();
  return {
    keys: () => [...data.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      return data.has(key) && data.get(key) !== undefined ? (data.get(key) as T) : defaultValue;
    },
    update: (key: string, value: unknown): Thenable<void> => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

suite('guide read state', () => {
  test('setRead persists and isRead reflects it', async () => {
    const cache = new GuideCache(stubMemento());
    assert.strictEqual(cache.isRead('scope', 'a.ts'), false);
    await cache.setRead('scope', 'a.ts', true);
    assert.strictEqual(cache.isRead('scope', 'a.ts'), true);
    assert.deepStrictEqual(cache.readPaths('scope'), ['a.ts']);
    await cache.setRead('scope', 'a.ts', false);
    assert.strictEqual(cache.isRead('scope', 'a.ts'), false);
  });

  test('read state is scoped per scope key', async () => {
    const cache = new GuideCache(stubMemento());
    await cache.setRead('one', 'a.ts', true);
    assert.strictEqual(cache.isRead('two', 'a.ts'), false);
  });

  test('put clears read state for the scope', async () => {
    const cache = new GuideCache(stubMemento());
    await cache.setRead('scope', 'a.ts', true);
    await cache.put({
      guide: { summary: 's', groups: [] },
      scopeKey: 'scope',
      hash: 'h',
      generatedAt: '2026-07-18T00:00:00.000Z',
    });
    assert.deepStrictEqual(cache.readPaths('scope'), []);
  });
});
