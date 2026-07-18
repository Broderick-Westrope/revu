# Revu

Guided code review and local review comments, inside VS Code and Cursor.

Revu makes reviewing code easier, more thorough, and faster. It gives you an AI-generated map of a change before you read a line of it, and a place to leave comments that were always destined for an AI conversation rather than a PR thread.

## Why

Good review tooling exists, but it's scattered. Linear generates guided reviews for PRs. pair-review runs local diff review in a browser. Comment-renderer exports editor comments as markdown. Each solves one piece, each lives somewhere else, and none of them work together. Revu brings the human-in-the-loop parts of that workflow into the editor you already review code in.

Three problems it solves:

**Large diffs have no entry point.** A 3000-line PR is a wall. Revu asks an agent CLI to group the changed files by theme (the core functionality, the tests that cover it, the generated noise), order the groups by review priority, and annotate each with what to watch for. You read the guide, then work through the diffs in an order that makes sense.

**Reviewing your own work means pushing it first.** Most tools only review PRs. Revu reviews whatever is checked out: uncommitted working-tree changes or the whole branch against its merge-base. No push, no draft PR, no leaving the editor.

**Review comments for AI live in the wrong places.** When you review AI-generated code, your comments are feedback for the agent, not for GitHub. Revu keeps them local, attaches the exact code context, and exports the whole set as markdown built for pasting into a terminal agent. When you're reviewing someone else's PR, it pulls the existing GitHub threads in read-only so you can quote them into your notes, and it never writes anything back.

## How it works

1. **Start a review** — `Revu: Start Review`, pick a scope: working tree vs HEAD (untracked files included) or current branch vs merge-base with the default branch. If the branch has an open PR, Revu fetches its metadata and review threads via `gh`.
2. **Generate a guide** — `Revu: Generate Review Guide` sends the diff to your agent CLI (default `claude -p`) and opens the guide in an editor tab: overall summary, themed sections in suggested review order, attention notes, and clickable file rows. Files open as native diffs in the adjacent editor group, jumping straight to the lines the note references. Mark files read as you go. The sidebar tree mirrors the sections for quick navigation.
3. **Leave comments** — use the native commenting UI (the `+` in the gutter) on any line or range. Comments persist per workspace and never leave your machine. Quote a GitHub thread into a local comment when you want to discuss someone's feedback.
4. **Hand off to AI** — `Revu: Copy All Comments` puts the full set on your clipboard as structured markdown: file paths, line ranges, fenced code context, quoted PR threads, your notes. Paste it into your agent and discuss.

Guides are cached per scope and flagged stale when the changed-file set drifts, so reopening a review is instant.

## Read-only by design

Revu never writes to GitHub. No replies, no review submission, no mutations of any kind; a guard test fails the suite if a write path ever appears in the source. Publishing comments to a PR stays in the tools that already do it well.

## Requirements

- `git` on PATH.
- An agent CLI for guide generation (`claude`, or anything that reads a prompt on stdin and prints a response). Only needed for guides; comments work without it.
- `gh` (authenticated) for PR metadata and threads. Optional; without it Revu just skips the GitHub context.

## Commands

| Command | What it does |
| --- | --- |
| `Revu: Start Review` | Pick a scope and begin a review session. |
| `Revu: End Review` | Clear the session and any rendered PR threads. |
| `Revu: Generate Review Guide` | Generate (or regenerate) the guide for the active scope. |
| `Revu: Open Guide` | Open the guide panel for the cached guide. |
| `Revu: Refresh PR Threads` | Re-fetch GitHub review threads for the current branch's PR. |
| `Revu: Copy All Comments` | Export every local comment as markdown to the clipboard. |
| `Revu: Clear All Comments` | Delete all local comments (with confirmation). |

Per-thread actions (copy one comment, delete, quote a GitHub comment) live on the comment thread's title bar.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `revu.agentCommand` | `claude -p` | Agent CLI command used for guide generation; receives the prompt on stdin. |
| `revu.agentTimeoutSeconds` | `120` | Minimum timeout for guide generation. The effective timeout scales with prompt size (`60 + promptChars / 1000` seconds, clamped between this minimum and `revu.agentTimeoutMaxSeconds`). |
| `revu.agentTimeoutMaxSeconds` | `600` | Upper bound for the size-scaled guide generation timeout. |
| `revu.autoMarkRead` | `false` | Automatically mark a guide file as read when opened from the guide. Files can always be toggled manually with the control at the end of each row. |

## Known limitations

- Guide staleness is recomputed on file save and review scope changes. File changes made outside VS Code (e.g. terminal `touch`/`rm`) aren't detected until a save inside the editor or a manual refresh (regenerating the guide or restarting the review).
- Comment anchors are line-based and may drift when files are edited. GitHub PR threads are anchored naively to their recorded lines, so they can be misplaced if your working tree has drifted from the PR head; each thread carries its diff hunk so the context survives either way.
- `revu.agentCommand` is split on whitespace; executable paths containing spaces are not supported. Use a wrapper script.
- PRs with more than 50 review threads may not fully render on `gh` versions older than 2.33, and threads with more than 50 comments are truncated.
