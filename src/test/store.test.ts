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
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
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

async function storeOn(memento: vscode.Memento, branch = 'main'): Promise<CommentStore> {
  const store = new CommentStore(memento);
  await store.setBranch(branch);
  return store;
}

suite('comment store', () => {
  test('all returns empty array when nothing stored', async () => {
    const store = await storeOn(stubMemento());
    assert.deepStrictEqual(store.all(), []);
  });

  test('add persists and all returns the comment', async () => {
    const store = await storeOn(stubMemento());
    const comment = makeComment();
    await store.add(comment);
    assert.deepStrictEqual(store.all(), [comment]);
  });

  test('update changes only the matching comment text', async () => {
    const store = await storeOn(stubMemento());
    await store.add(makeComment({ id: 'a' }));
    await store.add(makeComment({ id: 'b' }));
    await store.update('a', 'revised');
    const byId = new Map(store.all().map((c) => [c.id, c]));
    assert.strictEqual(byId.get('a')?.text, 'revised');
    assert.strictEqual(byId.get('b')?.text, 'looks wrong');
  });

  test('remove deletes only the matching comment', async () => {
    const store = await storeOn(stubMemento());
    await store.add(makeComment({ id: 'a' }));
    await store.add(makeComment({ id: 'b' }));
    await store.remove('a');
    assert.deepStrictEqual(
      store.all().map((c) => c.id),
      ['b']
    );
  });

  test('clear removes everything', async () => {
    const store = await storeOn(stubMemento());
    await store.add(makeComment({ id: 'a' }));
    await store.add(makeComment({ id: 'b' }));
    await store.clear();
    assert.deepStrictEqual(store.all(), []);
  });

  test('persistence round-trip through a shared memento', async () => {
    const memento = stubMemento();
    const first = await storeOn(memento);
    const comment = makeComment({ id: 'persisted' });
    await first.add(comment);
    const second = await storeOn(memento);
    assert.deepStrictEqual(second.all(), [comment]);
  });

  test('onDidChange fires on every change', async () => {
    const store = await storeOn(stubMemento());
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

  test('comments added on one branch are hidden on another and return when switching back', async () => {
    const store = await storeOn(stubMemento(), 'a');
    const comment = makeComment({ id: 'on-a' });
    await store.add(comment);
    await store.setBranch('b');
    assert.deepStrictEqual(store.all(), []);
    await store.setBranch('a');
    assert.deepStrictEqual(store.all(), [comment]);
  });

  test('a detached HEAD shows no comments and refuses new ones', async () => {
    const memento = stubMemento();
    const store = await storeOn(memento, 'a');
    await store.add(makeComment({ id: 'on-a' }));
    await store.setBranch(undefined);
    assert.deepStrictEqual(store.all(), []);
    await assert.rejects(store.add(makeComment({ id: 'detached' })));
    await store.setBranch('a');
    assert.deepStrictEqual(
      store.all().map((c) => c.id),
      ['on-a']
    );
    assert.deepStrictEqual(memento.keys(), ['revu.comments.branch:a']);
  });
});
