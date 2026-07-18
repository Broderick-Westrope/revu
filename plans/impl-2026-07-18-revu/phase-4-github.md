# Phase 4: GitHub Read-Only Integration

> **Status:** COMPLETED
> Part of `plans/impl-2026-07-18-revu/README.md` — depends on Phases 1–3.

## Specification

**Problem:** When reviewing a branch that has an open PR, existing GitHub review threads are invisible, and the guide lacks PR title/description context. The user wants to read others' comments inline, quote them into local comments, and have exports carry that context — with zero risk of writing to GitHub.

**Goal:** PR metadata and review threads fetched via `gh` (read-only, eager, graceful degradation), threads rendered inline visually distinct from local comments, a "Quote in local comment" action, quoted context in exports (already supported by Phase 2's format), and PR title/description wired into guide generation.

**Scope:** `gh` wrapper, GraphQL reviewThreads query with pagination, second read-only `CommentController`, quote command, prompt wiring. **No GitHub write path of any kind** — no `gh` mutation commands anywhere in the codebase.

**Success Criteria:**
- [ ] Starting a branch-scope review on a branch with an open PR fetches and renders GitHub threads inline; threads show author, body, resolved state; reply UI absent
- [ ] GitHub threads visually distinct: separate controller label "GitHub (read-only)", distinct thread label; local `+` gutter unaffected
- [ ] Threads with null `line` are skipped; count of skipped threads noted in an info-level status message
- [ ] "Quote in local comment" on a GitHub comment creates a local comment (via InputBox) carrying `quotedThread` (author, body, path, line, diffHunk, url); export renders it per Phase 2's format
- [ ] No PR / no `gh` / `gh` error → review works exactly as before, with a single non-blocking warning
- [ ] Guide prompts include PR title/description when a PR exists
- [ ] `grep` audit: no `gh` invocation that mutates (`gh pr comment`, `gh pr review`, `gh api -X POST/PATCH/PUT/DELETE`, `mutation`) exists in `src/`

## Context Loading

```bash
read plans/design-2026-07-18-review-extension.md
read src/comments/controller.ts src/comments/model.ts src/guide/prompt.ts src/commands/startReview.ts
```

## gh Data Tasks

### Task 1: gh wrapper — PR metadata and review threads

**Files:**
- Create: `src/github/gh.ts`, `src/github/model.ts`
- Test: `src/test/github.test.ts`

**Steps:**

1. [ ] Create `src/github/model.ts`:

```ts
export interface PrMetadata { number: number; title: string; body: string; baseRefName: string; url: string }
export interface GhThreadComment { author: string; body: string; createdAt: string; url: string }
export interface GhReviewThread {
  path: string;
  line: number | null;       // null = outdated position → skip inline rendering
  startLine: number | null;
  isResolved: boolean;
  diffHunk: string;          // from first comment's diffHunk
  comments: GhThreadComment[];
}
```

2. [ ] Create `src/github/gh.ts`:
   - `isGhAvailable(cwd)`: `gh auth status` exit code (cache result per session)
   - `fetchPrMetadata(cwd): Promise<PrMetadata | undefined>`: `gh pr view --json number,title,body,baseRefName,url` for the current branch; `undefined` on "no pull requests found" or any error
   - `fetchReviewThreads(cwd, prNumber): Promise<GhReviewThread[]>`: `gh api graphql --paginate` with:

```graphql
query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path line startLine isResolved
          comments(first: 50) {
            nodes { body diffHunk createdAt url author { login } }
          }
        }
      }
    }
  }
}
```

   Owner/repo from `gh repo view --json nameWithOwner` (note: `--json owner` returns a nested `{login}` object — prefer `nameWithOwner` and split on `/`). For GraphQL, `--paginate` follows `pageInfo` cursors and emits a **single merged JSON document** (nodes arrays merged across pages) — parse it as one object; no splitting needed. All invocations via `execFile('gh', args)` — never `shell: true`, never mutation subcommands.
3. [ ] Unit-test the response parsing (`parseThreadsResponse(json)`) against fixture JSON: normal threads, null-line thread, multi-page fixture, comments >1

**Verify:**
```bash
npm test
# Expected: github parsing suite passing, 0 failures
```

## Rendering Tasks

### Task 2: Read-only thread rendering

**Context:** `src/github/*.ts`, `src/comments/controller.ts`, `src/commands/startReview.ts`

**Files:**
- Create: `src/github/threadRenderer.ts`
- Modify: `src/commands/startReview.ts`, `src/extension.ts`

**Steps:**

1. [ ] Create `src/github/threadRenderer.ts`:
   - Second controller: `vscode.comments.createCommentController('revu-github', 'GitHub (read-only)')` with **no** `commentingRangeProvider` assignment that returns ranges (set provider returning `[]` so no `+` gutter is attributed to it)
   - For each thread with non-null `line`: `createCommentThread(fileUri, range(line-1[, startLine-1]), comments)` — naive anchoring per spec; `canReply = false`; `collapsibleState: Collapsed`; `label = isResolved ? 'GitHub · resolved' : 'GitHub'`; `contextValue = 'revuGithub'`; each `vscode.Comment` gets `author: { name: '@' + login + ' (GitHub)' }`, markdown body with the `diffHunk` appended as a collapsed-style fenced block, `mode: Preview`
   - `renderThreads(threads)` disposes previous GitHub threads first (idempotent refresh); expose `clear()`
2. [ ] Wire into review lifecycle: on branch-scope `startReview` (and a manual `revu.refreshPrThreads` command), if `gh` available → fetch metadata + threads eagerly (async, non-blocking); store `PrMetadata` on the scope module (`setPrContext(meta)`); render threads; status bar/info message "PR #123: N threads shown, M skipped (outdated)". On any failure → single `showWarningMessage`, continue without PR data. `endReview` → `clear()` + clear PR context
3. [ ] Working-tree scope: also attempt PR fetch (the branch may have a PR while the user reviews uncommitted work) — same code path

**Verify:**
```bash
npm run compile
# Manual (repo with an open PR containing review comments): threads render read-only at their lines,
# no reply box, resolved threads labeled; local commenting still works alongside; refresh command re-fetches.
```

## Quote & Integration Tasks

### Task 3: Quote-to-local-comment and export integration

**Context:** `src/github/threadRenderer.ts`, `src/comments/store.ts`, `src/comments/model.ts`, `src/comments/export.ts`

**Files:**
- Create: `src/commands/quoteComment.ts`
- Modify: `package.json`, `src/comments/controller.ts`

**Steps:**

1. [ ] Register `revu.quoteComment` in `package.json` under `menus."comments/comment/title"` with `when: "commentController == revu-github"`, title "Quote in local comment". Handler receives `(comment: vscode.Comment, thread: vscode.CommentThread)`; look up the source `GhReviewThread`/`GhThreadComment` via a WeakMap populated by the renderer
2. [ ] Handler: `showInputBox({ prompt: 'Your local comment (the GitHub comment and its code context will be attached)' })`; on submit create a `LocalComment` at the GitHub thread's range on the same file, with `quotedThread: { author, body, path, line, diffHunk, url }` and `codeSnippet` read from the current document at that range; add via Phase 2's store so it renders as a normal local thread and exports with the quoted block
3. [ ] Verify Phase 2's `renderComment` output for a quoted comment includes author, quoted body, and diff hunk fence (already unit-tested there; add one integration-style unit test with a realistic `quotedThread`)

**Verify:**
```bash
npm test && npm run compile
# Manual: quote a GitHub comment → local thread appears with quoted context; copyAll export
# contains the quoted block + diff hunk + your text.
```

### Task 4: PR context in guide generation + write-path audit

**Context:** `src/guide/prompt.ts`, `src/commands/generateGuide.ts`

**Files:**
- Modify: `src/commands/generateGuide.ts`

**Steps:**

1. [ ] In `generateGuide`, pass `prContext` built from stored `PrMetadata` (`"PR #<n>: <title>\n\n<body>"`) into `buildPrompt` when available
2. [ ] Audit for accidental write paths and add a CI-friendly guard test `src/test/readonly.test.ts` that greps `src/` for forbidden patterns: `gh pr comment`, `gh pr review`, `gh api` with `-X`/`--method` other than GET, `mutation` — test fails if any found

**Verify:**
```bash
npm test
# Expected: readonly guard test passing; full suite green
```

### Task 5: Commit

**Steps:**

1. [ ] Commit: "Phase 4: read-only GitHub threads, quote-to-local-comment, PR context in guides"

**Verify:**
```bash
git -C /Users/broderick.westrope/dev/helse/revu status --short
# Expected: clean
```
