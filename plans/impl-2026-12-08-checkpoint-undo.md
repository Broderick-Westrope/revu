# Checkpoint Undo + Reviewed Commits Implementation Plan

> **Status:** DRAFT

## Specification

**Problem:** The checkpoint tree only shows commits after the checkpoint (`checkpoint..branch`). Once a commit is marked safe it vanishes from the view, so there is no way to see what was already reviewed, notice a mistaken mark-safe, or move the checkpoint backwards. The only recovery is `Revu: Remove Checkpoint` (all the way back to merge-base) or the `Set Checkpoint` QuickPick, neither of which is visible in the tree where the mistake happened.

**Goal:** The tree shows the full branch timeline — unreviewed commits as today, followed by reviewed commits (merge-base up to the checkpoint) visually distinguished — and any reviewed commit carries a "Move Checkpoint Here" action that moves the ref backwards, returning later commits to the unreviewed state.

**Scope:**

In:
- `reviewedCommits` helper: first-parent listing of `merge-base..checkpoint`, newest-first, capped at 25 (with the cap surfaced in the UI when hit). When no default branch / merge-base is resolvable, fall back to the last 25 commits reachable from the checkpoint.
- Tree rendering: reviewed commits listed inline below the unreviewed ones (a single chronological timeline, newest at the top). Distinguishing marks: `$(check)` icon, `reviewed` suffix in the description, distinct `contextValue` (`revu.reviewedCommit`). The checkpoint commit itself (newest reviewed) gets a `$(milestone)` icon, `checkpoint` description, and its own `contextValue` (`revu.checkpointCommit`) so the boundary is visible and carries no move action (moving to itself is a no-op).
- `orphaned`, `needsInit`, and `detached` rendering is unchanged — no reviewed listing in those states.
- Reviewed commit nodes behave like unreviewed ones otherwise: click opens the commit diff, expand shows changed files, files open commit-file diffs with the existing escape hatch.
- "Move Checkpoint Here" inline action (`$(discard)` icon) on reviewed commits — calls the existing `markSafeAt` (CAS-guarded `update-ref` supports backwards moves already); existing scope sync + base-SHA staleness machinery handles the rest for free.
- Tree summary description gains the reviewed count (e.g. `3 commits + dirty working tree · 5 reviewed`).
- `implicit` state note: checkpoint == merge-base, so the reviewed list is empty by construction — no rendering change needed, but the helper must return `[]` cheaply.

Out:
- No changes to `markSafe`/`updateRef` semantics (CAS already permits any target).
- No "undo history" / multi-step undo — moving the ref is the undo.
- Moving the checkpoint below the merge-base (that's `Remove Checkpoint`).
- Guide/staleness/scope changes — backwards moves already flag guides stale via base-SHA mismatch and `syncCheckpointScope`.

**Constraints:**
- Follows existing patterns: helpers in `src/checkpoint.ts`, nodes/rendering in `src/checkpointTree.ts`, command wiring in `src/commands/checkpoint.ts` + `package.json`, temp-repo mocha tests via `npm test` (VS Code test host pinned to 1.129.1 — do not change).
- Read-only guard test must keep passing.
- All SHAs in nodes remain resolved 40-char SHAs.

**Success Criteria:**

- [ ] After marking a commit safe, it stays in the tree, re-rendered as reviewed (check icon, `reviewed` description) below the unreviewed commits.
- [ ] "Move Checkpoint Here" on a reviewed commit moves `refs/revu/checkpoint/<branch>` backwards; previously-reviewed later commits reappear as unreviewed; an active checkpoint-scope guide is flagged stale.
- [ ] The checkpoint commit is visibly marked as the boundary (`$(milestone)` + `checkpoint` description).
- [ ] Reviewed listing is capped at 25; when truncated, a terminal informational node states older reviewed commits are hidden and the summary shows `25+ reviewed`.
- [ ] `implicit` state shows no reviewed commits; `explicit` at merge-base shows none.
- [ ] Mark Safe does not appear on reviewed commits; Move Checkpoint Here does not appear on unreviewed commits.
- [ ] Guard test (`readonly.test.ts`) still passes; full suite green.

## Context Loading

_Run before starting:_

```bash
read src/checkpoint.ts
read src/checkpointTree.ts
read src/commands/checkpoint.ts
read src/test/checkpoint.test.ts
read src/test/checkpointTree.test.ts
grep -n "revu.markSafe" package.json
```

## Tasks

### Task 1: `reviewedCommits` helper

**Context:** `src/checkpoint.ts`, `src/git.ts` (`listCommits`, `mergeBase`, `defaultBranch`, `branchRef`), `src/test/checkpoint.test.ts`

**Files:**
- Modify: `src/checkpoint.ts`
- Test: `src/test/checkpoint.test.ts` (extend)

**Steps:**

1. [ ] Add to `src/checkpoint.ts`:

   ```ts
   export const REVIEWED_COMMITS_CAP = 25;

   export interface ReviewedCommits {
     commits: CommitInfo[];
     truncated: boolean;
   }

   export async function reviewedCommits(
     repoRoot: string,
     checkpointSha: string
   ): Promise<ReviewedCommits>;
   ```

   Implementation: try `defaultBranch` + `mergeBase(repoRoot, branchRef(def))`; on success list `` `${base}..${checkpointSha}` `` (first-parent via existing `listCommits`), on failure (no default branch) list from `checkpointSha` directly. Fetch `REVIEWED_COMMITS_CAP + 1` entries (add an optional `maxCount` parameter to `listCommits` in `src/git.ts` mapping to `--max-count`); `truncated` = more than the cap came back; return the first 25. If `checkpointSha` equals the merge-base, git returns an empty range — return `{ commits: [], truncated: false }` without special-casing.
2. [ ] Tests (temp-repo, existing suite style): reviewed list matches `merge-base..checkpoint` newest-first; empty when checkpoint == merge-base (implicit); cap honoured with `truncated: true` when >25 commits are reviewed (generate 30 commits in a loop); no-default-branch repo falls back to listing from the checkpoint without throwing; explicit checkpoint set *below* the merge-base (possible via the Set Checkpoint QuickPick) yields an empty list without error.

**Verify:**
```bash
npm test && npm run compile
# Expected: all suites pass including new reviewedCommits tests
```

### Task 2: Tree rendering of reviewed commits

**Context:** `src/checkpointTree.ts` (`CommitNode`, `rootChildren`, `getTreeItem`, `summaryDescription`), `src/test/checkpointTree.test.ts`

**Files:**
- Modify: `src/checkpointTree.ts`
- Test: `src/test/checkpointTree.test.ts` (extend)

**Steps:**

1. [ ] Extend `CommitNode` with `reviewed: boolean` and `isCheckpoint: boolean` (both `false` for today's unreviewed nodes). `rootChildren` for `explicit`/`implicit`: alongside `unreviewedCommits` + `workingTreeSummary`, call `reviewedCommits(this.repoRoot, state.sha)`; append reviewed nodes after the unreviewed ones (timeline order — reviewed commits are older), resolving `parentSha` the same way. The first reviewed commit (the checkpoint itself, `commit.sha === state.sha`) gets `isCheckpoint: true`.
2. [ ] `getTreeItem` for `commit` nodes:
   - unreviewed: unchanged (`git-commit` icon, `contextValue: 'revu.commit'`).
   - reviewed: `iconPath: new vscode.ThemeIcon('check')`, `contextValue: 'revu.reviewedCommit'`, `description: `${shortSha} · reviewed``.
   - checkpoint commit (`isCheckpoint`): `iconPath: new vscode.ThemeIcon('milestone')`, `description: `${shortSha} · checkpoint``, `contextValue: 'revu.checkpointCommit'` (no move action — moving to itself is a no-op).
   - when `truncated`, append a terminal informational node (new kind `reviewedOverflow`, label `Older reviewed commits hidden (showing 25)`, no command, no children).
   - click command (`revu.openCommitDiff`) and children (`commitFile` nodes) identical for reviewed and unreviewed.
   - `orphaned`/`needsInit`/`detached` root rendering unchanged — no reviewed nodes.
3. [ ] `summaryDescription(commitCount, dirty, reviewedCount, reviewedTruncated)`: append `` · ${reviewedCount} reviewed`` when `reviewedCount > 0`, with a `+` suffix (`25+ reviewed`) when truncated; update the existing call site and tests.
4. [ ] Tests: provider-level against a temp repo — after `markSafe` on the middle commit, root children contain the marked commit and older ones as `reviewed: true` below the unreviewed ones; checkpoint node flagged `isCheckpoint`; `getTreeItem` yields the right icons/contextValues/descriptions; summary string includes reviewed count; implicit state yields zero reviewed nodes.

**Verify:**
```bash
npm test && npm run compile
# Expected: tree tests pass; no regressions
```

### Task 3: "Move Checkpoint Here" command + wiring

**Context:** `src/commands/checkpoint.ts` (`markSafeCommand`, `markSafeAt`), `package.json` (commands + `view/item/context` menus), `src/extension.ts`, `src/test/checkpointCommands.test.ts`

**Files:**
- Modify: `src/commands/checkpoint.ts`, `src/extension.ts`, `package.json`
- Test: `src/test/checkpointCommands.test.ts` (extend)

**Steps:**

1. [ ] Add `moveCheckpointCommand(node: CommitNode, refresh: () => void)` in `src/commands/checkpoint.ts`: identical flow to `markSafeCommand` (detached guard, `isAncestor` validation against `refs/heads/<branch>`, `markSafeAt` with the current state's `expectedOldSha`), since `markSafeAt` — module-private in the same file, keep it that way — already handles backwards moves, CAS, D/F recovery, and scope sync. Implement by extracting the shared body: `markSafeCommand` and `moveCheckpointCommand` become thin wrappers over one `moveCheckpointTo(node, refresh)` — do not duplicate the validation logic.
2. [ ] `package.json`: add command `revu.moveCheckpoint` (title "Move Checkpoint Here", icon `$(discard)`); `view/item/context` inline entry with `when: "view == revu.checkpointView && viewItem == revu.reviewedCommit"`; hide from the command palette (`"when": "false"`), mirroring `revu.markSafe`. The existing `revu.markSafe` menu keeps `viewItem == revu.commit`, so it disappears from reviewed nodes automatically.
3. [ ] Register `revu.moveCheckpoint` in `src/extension.ts` next to `revu.markSafe`.
4. [ ] Tests: moving backwards from commit C to commit A updates the ref (assert via `resolveRef`), subsequent `unreviewedCommits` includes B and C again, `reviewedCommits` shrinks accordingly; CAS conflict on a concurrent external move surfaces as a failed move (assert final ref unchanged, per the module-boundary pattern in the existing CAS test); active checkpoint scope's `baseRef` follows the backwards move (reuse the `syncCheckpointScope` test pattern from `startReviewCheckpoint.test.ts`).
5. [ ] Update `README.md`: note in the Checkpoints section that reviewed commits stay visible (check icon) and the checkpoint can be moved backwards via "Move Checkpoint Here".

**Verify:**
```bash
npm test && npm run compile && npx @vscode/vsce package --no-dependencies -o revu.vsix
# Expected: full suite green (readonly guard included), vsix builds
```

---

_Review notes: devils-advocate pass (1 iteration, no blockers) caught: the checkpoint commit needed its own contextValue so the move action doesn't appear as a no-op on the boundary; orphaned/needsInit/detached rendering explicitly unchanged; truncation criterion aligned on the overflow node + `25+` summary; `markSafeAt` stays module-private; added the below-merge-base empty-range test. Verified free-of-charge claims: CAS backwards moves, scope sync → base-SHA staleness, stable scope key, working-tree node rebuild._
