# Phase 1: Git Plumbing + Checkpoint Core

> **Status:** COMPLETED
> **Spec:** `plans/design-2026-12-08-checkpoint-reviews.md`

## Specification (phase slice)

**Problem:** Nothing in `src/git.ts` can read/write refs, check ancestry, list commits, or detect detached HEAD; there is no module owning checkpoint state.

**Goal:** A tested `src/checkpoint.ts` module that resolves the effective checkpoint for the current branch (explicit ref → implicit merge-base → needs-init), advances it via CAS ref updates, and classifies orphaned/detached/error states — plus the `src/git.ts` primitives it needs.

**Scope:** Pure logic + tests. No UI, no commands, no scope changes.

**Success Criteria:**

- [ ] `git diff refs/revu/checkpoint/<branch>` in a terminal agrees (tracked files) with what the module reports as the unreviewed range.
- [ ] CAS-guarded ref updates fail cleanly when the ref moved underneath.
- [ ] Orphaned checkpoint (ref not ancestor of branch tip), detached HEAD, and missing default branch are each detected and reported as distinct states.
- [ ] D/F ref conflict (stale `refs/revu/checkpoint/foo` blocking `foo/bar`) surfaces as a legible error.
- [ ] Guard test (`readonly.test.ts`) still passes — no GitHub writes introduced.

## Context Loading

_Run before starting:_

```bash
read src/git.ts
read src/test/git.test.ts
read plans/design-2026-12-08-checkpoint-reviews.md
```

## Git Plumbing Tasks

### Task 1: Extend `src/git.ts` with ref and history primitives

**Context:** `src/git.ts`, `src/test/git.test.ts` (temp-repo test pattern)

**Files:**
- Modify: `src/git.ts`
- Test: `src/test/git.test.ts` (extend) or new `src/test/checkpointGit.test.ts`

**Steps:**

1. [ ] Add to `src/git.ts` (all via the existing `git()` helper):
   - `resolveRef(cwd, ref): Promise<string | undefined>` — `rev-parse --verify --quiet <ref>^{commit}`; `undefined` when missing.
   - `updateRef(cwd, ref, newSha, oldSha?): Promise<void>` — `update-ref <ref> <newSha> [<oldSha>]`; pass `oldSha` (or the empty-ref sentinel `0000000000000000000000000000000000000000` for "must not exist") as CAS. Rethrow errors with the git stderr message intact (D/F conflicts must be legible).
   - `deleteRef(cwd, ref): Promise<void>` — `update-ref -d <ref>`.
   - `isAncestor(cwd, ancestor, descendant): Promise<boolean>` — `merge-base --is-ancestor`; exit code 1 → `false`, other errors rethrow.
   - `listCommits(cwd, range): Promise<CommitInfo[]>` — `log --first-parent --format=%H%x00%h%x00%s%x00%an%x00%cI <range>`; export `interface CommitInfo { sha: string; shortSha: string; subject: string; author: string; date: string }`.
   - `commitChangedFiles(cwd, sha): Promise<ChangedFile[]>` — `diff --name-status -M <sha>^! `... use `git diff --name-status -M <sha>^ <sha>` (first parent); for root commits (no parent) use `git diff-tree --no-commit-id --name-status -r --root <sha>`. Reuse the existing name-status parsing by extracting it into a shared `parseNameStatus(output: string): ChangedFile[]` helper used by both `changedFiles` and this function.
   - `isDetachedHead(cwd): Promise<boolean>` — `rev-parse --abbrev-ref HEAD` returns literal `HEAD`.
   - `gitDir(cwd): Promise<string>` — `rev-parse --absolute-git-dir`, trimmed.
2. [ ] Tests in the temp-repo style of `src/test/git.test.ts`: resolveRef missing/present; updateRef create + CAS success + CAS failure (stale oldSha rejects); deleteRef; isAncestor true/false; listCommits first-parent order across a merge (create a branch, merge it, assert side-branch commits are excluded); commitChangedFiles for a normal commit and root commit; isDetachedHead after `git checkout --detach`; gitDir returns an absolute path, and in a linked worktree (`git worktree add`) returns the worktree-private dir containing `logs/HEAD`.

**Verify:**
```bash
npm test
# Expected: all suites pass, including new git primitive tests
```

## Checkpoint Module Tasks

### Task 2: Create `src/checkpoint.ts` state module

**Context:** `src/git.ts` (after Task 1), `src/scope.ts` (event-emitter pattern), spec "Scope" section

**Files:**
- Create: `src/checkpoint.ts`
- Test: `src/test/checkpoint.test.ts`

**Steps:**

1. [ ] Create `src/checkpoint.ts` exporting:

   ```ts
   export const CHECKPOINT_REF_PREFIX = 'refs/revu/checkpoint/';

   export function checkpointRef(branch: string): string; // prefix + branch

   export type CheckpointState =
     | { kind: 'explicit'; branch: string; sha: string }            // ref exists, ancestor of branch tip
     | { kind: 'implicit'; branch: string; sha: string }            // no ref; merge-base with default branch
     | { kind: 'needsInit'; branch: string; reason: 'noDefaultBranch' | 'onDefaultBranch' } // implicit base unavailable/empty
     | { kind: 'orphaned'; branch: string; sha: string }            // ref exists but not ancestor of branch tip
     | { kind: 'detached' };                                        // detached HEAD: feature disabled

   export async function getCheckpointState(repoRoot: string): Promise<CheckpointState>;
   export async function markSafe(repoRoot: string, branch: string, sha: string, expectedOldSha?: string): Promise<void>;
   export async function removeCheckpoint(repoRoot: string, branch: string): Promise<void>;
   ```

2. [ ] `getCheckpointState` logic, in order: detached HEAD → `detached`; resolve `checkpointRef(branch)` → if present, `isAncestor(sha, branchTip)` decides `explicit` vs `orphaned` (branch tip = `rev-parse <branch>`, not HEAD, per spec — matters mid-rebase); if absent, try `defaultBranch` + `mergeBase` → `implicit`, but if `defaultBranch` throws → `needsInit('noDefaultBranch')`, and if current branch is the default branch or merge-base equals branch tip with no commits in range → `needsInit('onDefaultBranch')`. Always re-read from git — no in-memory caching of the ref (spec: external moves must be picked up on next event).
3. [ ] `markSafe` calls `updateRef` with CAS (`expectedOldSha` when the caller knows the prior state; the "must not exist" sentinel when creating). Let git errors propagate with stderr intact.
4. [ ] Tests (temp-repo): implicit state on fresh branch (merge-base with `main`); explicit after `markSafe`; state re-derives after external `git update-ref` in the test (no caching); orphaned after `git rebase`/`commit --amend` rewrites the marked commit; detached after `checkout --detach`; `needsInit` on a repo with no `main`/`master`/origin-HEAD and when on the default branch; CAS conflict raises; D/F conflict (`markSafe` on branch `foo/bar` with stale ref `refs/revu/checkpoint/foo`) raises an error whose message mentions the conflicting ref; `removeCheckpoint` deletes and state returns to implicit.

**Verify:**
```bash
npm test
# Expected: checkpoint suite passes; readonly.test.ts still green
```

### Task 3: Unreviewed-range helpers

**Context:** `src/checkpoint.ts`, `src/git.ts`

**Files:**
- Modify: `src/checkpoint.ts`
- Test: `src/test/checkpoint.test.ts` (extend)

**Steps:**

1. [ ] Add `export async function unreviewedCommits(repoRoot: string, checkpointSha: string, branch: string): Promise<CommitInfo[]>` — `listCommits` over `` `${checkpointSha}..${branch}` `` (first-parent, newest first as git emits).
2. [ ] Add `export async function workingTreeSummary(repoRoot: string, checkpointSha: string): Promise<{ files: ChangedFile[]; dirty: boolean }>` — `changedFiles(repoRoot, checkpointSha, true)` (untracked included); `dirty` = any uncommitted change exists (`git status --porcelain` non-empty; add a `hasUncommittedChanges(cwd)` primitive to `src/git.ts` if needed).
3. [ ] Tests: commits appear/disappear as checkpoint advances; parity check — file list matches `git diff --name-status refs/revu/checkpoint/<branch>` for tracked files plus `ls-files --others`; untracked file included; `dirty` true/false.

**Verify:**
```bash
npm test && npm run compile
# Expected: all tests pass, clean compile
```
