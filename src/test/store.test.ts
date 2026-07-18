import * as assert from 'assert';
import * as vscode from 'vscode';
import { LocalComment } from '../comments/model';
import { CommentStore } from '../comments/store';

function stubMemento(): vscode.Memento {
  const data = new Map<string, unknown>();
  return {
    keys: () => [...data.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      return data.has(key) ? (data.get(key) as T) : defaultValue;
    },
    update: (key: string, value: unknown): Thenable<void> => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function makeComment(overrides: Partial<LocalComment> = {}): LocalComment {
  return {
    id: overrides.id ?? 'id-1',
    path: 'src/foo.ts',
    startLine: 1,
    endLine: 2,
    codeSnippet: 'const x = 1;',
    languageId: 'typescript',
    text: 'looks wrong',
    createdAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

suite('comment store', () => {
  test('all returns empty array when nothing stored', () => {
    const store = new CommentStore(stubMemento());
    assert.deepStrictEqual(store.all(), []);
  });

  test('add persists and all returns the comment', async () => {
    const store = new CommentStore(stubMemento());
    const comment = makeComment();
    await store.add(comment);
    assert.deepStrictEqual(store.all(), [comment]);
  });

  test('update changes only the matching comment text', async () => {
    const store = new CommentStore(stubMemento());
    await store.add(makeComment({ id: 'a' }));
    await store.add(makeComment({ id: 'b' }));
    await store.update('a', 'revised');
    const byId = new Map(store.all().map((c) => [c.id, c]));
    assert.strictEqual(byId.get('a')?.text, 'revised');
    assert.strictEqual(byId.get('b')?.text, 'looks wrong');
  });

  test('remove deletes only the matching comment', async () => {
    const store = new CommentStore(stubMemento());
    await store.add(makeComment({ id: 'a' }));
    await store.add(makeComment({ id: 'b' }));
    await store.remove('a');
    assert.deepStrictEqual(
      store.all().map((c) => c.id),
      ['b']
    );
  });

  test('clear removes everything', async () => {
    const store = new CommentStore(stubMemento());
    await store.add(makeComment({ id: 'a' }));
    await store.add(makeComment({ id: 'b' }));
    await store.clear();
    assert.deepStrictEqual(store.all(), []);
  });

  test('persistence round-trip through a shared memento', async () => {
    const memento = stubMemento();
    const first = new CommentStore(memento);
    const comment = makeComment({ id: 'persisted' });
    await first.add(comment);
    const second = new CommentStore(memento);
    assert.deepStrictEqual(second.all(), [comment]);
  });

  test('onDidChange fires on every change', async () => {
    const store = new CommentStore(stubMemento());
    let fired = 0;
    store.onDidChange(() => {
      fired += 1;
    });
    await store.add(makeComment({ id: 'a' }));
    await store.update('a', 'new text');
    await store.remove('a');
    await store.clear();
    assert.strictEqual(fired, 4);
  });
});
