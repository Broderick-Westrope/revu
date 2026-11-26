# Phase 3: Scope + Guide Integration

> **Status:** COMPLETED. Superseded: the checkpoint scope and guide integration were replaced by `plans/design-2026-11-26-stack-review.md`.
> **Spec:** `plans/design-2026-12-08-checkpoint-reviews.md`
> **Depends on:** Phase 1, Phase 2 (merged)

## Specification (phase slice)

**Problem:** The checkpoint exists with UI, but review sessions can't use it: no `checkpoint` scope, staleness misses checkpoint advances (name-status hash only), untracked-file gating is scattered, and orphan/branch-switch situations have no interactive handling.

**Goal:** "Since checkpoint" appears in `Revu: Start Review`; guides generate over the checkpoint range with untracked files; advancing the checkpoint flags the guide stale (even when the file set is unchanged) and updates the active scope; branch switches and orphaned checkpoints during a review prompt the user instead of silently misbehaving.

**Scope:** `src/scope.ts`, staleness (`src/guide/cache.ts`, `treeView.ts`), the four untracked gates, `startReview`, prompts. Comments stay global (spec: out of scope).

**Success Criteria:**

- [ ] `Start Review` offers "Since checkpoint"; guide generation uses the checkpoint diff including untracked files.
- [ ] Advancing the checkpoint flags the existing guide stale even when later commits touch the same files (base-SHA check), and the cached guide is found (not lost) because the scope key is branch-stable.
- [ ] Pre-existing cached guides (no base SHA) keep hash-only staleness.
- [ ] After a rebase orphans the checkpoint, the watcher-driven check prompts to re-pick and offers the recovery diff.
- [ ] Switching branches during a checkpoint review prompts to restart or end — never silently swaps scope.
- [ ] Guard test still passes.

## Context Loading

_Run before starting:_

```bash
read src/scope.ts
read src/guide/cache.ts
read src/guide/treeView.ts
read src/commands/generateGuide.ts
read src/commands/startReview.ts
grep -n "workingTree" src/guide/webview.ts
```

## Scope Tasks

### Task 1: `checkpoint` scope type and untracked helper

**Context:** `src/scope.ts`, the four gate sites (`src/commands/generateGuide.ts:22`, `src/guide/treeView.ts:103`, `src/guide/treeView.ts:136`, `src/guide/webview.ts:282`)

**Files:**
- Modify: `src/scope.ts`, `src/commands/generateGuide.ts`, `src/guide/treeView.ts`, `src/guide/webview.ts`
- Test: `src/test/scope.test.ts` (new)

**Steps:**

1. [ ] `src/scope.ts`: extend `ScopeType` with `'checkpoint'`; extend `ReviewScope` with optional `branch?: string` (set for checkpoint scopes). `baseRef` for a checkpoint scope holds the **resolved checkpoint SHA** (never the ref name — content-provider URIs and diffs derive from it). `scopeKey`: `checkpoint` → `` `checkpoint:${scope.branch}` `` (branch-stable across advances); existing types unchanged.
2. [ ] Add `export function scopeIncludesUntracked(scope: ReviewScope): boolean` returning true for `workingTree` and `checkpoint`. Replace all four `scope.type === 'workingTree'` gates with it (the `treeView.ts:136` site feeds `nameStatusHash` — missing it makes checkpoint guides permanently stale whenever untracked files exist).
3. [ ] Tests: scopeKey stability (`checkpoint:feature-x` regardless of baseRef), scopeIncludesUntracked truth table.

**Verify:**
```bash
npm test && npm run compile
# Expected: pass; grep confirms no remaining direct gates:
grep -rn "type === 'workingTree'" src/ --include='*.ts' | grep -v test
# Expected: no matches outside scope.ts itself
```

### Task 2: Start Review integration + mark-safe scope sync

**Context:** `src/commands/startReview.ts`, `src/checkpoint.ts`, `src/commands/checkpoint.ts` (phase 2)

**Files:**
- Modify: `src/commands/startReview.ts`, `src/commands/checkpoint.ts`
- Test: `src/test/startReviewCheckpoint.test.ts`

**Steps:**

1. [ ] Add a third QuickPick entry: label "Since checkpoint", description "Changes since the last reviewed commit". On pick: `getCheckpointState(root)` — `explicit`/`implicit` → `setActiveScope({ type: 'checkpoint', baseRef: state.sha, repoRoot: root, branch: state.branch })`; `needsInit` → invoke `revu.setCheckpoint` then retry once; `orphaned` → run the orphan prompt (Task 3) first; `detached` → error message, abort.
2. [ ] In `markSafeCommand` (phase 2): after advancing, if the active scope is `checkpoint` for the same branch, call `setActiveScope` with the new resolved SHA (same scope key → guide kept, flagged stale via Task 4). Open diff editors keep pinned SHA content; do not close them.
3. [ ] Tests: scope produced has resolved 40-char SHA as baseRef; mark-safe during active checkpoint review updates `getActiveScope().baseRef` and fires the scope event.

**Verify:**
```bash
npm test
# Expected: pass
```

## Edge-Case Prompt Tasks

### Task 3: Orphan and branch-switch prompts

**Context:** `src/gitWatcher.ts` (phase 2 event), `src/checkpoint.ts`, `src/commands/checkpoint.ts`, `src/commands/startReview.ts` (`endReview`)

**Files:**
- Create: `src/checkpointGuard.ts`
- Modify: `src/extension.ts` (register)
- Test: `src/test/checkpointGuard.test.ts`

**Steps:**

1. [ ] `src/checkpointGuard.ts` — `registerCheckpointGuard(context, watcherEvent)`: on each (debounced) watcher event:
   - Re-read `getCheckpointState`. If `orphaned`: modal-less warning with actions "Pick new checkpoint" (invokes `revu.setCheckpoint`; on success re-sync the active scope if one is active) and "Show recovery comparison" (opens orphaned-SHA ↔ HEAD diffs via the phase 2 recovery path). This runs **regardless of whether a review is active** (spec: watcher-driven orphan detection is unconditional). Prompt at most once per orphaned SHA (dedupe) so rebase sequences don't spam.
   - Only when a `checkpoint` scope is active: if `currentBranch` no longer matches `scope.branch`, warning with actions "Restart review on this branch" (end review, re-run the checkpoint scope selection against the new branch) and "End review" (`revu.endReview`). Never silently swap.
   - If `detached` (e.g. rebase in progress): do nothing — wait for the next event; the ancestor check runs against the branch tip, not HEAD.
2. [ ] Also run the orphan check inside `startReview` when the user picks "Since checkpoint" (Task 2 hook).
3. [ ] Tests: extract decision logic as a pure function `guardAction(state, scope, currentBranch, promptedOrphanShas: ReadonlySet<string>): 'orphanPrompt' | 'branchPrompt' | 'none'` and unit-test the matrix: orphaned with no active scope → orphanPrompt; orphaned+matching branch → orphanPrompt; already-prompted orphan SHA → none (dedupe via the set parameter); branch mismatch with active checkpoint scope → branchPrompt; detached → none; workingTree scope active + orphaned → orphanPrompt (orphan check is scope-independent).

**Verify:**
```bash
npm test
# Expected: guard matrix tests pass
```

## Staleness Tasks

### Task 4: Base-SHA-aware guide staleness

**Context:** `src/guide/cache.ts`, `src/guide/model.ts` (`CachedGuide`), `src/guide/treeView.ts` (`updateStaleness`), `src/commands/generateGuide.ts`

**Files:**
- Modify: `src/guide/model.ts`, `src/guide/cache.ts`, `src/guide/treeView.ts`, `src/commands/generateGuide.ts`
- Test: `src/test/guide.test.ts` (extend)

**Steps:**

1. [ ] `CachedGuide` gains optional `baseSha?: string`. `generateGuide` sets it to `scope.baseRef` when `scope.type === 'checkpoint'` (a resolved SHA by Task 1's invariant; harmless to also store for `branch` scopes — do so for consistency, `workingTree` stays undefined since HEAD moves per commit by design).
2. [ ] `GuideCache.isStale(cached, currentHash, currentBaseSha?)`: stale when hash differs **or** (`cached.baseSha` present and `currentBaseSha` present and they differ). Guides without `baseSha` (pre-existing) keep hash-only behaviour.
3. [ ] `updateStaleness` in `treeView.ts`: for checkpoint scopes, **re-read the checkpoint ref from git** (`getCheckpointState`) rather than trusting the in-memory scope — external `update-ref` moves are then caught on the next watcher/save event. Pass the fresh SHA into `isStale`. Also subscribe `debouncedStaleness` to the git-watcher event alongside `onDidSaveTextDocument`.
4. [ ] Tests: the blocker scenario from design review — checkpoint at A, commits B and C both touching `foo.ts`, guide generated over `A..worktree`, mark B safe → same name-status hash but `isStale` returns true via base mismatch. Legacy cached guide without `baseSha` → hash-only. Hash change alone still stale.

**Verify:**
```bash
npm test && npm run compile
# Expected: all suites green, including readonly guard; then full check:
npm run package
# Expected: vsix builds
```

---

_Review notes (added after devils-advocate pass): see README._
