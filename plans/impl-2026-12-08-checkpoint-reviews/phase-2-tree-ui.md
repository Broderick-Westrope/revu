# Phase 2: Checkpoint Tree UI + Watcher

> **Status:** COMPLETED
> **Spec:** `plans/design-2026-12-08-checkpoint-reviews.md`
> **Depends on:** Phase 1 (merged)

## Specification (phase slice)

**Problem:** Checkpoint state exists (phase 1) but has no UI: no way to see unreviewed commits, mark one safe, open commit diffs, or notice terminal commits without manual action.

**Goal:** A "Checkpoint" sidebar tree (commits since checkpoint + "All unreviewed changes" node), a `<git-dir>/logs/HEAD` watcher driving refresh, mark-safe actions, read-only commit-vs-first-parent diffs with a one-click editable escape hatch, and a `Revu: Remove Checkpoint` command.

**Scope:** Tree view, watcher, diff commands, package.json contributions. No review-scope/guide integration (phase 3). Prompts for orphaned/detached states render as tree messages here; interactive re-pick prompts land in phase 3.

**Success Criteria:**

- [ ] Marking a commit safe moves the ref and the tree immediately shows only later commits as unreviewed.
- [ ] A commit made in the terminal appears in the tree without manual refresh — including in a linked git worktree.
- [ ] On a branch with no checkpoint, the tree works immediately using the implicit merge-base.
- [ ] From a read-only commit diff, one action opens the same file editable against the working tree at a best-effort matching location.
- [ ] Open diff editors keep pinned content after the ref moves (URIs embed resolved SHAs).
- [ ] Guard test still passes.

## Context Loading

_Run before starting:_

```bash
read src/checkpoint.ts
read src/git.ts
read src/guide/treeView.ts
read src/commands/openDiff.ts
read src/gitContentProvider.ts
read package.json
```

## Watcher Tasks

### Task 1: Git-state watcher

**Context:** `src/git.ts` (`gitDir`), `src/guide/treeView.ts` (debounce pattern), `src/extension.ts`

**Files:**
- Create: `src/gitWatcher.ts`
- Modify: `src/extension.ts` (register)
- Test: `src/test/gitWatcher.test.ts`

**Steps:**

1. [ ] Create `src/gitWatcher.ts` exporting `registerGitWatcher(context: vscode.ExtensionContext, repoRootPath: string): vscode.Event<void>`:
   - Resolve the watch dir via `gitDir(repoRootPath)` (absolute; correct for linked worktrees).
   - Watch `<git-dir>/logs/HEAD` with `fs.watch` on the `logs` directory (VS Code's `createFileSystemWatcher` cannot watch outside the workspace reliably; `fs.watch` on the directory with a filename filter for `HEAD` is robust across atomic rename writes).
   - Failure handling: if `<git-dir>/logs/` doesn't exist yet (fresh repo before first commit), poll for its creation (e.g. retry every 5s, max ~2min) before attaching; attach an `'error'` listener to the watcher (unhandled `fs.watch` errors crash the process) that disposes and shows a one-time `showWarningMessage` ("Revu: git watcher failed — checkpoint view won't auto-refresh; use the refresh button") so degradation is visible, not silent.
   - Debounce 500ms; fire a `vscode.EventEmitter<void>`. Dispose watcher + emitter via `context.subscriptions`.
   - If the git dir can't be resolved, return an event that never fires (log a console warning); do not throw during activation.
2. [ ] In `src/extension.ts`, resolve the workspace repo root at activation (reuse the pattern in `startReview`: first workspace folder → `repoRoot()`; skip watcher registration when not a git repo) and register the watcher, exporting its event for consumers (checkpoint tree now, staleness in phase 3).
3. [ ] Test: temp repo, register watcher (or test the non-VS Code core by extracting the fs-watch + debounce logic into a plain function), make a commit via `git` CLI, assert the event fires within ~2s. Use condition polling, not fixed sleeps. Also test the missing-`logs/`-dir path (fresh `git init`, no commits): registration doesn't throw, and the event fires after the first commit creates the log.

**Verify:**
```bash
npm test && npm test
# Expected: watcher tests pass on both consecutive runs (flakiness check)
```

## Tree View Tasks

### Task 2: Checkpoint tree provider

**Context:** `src/checkpoint.ts`, `src/guide/treeView.ts` (provider + registration pattern), `package.json` views section

**Files:**
- Create: `src/checkpointTree.ts`
- Modify: `src/extension.ts` (register), `package.json` (view + menus)
- Test: `src/test/checkpointTree.test.ts`

**Steps:**

1. [ ] Create `src/checkpointTree.ts` with `CheckpointTreeProvider implements vscode.TreeDataProvider<CheckpointNode>`:
   - Node kinds: `commit` (one per `unreviewedCommits` entry: label = subject, description = shortSha, tooltip = author + date; collapsible, children = that commit's `commitChangedFiles` as `commitFile` nodes), `workingTreeRoot` (label "All unreviewed changes", children = `workingTreeSummary().files` as `workingTreeFile` nodes), and file nodes carrying `ChangedFile` + the SHAs needed for diffs.
   - Commit nodes get a `command` (in addition to being expandable): clicking a commit opens its commit-vs-first-parent diff — the first changed file's diff via `openCommitFileDiff` (Task 4), with the remaining files reachable by expanding the node. (VS Code tree items support both `command` and children.)
   - Root ordering: `workingTreeRoot` first, then commits newest-first.
   - `getChildren()` derives everything from `getCheckpointState(repoRoot)` fresh on each refresh (no ref caching, per spec). State handling: `implicit`/`explicit` → normal listing; `orphaned` → `treeView.message` explaining the checkpoint is orphaned (interactive re-pick is phase 3) plus a single node offering the recovery diff (orphaned SHA ↔ HEAD via existing `showDiff` machinery per file — acceptable to expose as one "Show recovery comparison" node expanding to changed files); `detached` → message "Checkpoint disabled: detached HEAD"; `needsInit` → message prompting `Revu: Set Checkpoint`.
   - Tree title/description shows "N commits + dirty working tree" summary.
2. [ ] Register in `src/extension.ts`: `vscode.window.createTreeView('revu.checkpointView', ...)`; refresh on the git-watcher event, on `vscode.workspace.onDidSaveTextDocument` (debounced ~2s, matching the guide tree pattern — saves change the working-tree summary but write no `logs/HEAD` entry), on scope changes (`onDidChangeScope`), and on a manual `revu.refreshCheckpoint` command.
3. [ ] `package.json`: add view `revu.checkpointView` (name "Checkpoint") under the `revu` container; commands `revu.refreshCheckpoint` (view/title, `$(refresh)`), `revu.markSafe`, `revu.setCheckpoint`, `revu.removeCheckpoint`; `viewsWelcome` for the not-a-git-repo case gated on a `revu.isGitRepo` context key set during activation (alongside the existing `revu.reviewActive` pattern in `extension.ts:38`). Hide `revu.markSafe` from the command palette (`"when": "false"`) — it is context-menu only. Note: Task 3 registers the `setCheckpoint`/`markSafe`/`removeCheckpoint` implementations; if landing Task 2 separately, declare the commands here but register no-op stubs to avoid "command not found" errors between tasks (or land Tasks 2–3 as one commit).
4. [ ] Test: provider-level tests against a temp repo (instantiate provider directly, no VS Code window needed beyond the test host): fresh branch shows implicit-state commits; after `markSafe` the marked commit and its ancestors disappear; orphaned/detached/needsInit produce the expected message states.

**Verify:**
```bash
npm test && npm run compile
# Expected: tree tests pass; extension compiles
```

### Task 3: Mark-safe and checkpoint commands

**Context:** `src/checkpoint.ts`, `src/checkpointTree.ts`

**Files:**
- Create: `src/commands/checkpoint.ts`
- Modify: `src/extension.ts`, `package.json` (context menus)
- Test: `src/test/checkpointCommands.test.ts`

**Steps:**

1. [ ] `src/commands/checkpoint.ts`:
   - `markSafeCommand(node: CommitNode)` — read current state for the CAS `expectedOldSha` (explicit → current sha; implicit → must-not-exist sentinel), call `markSafe`, refresh tree. Catch errors and surface via `showErrorMessage`; special-case the D/F conflict message with guidance to run `Revu: Remove Checkpoint` after checking out the stale branch name, or offer "Delete stale ref" action that calls `deleteRef` on the conflicting ref directly.
   - `setCheckpointCommand()` — QuickPick of recent commits (`listCommits` over last ~50 on the branch, plus a "merge-base with <default>" entry when resolvable), then `markSafe`. Used for `needsInit` and orphan recovery (phase 3 reuses it).
   - `removeCheckpointCommand()` — confirm modal, `removeCheckpoint`, refresh.
2. [ ] `package.json` menus: `view/item/context` — `revu.markSafe` on `viewItem == revu.commit` (inline, `$(check)` icon); command palette entries for set/remove.
3. [ ] Tests: markSafe advances ref and honours CAS — simulate an external move between read and mark, and assert the underlying operation rejects without clobbering the ref (assert on the thrown error / final ref value from the checkpoint module boundary, not on `showErrorMessage`; keep the command wrapper thin so the testable logic lives below VS Code APIs); setCheckpoint creates ref on a fresh branch; removeCheckpoint returns state to implicit.

**Verify:**
```bash
npm test
# Expected: command tests pass
```

## Diff Tasks

### Task 4: Commit diffs and the editable escape hatch

**Context:** `src/commands/openDiff.ts` (`showDiff`), `src/gitContentProvider.ts` (`makeGitUri`), `src/checkpointTree.ts`

**Files:**
- Create: `src/commands/checkpointDiff.ts`
- Modify: `src/checkpointTree.ts` (node commands), `src/extension.ts`, `package.json`
- Test: `src/test/checkpointDiff.test.ts`

**Steps:**

1. [ ] `openCommitFileDiff(node: CommitFileNode)` — `vscode.diff` with both sides as `makeGitUri` (left: `<sha>^` resolved to a SHA — resolve the parent SHA once when building nodes, root commits use the `EMPTY` sentinel; right: `<sha>`). Both sides read-only by construction (content-provider scheme). Title `basename (shortSha)`. **All URIs embed resolved SHAs, never ref names** — `GitContentProvider` has no change emitter.
2. [ ] `openWorkingTreeFileDiff(node: WorkingTreeFileNode)` — reuse `showDiff` with a synthetic scope-like `{ repoRoot, baseRef: <checkpoint sha> }`: left = checkpoint SHA content, right = live file (editable). Handle D/R statuses as `showDiff` does; refactor `showDiff` to accept `(changed, { repoRoot, baseRef }, options)` if its `ReviewScope` typing is too narrow — it only uses those two fields.
3. [ ] Escape hatch: command `revu.compareWithWorkingTree` on the commit-diff editor title (`menus.editor/title` with `when` matching `resourceScheme == revu-git`) and on commit-file tree nodes. Behaviour: take the file path + commit's parent SHA from the active diff URI query (extend `GitUriQuery` with optional `commitSha`/`parentSha` context if needed), determine the visible selection line in the active editor, then open `parent SHA ↔ working tree` via `vscode.diff` with `TextDocumentShowOptions.selection` at the same line clamped to the working-tree file length (best effort). If the file no longer exists in the working tree: follow a rename if `changedFiles` reports one from the parent SHA, else show an information message and open the checkpoint↔working-tree deleted-file diff. Since `resourceScheme == revu-git` also matches non-commit diffs (e.g. the deleted-file diff in `openDiff.ts:31` whose right side is `revu-git`/EMPTY), the command must no-op with an information message when the URI query lacks the commit context fields.
4. [ ] Tests: URI construction embeds SHAs (assert `makeGitUri` query has a 40-char sha, not a ref name); parent resolution for normal and root commits; escape-hatch line clamping logic (extract as a pure function `clampLine(line, fileLineCount)` and best-effort target resolution as a pure function for testability).

**Verify:**
```bash
npm test && npm run compile && npm run package
# Expected: tests pass, vsix packages cleanly
```
