# Checkpoint Reviews Design Spec

**Problem:** Reviewing AI-generated commits iteratively (agent commits locally, human reviews in the editor) has no good state tracking. Comparing the working tree against a "known safe point" via GitLens is manual and stateless — nothing remembers what has been reviewed, so changes get re-reviewed or missed. Commit diffs are read-only with no quick path to editing the live file when a small manual fix is wanted.

**Goal:** A persistent per-branch "checkpoint" — a movable marker meaning "reviewed up to here" — with a sidebar view of unreviewed commits, one-click advancement, an editable escape hatch from read-only commit diffs, and integration with Revu's existing review scopes so guides and local comments work over the checkpoint range.

**Scope:**

In:
- Persistent per-branch checkpoint stored as a git ref: `refs/revu/checkpoint/<branch>`, moved via `git update-ref`. Exists independently of review sessions.
- Implicit default checkpoint: merge-base with the default branch, until the first explicit "mark safe" creates the ref.
- Sidebar tree view: lists each commit in `checkpoint..HEAD` (message, changed files) plus a "Working tree" node for uncommitted/untracked changes. Shows at-a-glance unreviewed state ("N commits + dirty working tree").
- "Mark safe" action on any listed commit (not just oldest-first) advances the ref to that commit; marking commit N implies commits before it are reviewed. Tree and working-tree comparison re-derive from the new base.
- Clicking a commit opens its commit-vs-parent diff (read-only, as git history must be). Each such diff carries a one-click "compare with working tree" action that reopens the same file as `commit-parent ↔ working tree` — editable — scrolled to the same location.
- Clicking the working tree node (or a file under it) opens `checkpoint ↔ working tree` diffs; right side is the live file, editable.
- New scope type `checkpoint` in `Revu: Start Review` ("Since checkpoint"), so guide generation, staleness tracking, and local comments operate over the `checkpoint..working-tree` diff. Advancing the checkpoint mid-review updates the scope and flags the guide stale.
- Rebase/amend safety: if the checkpoint ref is no longer an ancestor of HEAD, show an orphaned state and prompt the user to re-pick a checkpoint (recent commits or merge-base). Offer an optional recovery view diffing the orphaned checkpoint against HEAD, since the ref keeps the old commit alive and the content comparison is often still meaningful.

Out:
- Any writes to GitHub (unchanged read-only guarantee).
- Auto-healing orphaned checkpoints (silently picking a new base risks marking unreviewed code as safe).
- Per-file or per-hunk reviewed state — the checkpoint is a single commit-level marker per branch.
- Multiple named checkpoints per branch.

**Constraints:**
- Checkpoint state must be real git state (refs), visible to terminal git and other tools, surviving editor/workspace-state loss. Namespaced under `refs/revu/` so it stays out of `git log` and branch pickers.
- One ref per branch; ordinary commits get no refs.
- Follows existing Revu patterns: scope types in `src/scope.ts`, sidebar tree modeled on the guide tree, git plumbing in `src/git.ts`, guide staleness keyed by scope.
- Read-only-by-design guard test must continue to pass.

**Success Criteria:**
- [ ] Marking a commit safe moves `refs/revu/checkpoint/<branch>` and the tree immediately shows only later commits as unreviewed.
- [ ] `git diff refs/revu/checkpoint/<branch>` in a terminal agrees with what Revu shows for the working-tree comparison.
- [ ] On a branch with no checkpoint, the tree works immediately using merge-base as the implicit base.
- [ ] From a read-only commit diff, one action opens the same file editable against the working tree at the same location.
- [ ] `Start Review` offers a "Since checkpoint" scope; generating a guide there uses the checkpoint diff; advancing the checkpoint flags the guide stale.
- [ ] After a rebase that orphans the checkpoint, Revu detects it, prompts to re-pick, and offers the orphaned-vs-HEAD recovery diff.
- [ ] Guard test (no GitHub writes) still passes.

**Design Decisions:**
- **Git ref over workspace state** for the checkpoint: usable from terminal/GitLens, survives reinstalls; workspace state would lock the checkpoint inside Revu. A tag was rejected as too visible/noisy.
- **Checkpoint is persistent per-branch state AND a review scope** (not session-only, not standalone-only): the workflow is continuous rather than session-shaped, but scope integration reuses guide/comment machinery for free.
- **Sidebar tree over QuickPick** for navigation: the flow is "glance at what's unreviewed, drill in, tick off" — a persistent-visibility problem. Commands can be added later.
- **Mark-safe allowed on any commit**, not sequential-only: marking commit 3 of 5 implies 1–3 reviewed.
- **Commit diffs stay read-only** with an editable escape hatch, rather than always diffing against the working tree: diffing `parent ↔ working tree` for a commit's files would include later changes and muddy commit-by-commit review.
- **Prompt on orphaned checkpoint** rather than auto-heal: silent fallback could mark unreviewed code safe — the exact failure mode this feature prevents.
- **Implicit merge-base default** rather than forced first-use setup: zero-friction start; merge-base is the natural safe point for a fresh branch.

**Context Files:**
- `src/scope.ts` — scope types (`workingTree` | `branch`), active scope state, scope keys; gains `checkpoint`.
- `src/git.ts` — git plumbing; gains ref read/update, ancestor check, commit listing.
- `src/extension.ts` — activation, command registration.
- `src/guide/` — guide generation and staleness, keyed by scope.
- `src/commands/` — command implementations (start/end review, open diff).
- `src/gitContentProvider.ts` — read-only git content for diff views.
- `src/comments/` — local comment persistence per scope.
