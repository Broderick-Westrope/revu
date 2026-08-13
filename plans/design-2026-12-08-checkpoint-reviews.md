# Checkpoint Reviews Design Spec

**Problem:** Reviewing AI-generated commits iteratively (agent commits locally, human reviews in the editor) has no good state tracking. Comparing the working tree against a "known safe point" via GitLens is manual and stateless — nothing remembers what has been reviewed, so changes get re-reviewed or missed. Commit diffs are read-only with no quick path to editing the live file when a small manual fix is wanted.

**Goal:** A persistent per-branch "checkpoint" — a movable marker meaning "reviewed up to here" — with a sidebar view of unreviewed commits, one-click advancement, an editable escape hatch from read-only commit diffs, and integration with Revu's existing review scopes so guides and local comments work over the checkpoint range.

**Scope:**

In:
- Persistent per-branch checkpoint stored as a git ref: `refs/revu/checkpoint/<branch>`, moved via `git update-ref` (with the expected old value as compare-and-swap to avoid multi-window races). Exists independently of review sessions.
- Implicit default checkpoint: merge-base with the default branch, until the first explicit "mark safe" creates the ref. If no default branch can be determined, or the current branch *is* the default branch (merge-base = HEAD, empty range), prompt the user to pick an initial checkpoint from recent commits instead.
- Sidebar tree view: lists each commit in `checkpoint..HEAD` (first-parent order; message, changed files) plus an "All unreviewed changes" node representing the full `checkpoint ↔ working tree` comparison (committed-but-unreviewed changes plus uncommitted and untracked files). Shows at-a-glance unreviewed state ("N commits + dirty working tree").
- Refresh mechanism: a file watcher on `<git-dir>/logs/HEAD` — with the git dir resolved via `git rev-parse --absolute-git-dir` so linked worktrees work (`.git` is a file there) — plus existing save/scope events, triggers tree refresh, staleness recomputation, and the orphaned-checkpoint check. Commits made by an agent in the terminal appear without manual action. Staleness and tree recomputes re-read the checkpoint ref from git rather than trusting in-memory state, so external ref moves (terminal `update-ref`, a second window's mark-safe) are picked up on the next event even though they write no HEAD reflog entry.
- "Mark safe" action on any listed commit (not just first-parent-oldest) advances the ref to that commit; marking a commit implies it and its ancestors are reviewed. Tree and working-tree comparison re-derive from the new base. If a checkpoint-scope review is active, marking safe updates the active scope's resolved base; already-open diff editors keep their pinned content (URIs embed SHAs) and are not force-closed.
- Clicking a commit opens its commit-vs-first-parent diff (read-only, as git history must be; first parent, consistent with the first-parent listing). Each such diff carries a one-click "compare with working tree" action that reopens the same file as `commit-parent ↔ working tree` — editable — scrolled to a best-effort matching location (same line where possible). If the file was renamed or deleted in the working tree, open the rename target or fall back to opening the diff at the top with a notification.
- Clicking the "All unreviewed changes" node (or a file under it) opens `checkpoint ↔ working tree` diffs; right side is the live file, editable. Untracked files are included: replace the four scattered `scope.type === 'workingTree'` gates with a single `scopeIncludesUntracked(scope)` helper returning true for `workingTree` and `checkpoint` (sites: `src/commands/generateGuide.ts:22`, `src/guide/treeView.ts:103`, `src/guide/treeView.ts:136`, `src/guide/webview.ts:282` — the `treeView.ts:136` site feeds `nameStatusHash`, so missing it would make checkpoint guides permanently stale whenever untracked files exist).
- All diff URIs and scope state carry **resolved SHAs**, not ref names, so open editors and `GitContentProvider` content stay consistent when the ref moves.
- New scope type `checkpoint` in `Revu: Start Review` ("Since checkpoint"). Scope key is `checkpoint:<branch>` — stable across checkpoint advances so the cached guide is found and flagged stale rather than lost. The scope additionally records the resolved base SHA and branch name.
- Staleness: `CachedGuide` gains an optional resolved base SHA field. A guide is stale if the name-status hash differs **or** the cached base SHA is present and no longer matches the current checkpoint — advancing the checkpoint always flags the guide stale even when the changed-file list is unchanged. Pre-existing cached guides (no base SHA) skip the SHA check and keep hash-only staleness.
- Branch switch while a checkpoint review is active: detected via the refresh watcher; Revu prompts to either restart the review on the new branch's checkpoint or end the review. No silent scope swap.
- Detached HEAD (including rebase-in-progress): checkpoint features are disabled with an explanatory tree message; no `refs/revu/checkpoint/HEAD` ref is ever created. The ancestor check runs against the branch tip.
- Rebase/amend safety: if the checkpoint ref is no longer an ancestor of the branch tip, show an orphaned state and prompt the user to re-pick a checkpoint (recent commits or merge-base). Offer an optional recovery view diffing the orphaned checkpoint against HEAD, since the ref keeps the old commit alive and the content comparison is often still meaningful.
- A `Revu: Remove Checkpoint` command deletes the current branch's ref (also the cleanup story for stale refs from deleted branches, which otherwise pin dead commits indefinitely — acceptable for a personal tool). Mark-safe surfaces ref-creation failures legibly — notably the directory/file conflict when a stale ref like `refs/revu/checkpoint/foo` blocks creating `refs/revu/checkpoint/foo/bar`, with guidance to remove the stale ref.

Out:
- Any writes to GitHub (unchanged read-only guarantee).
- Auto-healing orphaned checkpoints (silently picking a new base risks marking unreviewed code as safe).
- Per-file or per-hunk reviewed state — the checkpoint is a single commit-level marker per branch.
- Multiple named checkpoints per branch.
- Making local comments scope-aware. The existing `CommentStore` is a single global set with line-based anchors; comments continue to work as-is in checkpoint diffs, and anchor drift under agent commits remains a known limitation (already documented in the README).
- Automatic garbage collection of refs for deleted branches (manual removal command only).

**Constraints:**
- Checkpoint state must be real git state (refs), visible to terminal git and other tools, surviving editor/workspace-state loss. Namespaced under `refs/revu/` so it stays out of default `git log` and branch pickers (it will still appear in `git log --all` / `for-each-ref`; acceptable).
- One ref per branch; ordinary commits get no refs.
- Follows existing Revu patterns: scope types in `src/scope.ts`, sidebar tree modeled on the guide tree, git plumbing in `src/git.ts`, guide staleness keyed by scope.
- Read-only-by-design guard test must continue to pass.

**Success Criteria:**
- [ ] Marking a commit safe moves `refs/revu/checkpoint/<branch>` and the tree immediately shows only later commits as unreviewed.
- [ ] `git diff refs/revu/checkpoint/<branch>` in a terminal agrees with what Revu shows for the working-tree comparison (for tracked files; Revu additionally lists untracked files).
- [ ] A commit made in the terminal appears in the tree without manual refresh — including in a linked git worktree.
- [ ] On a branch with no checkpoint, the tree works immediately using merge-base as the implicit base; when merge-base is unavailable or empty, the user is prompted to pick one.
- [ ] From a read-only commit diff, one action opens the same file editable against the working tree at a best-effort matching location.
- [ ] `Start Review` offers a "Since checkpoint" scope; generating a guide there uses the checkpoint diff; advancing the checkpoint flags the existing guide stale even when the changed-file set is unchanged (e.g. later commits touch the same files).
- [ ] After a rebase that orphans the checkpoint, Revu detects it via the watcher, prompts to re-pick, and offers the orphaned-vs-HEAD recovery diff.
- [ ] Switching branches during a checkpoint review prompts to restart or end — never silently swaps scope.
- [ ] Guard test (no GitHub writes) still passes.

**Design Decisions:**
- **Git ref over workspace state** for the checkpoint: usable from terminal/GitLens, survives reinstalls; workspace state would lock the checkpoint inside Revu. A tag was rejected as too visible/noisy.
- **Checkpoint is persistent per-branch state AND a review scope** (not session-only, not standalone-only): the workflow is continuous rather than session-shaped, but scope integration reuses guide/comment machinery — with two deliberate adaptations: base-SHA-aware staleness (name-status hashing alone misses checkpoint advances when the same files stay modified) and a branch-stable scope key `checkpoint:<branch>` (a SHA-embedding key would lose the cached guide and orphan read-marks on every advance).
- **`<git-dir>/logs/HEAD` watcher** for refresh (git dir resolved, not hardcoded `.git/`, so linked worktrees work): the primary workflow is terminal-driven agent commits, which fire no editor save events; without a git-state trigger the tree and orphan detection go stale, defeating the "glance at what's unreviewed" purpose of a tree view.
- **Sidebar tree over QuickPick** for navigation: the flow is "glance at what's unreviewed, drill in, tick off" — a persistent-visibility problem. Commands can be added later.
- **Mark-safe allowed on any commit**, not sequential-only: marking a commit implies its ancestors are reviewed. First-parent ordering defines the tree listing so merge commits don't produce an ambiguous "before".
- **Commit diffs stay read-only** with an editable escape hatch, rather than always diffing against the working tree: diffing `parent ↔ working tree` for a commit's files would include later changes and muddy commit-by-commit review. The escape hatch's location matching is best-effort — the commit-side line may not exist in the working tree.
- **Resolved SHAs in URIs and scope state**, never ref names: `GitContentProvider` has no change emitter, so ref-name URIs would show stale content after the ref moves.
- **Prompt on orphaned checkpoint** rather than auto-heal: silent fallback could mark unreviewed code safe — the exact failure mode this feature prevents.
- **Implicit merge-base default** rather than forced first-use setup: zero-friction start; merge-base is the natural safe point for a fresh branch. Prompt only in the cases where it's meaningless (no default branch, or on the default branch itself).
- **Comments stay global and line-anchored** (unchanged): making them scope- or content-anchored is a separate project; the spec doesn't claim per-scope comment behavior it doesn't have.

**Context Files:**
- `src/scope.ts` — scope types (`workingTree` | `branch`), active scope state, `scopeKey`; gains `checkpoint` with branch-stable key.
- `src/git.ts` — git plumbing (`changedFiles`, `nameStatusHash`, `mergeBase`, `defaultBranch`); gains ref read/CAS-update/delete, ancestor check, first-parent commit listing, detached-HEAD detection, git-dir resolution (`rev-parse --absolute-git-dir`).
- `src/extension.ts` — activation, command registration; gains the `<git-dir>/logs/HEAD` watcher.
- `src/guide/cache.ts` — `isStale` is currently hash-equality only; gains base-SHA awareness.
- `src/guide/treeView.ts` — staleness recompute triggers (currently save + scope/guide events); model for the new checkpoint tree.
- `src/commands/` and `src/guide/webview.ts` — command implementations and guide webview; four `includeUntracked` gates to consolidate into `scopeIncludesUntracked` (see Scope).
- `src/gitContentProvider.ts` — read-only git content for diff views; no `onDidChange` emitter, hence resolved-SHA URIs.
- `src/comments/store.ts` — global comment store (single memento key, not per-scope); unchanged.
