# Revu

Branch-aware code review and local review comments, inside VS Code and Cursor.

![demo](https://raw.githubusercontent.com/Broderick-Westrope/revu/refs/heads/master/media/demo.gif)

## Why this exists

This is a personal tool built around one specific review flow. AI review is already handled elsewhere: an agent reviews changes in my terminal harness, [anvil](https://github.com/Broderick-Westrope/anvil). But I still want to review changes manually, and that's where the gaps were.

When I sit down to review a PR (mine or someone else's), the flow looks like this:

1. **Get oriented.** Before reading any code, I want to see where the branch sits (what it's stacked on, whether it has a PR) and exactly what it changes, without upstream commits or lower layers of a stack mixed in.
2. **Read and annotate.** As I work through the diffs, I leave comments on the code. These aren't PR comments; they're questions, doubts, and things I want to verify. They belong to me, not the thread.
3. **Collaborate with the agent.** I hand those comments to the agent in my terminal to answer the questions, validate my understanding, and dig into anything suspicious.
4. **Finalise on GitHub.** Whatever survives that conversation becomes actual PR feedback, left via the official [GitHub Pull Requests](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) extension as usual.

Steps 1–3 had no good home. The pieces existed, but spread across three tools in three different places:

- [GitLens](https://www.gitkraken.com/gitlens) compares a branch with anything, but has no idea which branch it's stacked on, and every comparison is set up by hand.
- [pair-review](https://github.com/in-the-loop-labs/pair-review) reviews local changes with AI assistance, but in a browser, outside the editor.
- [comment-renderer](https://marketplace.visualstudio.com/items?itemName=statiolake.vscode-comment-renderer) exports editor comments as markdown for agents, but knows nothing about which branch or change you're reviewing.

Revu is those three ideas rebuilt as one extension, in the editor where the review actually happens. Credit to all three for the inspiration.

## How it works

Revu always reviews the checked-out branch against its parent, so there's nothing to start. The parent is the branch below it in a stack, or `origin/<default>` when it has none. Diffs start at the merge-base with the parent, so new commits on the parent and a stale local `main` never show up.

The parent is picked in this order, and the Changes view title says which one won (for example `vs feat/port (inferred)`):

1. An override you set with `Revu: Compare With…` (stored as `branch.<name>.revuParent` in git config; `Revu: Reset Parent` removes it).
2. The layer below it in a `gh stack`.
3. The base of its open PR.
4. The branch it was created from, read from git's branch reflog, falling back to the nearest branch it forked from.
5. `origin/<default>`.

The sidebar has three views:

1. **Stack** shows the current branch's chain of parents down to the default branch and the branches stacked on top of it, with each one's PR, commits ahead of and behind its parent, and whether a gh stack says it needs a rebase. Switch on a row opens the branch's worktree in this window, creating one with `wtp` when it has none. Layers of the same gh stack switch in place instead (when nothing is uncommitted or unsaved), and so does the default branch's row when this window is the root worktree. The title bar has Pull Default Branch (fetch, then fast-forward the root worktree when it's clean) and Merge Parent (hidden for gh-stack branches, where restacking is the tool).
2. **Changes** lists the files changed on this branch against its parent, including uncommitted and untracked files, as a folder tree. Files open as native diffs with the live file on the right. The milestone button narrows the list to changes since the branch's checkpoint.
3. **Checkpoint** tracks which commits you've already reviewed (see [Checkpoints](#checkpoints)).

While reading diffs, leave comments with the native commenting UI (the `+` in the gutter). Comments are kept per branch and never leave your machine. GitHub threads for the branch's own PR render inline read-only, and you can quote one into a local comment. When you're done, `Revu: Copy All Comments as Markdown` puts the branch's comments on your clipboard as structured markdown (file paths, line ranges, fenced code context, quoted PR threads and your notes) to hand to your agent.

Changes made outside the editor (an agent committing in another worktree, a fetch, a checkpoint moved from the terminal) show up when the window regains focus. PR state and gh stack data refresh when you switch branches or press Refresh.

### Checkpoints

The Checkpoint view tracks what you've already reviewed on the current branch. It lists the commits after the checkpoint (a per-branch ref, defaulting to the merge-base with the branch's parent). Marking a commit safe (the check action on a commit row) advances the checkpoint past it. Reviewed commits stay visible below with a check icon, the checkpoint is marked with a milestone icon, and Move Checkpoint Here moves it backwards. Merge commits show only what the merge changed beyond an automatic merge of its parents. `Revu: Set Checkpoint` picks any commit; `Revu: Remove Checkpoint` falls back to the merge-base. From a commit diff, `Revu: Compare with Working Tree` shows how that file looks now.

## Read-only by design

Revu never writes to GitHub. No replies, no review submission, no pushes, no mutations of any kind; a guard test fails the suite if a write path ever appears in the source. That's deliberate: local comments are drafts for an agent conversation, and it should be impossible to accidentally publish one. Posting real PR feedback stays with the GitHub extension.

It does change your local repo when you ask it to: Pull Default Branch fetches and fast-forwards the root worktree, Merge Parent merges (fetching first when the parent is a remote branch), Switch runs `git switch` or `wtp add`, Compare With… writes `branch.<name>.revuParent` to git config, and checkpoints are refs under `refs/revu/`.

## Requirements

- `git` 2.38 or newer on PATH (merge commit rows use `git merge-tree --write-tree`).
- An `origin/HEAD` ref, or a local `main` or `master`, so Revu can find the default branch. Without one the Changes view reports that it can't read the branch.
- `gh` (authenticated) for PR state and threads. Optional; without it Revu skips the GitHub context and finds parents from git alone.
- The `gh stack` extension, optional, for exact parents of gh-stack layers.
- `wtp` on the PATH VS Code sees, for switching to a branch that has no worktree yet.

## Commands

| Command | What it does |
| --- | --- |
| `Revu: Refresh` | Re-read git state and PR data for all three views. |
| `Revu: Pull Default Branch` | Fetch `origin`, then fast-forward the root worktree when it's on the default branch and clean. |
| `Revu: Merge Parent` | Merge the branch's parent into it. Refuses with uncommitted tracked changes; leaves conflicts for the merge editor. |
| `Revu: Compare With…` | Pick the branch's parent yourself. |
| `Revu: Reset Parent` | Remove that choice and go back to the resolved parent. |
| `Revu: Show Changes Since Checkpoint` / `Revu: Show All Branch Changes` | Toggle the Changes view's checkpoint mode. |
| `Revu: Refresh PR Threads` | Re-fetch GitHub review threads for the branch's PR. |
| `Revu: Copy All Comments as Markdown` | Export the branch's local comments to the clipboard. |
| `Revu: Clear All Comments` | Delete the branch's local comments (with confirmation). |
| `Revu: Set Checkpoint` | Pick the commit everything up to which counts as reviewed on this branch. |
| `Revu: Remove Checkpoint` | Delete the branch's checkpoint ref. |
| `Revu: Compare with Working Tree` | From a commit diff, show the same file against the working tree. |

Switch, Open in New Window and Open PR are inline actions on Stack rows. Per-thread actions (copy one comment, delete, quote a GitHub comment) live on the comment thread's title bar. Mark Safe and Move Checkpoint Here are inline actions on commit rows.

## Known limitations

- Switching to a branch in another worktree replaces this window's folder, which reloads the extension host and closes open editors. Use Open in New Window to keep both.
- Parent inference reads where each branch was created from git's reflog, which git expires after 90 days by default; older branches fall back to guessing from history, and the Changes view marks the guess as ambiguous.
- Ahead and behind counts are relative to your last fetch. Revu only fetches in Pull Default Branch and Merge Parent.
- PR state comes from the 200 most recent PRs in the repo, plus the current branch's own PR, so an old branch other than the current one may show "no PR".
- Comment anchors are line-based and may drift when files are edited. GitHub PR threads are anchored naively to their recorded lines, so they can be misplaced if your working tree has drifted from the PR head; each thread carries its diff hunk so the context survives either way.
- PRs with more than 50 review threads may not fully render on `gh` versions older than 2.33, and threads with more than 50 comments are truncated.
