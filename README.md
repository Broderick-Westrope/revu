# Revu

Guided review and local review comments for AI-assisted workflows, inside VS Code and Cursor.

## Features

- **Review scopes** — review the working tree vs HEAD (including untracked files) or the current branch vs its merge-base with the default branch.
- **Guided review** — `Revu: Generate Review Guide` shells out to a configured agent CLI (default `claude -p`) and renders themed, ordered file groups with commentary and "pay attention to" notes in the Revu sidebar. Guides are cached per scope and marked stale when the changed-file set drifts; regenerate manually with the same command.
- **Local review comments** — attach comments to lines or ranges via the native commenting UI, then export everything as AI-friendly markdown to the clipboard.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `revu.agentCommand` | `claude -p` | Agent CLI command used for guide generation; receives the prompt on stdin. |
| `revu.agentTimeoutSeconds` | `120` | Minimum timeout for guide generation. The effective timeout scales with prompt size (`60 + promptChars / 1000` seconds, clamped between this minimum and `revu.agentTimeoutMaxSeconds`). |
| `revu.agentTimeoutMaxSeconds` | `600` | Upper bound for the size-scaled guide generation timeout. |
| `revu.autoMarkRead` | `false` | Automatically mark a guide file as read when opened from the guide. Files can always be marked read/unread manually with the toggle at the end of each row in the guide panel. |

## Known limitations

- Guide staleness is recomputed on file save and review scope changes. File changes made outside VS Code (e.g. terminal `touch`/`rm`) aren't detected until a save inside the editor or a manual refresh (regenerating the guide or restarting the review).
- Comment anchors are line-based and may drift when files are edited.
- `revu.agentCommand` is split on whitespace; executable paths containing spaces are not supported — use a wrapper script.
- PRs with more than 50 review threads may not fully render on `gh` versions older than 2.33, and threads with more than 50 comments are truncated.
