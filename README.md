# Revu

Guided code review and local review comments, inside VS Code and Cursor.

![demo](https://raw.githubusercontent.com/Broderick-Westrope/revu/refs/heads/master/media/demo.gif)

## Why this exists

This is a personal tool built around one specific review flow. AI review is already handled elsewhere: an agent reviews changes in my terminal harness, [anvil](https://github.com/Broderick-Westrope/anvil). But I still want to review changes manually, and that's where the gaps were.

When I sit down to review a PR (mine or someone else's), the flow looks like this:

1. **Get oriented.** Before reading any code, I want guidance on how to approach the review: which files form the core of the change, which are supporting noise, and what order to read them in.
2. **Read and annotate.** As I work through the diffs, I leave comments on the code. These aren't PR comments; they're questions, doubts, and things I want to verify. They belong to me, not the thread.
3. **Collaborate with the agent.** I hand those comments to the agent in my terminal to answer the questions, validate my understanding, and dig into anything suspicious.
4. **Finalise on GitHub.** Whatever survives that conversation becomes actual PR feedback, left via the official [GitHub Pull Requests](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) extension as usual.

Steps 1–3 had no good home. The pieces existed, but spread across three tools in three different places:

- [Linear's guided reviews](https://linear.app/docs/diffs#guides) do the orientation step beautifully, but only for PRs, and only in Linear.
- [pair-review](https://github.com/in-the-loop-labs/pair-review) reviews local changes with AI assistance, but in a browser, outside the editor.
- [comment-renderer](https://marketplace.visualstudio.com/items?itemName=statiolake.vscode-comment-renderer) exports editor comments as markdown for agents, but without diff scopes or review guidance.

Revu is those three ideas rebuilt as one extension, in the editor where the review actually happens. Credit to all three for the inspiration.

## How it works

1. **Start a review** — `Revu: Start Review`, pick a scope: working tree vs HEAD (untracked files included) or current branch vs merge-base with the default branch. No push or PR needed for your own work. If the branch does have an open PR, Revu fetches its metadata and review threads via `gh`.
2. **Generate a guide** — `Revu: Generate Review Guide` sends the diff to your agent CLI (default `claude -p`) and opens the guide in an editor tab: overall summary, themed sections in suggested review order, attention notes, and clickable file rows. Files open as native diffs in the adjacent editor group, jumping straight to the lines the note references. Mark files read as you go. The sidebar tree mirrors the sections for quick navigation.
3. **Leave comments** — use the native commenting UI (the `+` in the gutter) on any line or range. Comments persist per workspace and never leave your machine. Existing GitHub threads render inline read-only, and you can quote one into a local comment when you want to discuss someone's feedback with the agent.
4. **Hand off to the agent** — `Revu: Copy All Comments` puts the full set on your clipboard as structured markdown: file paths, line ranges, fenced code context, quoted PR threads, your notes. Paste it into your preferred agent ([anvil](https://github.com/Broderick-Westrope/anvil) for me) and work through it together.

Guides are cached per scope and flagged stale when the changed-file set drifts, so reopening a review is instant.

## Read-only by design

Revu never writes to GitHub. No replies, no review submission, no mutations of any kind; a guard test fails the suite if a write path ever appears in the source. That's deliberate: local comments are drafts for an agent conversation, and it should be impossible to accidentally publish one. Posting real PR feedback stays with the GitHub extension.

## Requirements

- `git` on PATH.
- An agent CLI for guide generation (`claude`, or anything that reads a prompt on stdin and prints a response). Only needed for guides; comments work without it.
- `gh` (authenticated) for PR metadata and threads. Optional; without it Revu just skips the GitHub context.

## Commands

| Command                       | What it does                                                |
| ----------------------------- | ----------------------------------------------------------- |
| `Revu: Start Review`          | Pick a scope and begin a review session.                    |
| `Revu: End Review`            | Clear the session and any rendered PR threads.              |
| `Revu: Generate Review Guide` | Generate (or regenerate) the guide for the active scope.    |
| `Revu: Open Guide`            | Open the guide panel for the cached guide.                  |
| `Revu: Refresh PR Threads`    | Re-fetch GitHub review threads for the current branch's PR. |
| `Revu: Copy All Comments`     | Export every local comment as markdown to the clipboard.    |
| `Revu: Clear All Comments`    | Delete all local comments (with confirmation).              |

Per-thread actions (copy one comment, delete, quote a GitHub comment) live on the comment thread's title bar.

## Settings

| Setting                       | Default     | Description                                                                                                                                                                              |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revu.agentCommand`           | `claude -p` | Agent CLI command used for guide generation; receives the prompt on stdin.                                                                                                               |
| `revu.agentTimeoutSeconds`    | `120`       | Minimum timeout for guide generation. The effective timeout scales with prompt size (`60 + promptChars / 1000` seconds, clamped between this minimum and `revu.agentTimeoutMaxSeconds`). |
| `revu.agentTimeoutMaxSeconds` | `600`       | Upper bound for the size-scaled guide generation timeout.                                                                                                                                |
| `revu.autoMarkRead`           | `false`     | Automatically mark a guide file as read when opened from the guide. Files can always be toggled manually with the control at the end of each row.                                        |

## Known limitations

- Guide staleness is recomputed on file save and review scope changes. File changes made outside VS Code (e.g. terminal `touch`/`rm`) aren't detected until a save inside the editor or a manual refresh (regenerating the guide or restarting the review).
- Comment anchors are line-based and may drift when files are edited. GitHub PR threads are anchored naively to their recorded lines, so they can be misplaced if your working tree has drifted from the PR head; each thread carries its diff hunk so the context survives either way.
- `revu.agentCommand` is split on whitespace; executable paths containing spaces are not supported. Use a wrapper script.
- PRs with more than 50 review threads may not fully render on `gh` versions older than 2.33, and threads with more than 50 comments are truncated.
