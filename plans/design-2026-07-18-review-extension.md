# Code Review VS Code Extension Design Spec

> **Status:** COMPLETED. The guide and the review-scope picker described here were later removed by `plans/design-2026-11-26-stack-review.md`.

**Problem:** The human-assisted parts of an opinionated code review workflow are spread across third-party tools (Linear's guided review, pair-review's local diff review, comment-renderer's local comments + markdown export). Switching between them adds friction. AI-performed review is already solved elsewhere; the gap is the human-in-the-loop tooling, unified inside VS Code/Cursor.

**Goal:** A single VS Code extension (compatible with Cursor) providing two capabilities against the checked-out working copy:

1. **Guided review** — an LLM-generated review guide that groups related changed files by theme (e.g., generated files, related tests, functional units), suggests a review order, and provides per-group commentary and "pay attention to" notes. Works for local changes and PRs.
2. **Local review comments** — leave comments on lines/ranges of code in a native interface, optionally quoting read-only GitHub PR comments as context, then export everything as AI-friendly markdown to the clipboard for discussion with a terminal agent.

**Scope:**

In scope:
- Review scopes: working tree vs HEAD (including untracked files), and current branch vs merge-base with the default branch. PR mode = branch scope + PR metadata. A picker selects the scope when starting a review. Selecting branch scope while on the default branch warns and aborts (empty diff).
- Always operates on already checked-out code. Never fetches/checks out branches itself.
- `gh` CLI for PR metadata (title, description, base branch) via `gh pr view --json`, and review threads via `gh api graphql` querying `pullRequest.reviewThreads` (with pagination) — `gh pr view --json reviews` does not expose inline comment positions. Thread fetch runs eagerly on scope selection (fast; no caching needed) and degrades gracefully on failure.
- GitHub PR comments displayed inline as **read-only**, visually distinct from local comments. Strictly no writes to GitHub, ever — no replies, no review submission.
- PR comment anchoring (v1): naive — use the thread's `line`/`startLine` directly against the working file, accepting misplacement when the working tree has drifted from the PR head. Each rendered thread includes its `diffHunk` snippet so a misplaced comment is still interpretable by the human and by the exported markdown. Diff-based line remapping is a possible later improvement, not v1. Threads with a null `line` (outdated position on GitHub's side) are skipped for inline rendering.
- Local comments via VS Code's native Comments API: attach to a line or selected range; stored in `workspaceState`; manual delete + "clear all" command.
- "Quote PR comment" action: creates a new local comment that embeds the quoted GitHub comment (author, text) and its anchored code as context.
- Markdown export (copy all / copy single comment) in a fixed, hardcoded format: grouped by file, each comment with line range, fenced code context, optional quoted PR thread, then the user's comment text.
- Guide presented as a sidebar tree view: groups as collapsible nodes (ordered by suggested review order, short theme line per group), changed files as children. Clicking a file opens VS Code's native diff editor (base ref vs working file) so comments attach to the real right-hand document. Base-ref content served by a custom `TextDocumentContentProvider` (private URI scheme backed by `git show <ref>:<path>`) — do not depend on the Git extension's internal `git:` URI format. Deleted files open a diff with an empty right side; renames (`git diff -M`) diff old path (left) against new path (right).
- Guide generation: shell out to an agent CLI (e.g., `claude -p`) with file list + diffs (truncated for huge files) + PR title/description when available; expect structured JSON back (groups, order, themes, notes). On-demand command, cached in `workspaceState` keyed by scope + a hash of `git diff --name-status` output for that scope (plus `git ls-files --others --exclude-standard` output for working-tree scope, so untracked files affect staleness), with a "stale" indicator when the hash no longer matches. Manual regenerate.

Out of scope (explicitly):
- AI-performed code review/suggestions (already solved by the user's existing workflow).
- Writing anything to GitHub (posting PR comments happens via the existing GitHub PR extension or browser).
- Comment resolve/unresolve states, review sessions/archiving.
- Configurable export templates.
- Auto-regenerating the guide on diff change.
- Staged-only or arbitrary ref..ref scopes.
- Non-GitHub forges.
- API-key-based or `vscode.lm`-based LLM access.

**Constraints:**
- Must work in both VS Code and Cursor → use only stable, widely supported extension APIs (Comments API, TreeView, `vscode.diff`, clipboard); avoid `vscode.lm`.
- LLM access exclusively by shelling out to an installed agent CLI (configurable command); no API key management.
- PR data exclusively via `gh` CLI (uses existing `gh auth`); degrade gracefully when `gh` is absent or the repo has no PR.
- Agent CLI calls are slow (10–60s) → generation must be explicit, non-blocking (progress UI), and cached.
- Comments in `workspaceState` only; no files written to the repo.
- Known accepted limitation: comment anchors are line-based and may drift when files are edited (same as comment-renderer).

**Success Criteria:**
- [ ] Can start a review on local changes (working tree vs HEAD, or branch vs merge-base) without any PR existing.
- [ ] Can generate a guide: sidebar tree shows themed groups in suggested review order with commentary; clicking a file opens the native diff against the base ref.
- [ ] Guide is cached and reopens instantly; a stale indicator appears when the diff changes; regenerate is manual.
- [ ] Can add a local comment to a line or selected range in the diff's modified side or a normal editor.
- [ ] When the branch has an open PR, existing GitHub review threads render inline, read-only, and are unmistakably distinct from local comments.
- [ ] Can quote a GitHub PR comment into a new local comment, and the export includes the quoted comment plus its anchored code.
- [ ] "Copy as markdown" (all or single) produces the fixed format with file paths, line ranges, fenced code context, quoted threads, and comment text — directly pasteable to a terminal agent.
- [ ] Extension never performs any GitHub write operation.
- [ ] Works in both VS Code and Cursor.

**Design Decisions:**
- **Agent CLI over `vscode.lm` or direct API**: reuses existing auth/subscription, keeps the extension thin, identical behavior in VS Code and Cursor (whose `vscode.lm` support is unreliable).
- **Checked-out code only, no worktree materialization**: user always has the code checked out; avoids checkout orchestration. `gh` is metadata-only.
- **`workspaceState` over repo files**: simpler, invisible, per-workspace; clipboard export is the sole AI handoff path.
- **Tree view over webview for the guide**: navigation and ordering for free with native UI; longer commentary can render via a generated markdown doc later if needed. Webview deferred until prose demands it.
- **Native diff editor (`vscode.diff` base ref vs working file)**: the modified side is the real document, so the Comments API works on it.
- **Read-only GitHub integration**: guarantees no accidental PR comments (a stated hard requirement); replying/publishing stays in existing tools.
- **Fixed export format over templates**: personal tool; iterate on the hardcoded format when it annoys.
- **On-demand cached guide generation over auto-regenerate**: CLI calls are slow; explicit control + name-status-hash cache + stale hint.
- **Naive PR comment anchoring for v1**: diff-based remapping onto a drifted working tree is complex; the included `diffHunk` snippet keeps misplaced threads interpretable. Accepted trade-off for a personal tool.
- **Custom content provider over Git extension `git:` URIs**: the built-in scheme's query format is undocumented internal API; a ~20-line provider is portable across VS Code and Cursor.
- **Alternatives declined**: PR branch materialization via worktrees (user works on checked-out code); publishing local comments as a GitHub review (v2 at most; user pastes into the GitHub extension manually); resolve states/sessions (comment loop is short-lived; manual clear-all suffices).

**Context Files / References:**
- https://github.com/in-the-loop-labs/pair-review — local + PR review modes, markdown feedback export, read-only external comments
- https://linear.app/docs/diffs#guides — guided review: grouping, themes, suggested order
- https://marketplace.visualstudio.com/items?itemName=statiolake.vscode-comment-renderer — native Comments API usage, workspaceState persistence, markdown export
