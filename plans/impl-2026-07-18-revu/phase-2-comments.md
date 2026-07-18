# Phase 2: Local Comments and Markdown Export

> **Status:** COMPLETED
> Part of `plans/impl-2026-07-18-revu/README.md` — depends on Phase 1. Parallel with Phase 3.

## Specification

**Problem:** No way to leave local review comments on lines/ranges and hand them to a terminal AI agent.

**Goal:** Native inline commenting (line or selected range) in normal editors and on the modified side of Revu diffs; comments persist in `workspaceState` across reloads; "copy all" / "copy single" produce the fixed markdown format on the clipboard.

**Scope:** One `CommentController`, comment store, thread restore on activation, delete + clear-all, markdown export. No GitHub threads (Phase 4 extends the model with `quotedThread`; the field is defined now, populated later).

**Success Criteria:**
- [ ] `+` gutter affordance on any file in the workspace; submitting text creates a persistent local comment with captured code snippet
- [ ] Comments restore as visible threads after window reload
- [ ] Delete single comment (thread context menu) and `revu.clearAllComments` (with confirm) work
- [ ] `revu.copyAllComments` and per-thread `revu.copyComment` put spec-format markdown on the clipboard
- [ ] Comments are labeled distinctly as "Local" (visual separation from Phase 4's GitHub threads)

## Context Loading

```bash
read plans/design-2026-07-18-review-extension.md
read src/extension.ts src/scope.ts
```

## Comment Engine Tasks

### Task 1: Data model and store

**Files:**
- Create: `src/comments/model.ts`, `src/comments/store.ts`
- Test: `src/test/store.test.ts`

**Steps:**

1. [ ] Create `src/comments/model.ts`:

```ts
export interface QuotedThread {           // populated in Phase 4
  author: string;
  body: string;
  path: string;
  line?: number;
  diffHunk?: string;
  url?: string;
}

export interface LocalComment {
  id: string;                 // crypto.randomUUID()
  path: string;               // workspace-relative
  startLine: number;          // 1-based
  endLine: number;
  codeSnippet: string;        // captured at creation time from the document
  languageId: string;         // for the export fence
  text: string;
  createdAt: string;          // ISO
  quotedThread?: QuotedThread;
}
```

2. [ ] Create `src/comments/store.ts` — wraps `ExtensionContext.workspaceState` under key `revu.comments`: `all(): LocalComment[]`, `add(c)`, `update(id, text)`, `remove(id)`, `clear()`, plus `onDidChange` emitter. All mutations write through to `workspaceState.update` immediately.
3. [ ] Unit test the store with a stubbed `Memento` (in-memory Map implementing `get`/`update`): add/remove/clear/persistence round-trip

**Verify:**
```bash
npm test
# Expected: store suite passing, 0 failures
```

### Task 2: Comment controller and thread lifecycle

**Context:** `src/comments/store.ts`, `src/extension.ts`

**Files:**
- Create: `src/comments/controller.ts`
- Modify: `src/extension.ts`, `package.json`

**Steps:**

1. [ ] Create `src/comments/controller.ts`:
   - `vscode.comments.createCommentController('revu-local', 'Revu (Local)')`
   - `commentingRangeProvider`: for `file:` documents inside the workspace and `revu-git:`-paired diff right sides (which are `file:` docs), return `[new vscode.Range(0, 0, doc.lineCount - 1, 0)]`; return `[]` for other schemes (blocks commenting on the read-only left side)
   - `options = { placeHolder: 'Leave a local review comment…', prompt: 'Local only — never posted to GitHub' }`
2. [ ] Register command `revu.createComment` (bound in `package.json` under `menus."comments/commentThread/context"` with `"group": "inline"` so it renders as the reply box's Submit button, `when: "commentController == revu-local"`). Handler receives `vscode.CommentReply`:
   - Derive `startLine`/`endLine` from `reply.thread.range` (+1 for 1-based)
   - Read `codeSnippet` and `languageId` from the open `TextDocument` for `thread.uri`
   - `store.add(...)`; append the `vscode.Comment` by assignment (`thread.comments = [...thread.comments, c]` — `.push()` on the getter's array does nothing); comment has `mode: Preview`, `author: { name: 'You (local)' }`, body as `MarkdownString`; set `thread.label = 'Local'`, `thread.contextValue = 'revuLocal'`
3. [ ] Register `revu.deleteComment` (thread title menu, `when: "commentThread == revuLocal"`): remove from store, `thread.dispose()`
4. [ ] Register `revu.clearAllComments`: `showWarningMessage` confirm (modal), then `store.clear()` and dispose all tracked threads
5. [ ] On activation, restore: for each stored comment whose file still exists on disk (`fs.existsSync`; skip missing files silently), create a thread via `controller.createCommentThread(fileUri, range, [comment])` with `collapsibleState: Collapsed`. Track threads in a `Map<id, CommentThread>`.
6. [ ] Add the menu contributions to `package.json` (`comments/commentThread/context` for create, `comments/commentThread/title` for delete + copy-single)

**Verify:**
```bash
npm run compile
# Manual: add comment on a range in a normal editor and on the right side of a Revu diff;
# left side of diff shows no + gutter; reload window → threads reappear; delete + clear-all work.
```

## Export Tasks

### Task 3: Markdown export and clipboard commands

**Context:** `src/comments/model.ts`, `src/comments/store.ts`

**Files:**
- Create: `src/comments/export.ts`
- Modify: `src/extension.ts`, `package.json`
- Test: `src/test/export.test.ts`

**Steps:**

1. [ ] Create `src/comments/export.ts` with `renderComment(c: LocalComment): string` and `renderAll(comments: LocalComment[]): string`. Fixed format, grouped by file, comments ordered by `startLine`:

````markdown
# Review comments

## src/foo/bar.ts

### Comment 1 (lines 42-48)

```ts
// captured code snippet
```

> **Quoted PR comment** (@alice, on src/foo/bar.ts line 44):
> Why are we retrying here instead of failing fast?
>
> ```
> (diff hunk context)
> ```

My comment text here.
````

   - Single-line comments render as `(line 42)`
   - `quotedThread` block omitted when absent; `diffHunk` sub-block omitted when absent
   - Code fence uses `languageId`
2. [ ] Register `revu.copyAllComments` (command palette): `vscode.env.clipboard.writeText(renderAll(store.all()))` + info toast with comment count; warn if store empty
3. [ ] Register `revu.copyComment` (thread title menu, `when: "commentThread == revuLocal"`): resolve the `LocalComment` by thread, copy `renderComment` output wrapped in the `# Review comments` / file heading
4. [ ] Unit-test `renderAll`: two files, multi-line + single-line comments, with and without `quotedThread` — snapshot-style string equality

**Verify:**
```bash
npm test && npm run compile
# Expected: export suite passing. Manual: copyAll puts well-formed markdown on clipboard.
```

### Task 4: Commit

**Steps:**

1. [ ] Commit: "Phase 2: local comments via Comments API, workspaceState persistence, markdown export"

**Verify:**
```bash
git -C /Users/broderick.westrope/dev/helse/revu status --short
# Expected: clean
```
