# Checkpoint Reviews Implementation Plan

> **Status:** COMPLETED

## Overview

Adds a persistent per-branch "checkpoint" — a movable git ref (`refs/revu/checkpoint/<branch>`) marking "reviewed up to here" — for iterative review of AI-generated commits. Includes a sidebar tree of unreviewed commits with mark-safe advancement, an editable escape hatch from read-only commit diffs, a git-state watcher so terminal commits appear without manual refresh, and a new `checkpoint` review scope wired into guide generation with base-SHA-aware staleness.

Spec: `plans/design-2026-12-08-checkpoint-reviews.md` (approved after 3 devils-advocate iterations).

Phased because the work spans three independently reviewable domains: pure git plumbing + checkpoint state logic, the tree view UI + watcher, and scope/guide integration with its edge-case prompts.

**Problem:** Reviewing AI-generated commits iteratively has no state tracking — GitLens comparisons are manual and stateless, so changes get re-reviewed or missed, and commit diffs are read-only with no quick path to editing.

**Goal:** A movable per-branch checkpoint with a sidebar view of unreviewed commits, one-click advancement, an editable escape hatch, and guide/comment integration over the checkpoint range.

## Phases

| # | File | Delivers | Depends on | Review focus |
|---|------|----------|------------|--------------|
| 1 | `phase-1-git-core.md` | Git plumbing (refs, ancestry, commit listing, git-dir) + checkpoint state module | — | Git command correctness, CAS semantics, edge cases (detached HEAD, orphaned ref, no default branch) |
| 2 | `phase-2-tree-ui.md` | Checkpoint sidebar tree, git watcher, mark-safe, commit diffs + escape hatch | Phase 1 | Tree UX, watcher reliability (worktrees), diff URI pinning |
| 3 | `phase-3-scope-integration.md` | `checkpoint` review scope, base-SHA staleness, untracked-gate helper, branch-switch/orphan prompts | Phase 1, 2 | Scope-key stability, staleness correctness, prompt flows |

## Phase Boundaries

- **1 → 2:** Phase 1 is pure logic (no VS Code UI beyond types) with full test coverage; reviewing git semantics separately from UI keeps both reviews focused.
- **2 → 3:** The tree works standalone against the checkpoint module before review-session semantics (scope, guides, staleness) build on it. Phase 3 also owns the prompts that need both checkpoint state (1) and the watcher (2).

## Review Notes

Devils-advocate review (1 iteration, no blockers) caught and fixed: commit nodes needed a click command (open first file's commit diff), the checkpoint tree needed save/scope event refresh (saves write no `logs/HEAD` entry), the orphan prompt must run unconditionally (not only during an active review) per spec, `fs.watch` failure modes (missing `logs/` dir pre-first-commit, error events, visible degradation), escape-hatch no-op for non-commit `revu-git` diffs, `revu.isGitRepo` context key for viewsWelcome, command registration ordering between phase 2 tasks 2–3, `guardAction` signature carrying dedupe state, and test observability at the module boundary instead of `showErrorMessage`.
