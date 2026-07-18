# Phase 3: Guided Review — Agent CLI, Guide Tree, Caching

> **Status:** COMPLETED
> Part of `plans/impl-2026-07-18-revu/README.md` — depends on Phase 1. Parallel with Phase 2.

## Specification

**Problem:** No way to get an LLM-generated review guide (themed file groups, suggested order, commentary) for the active scope.

**Goal:** A "Generate Guide" command shells out to the configured agent CLI, parses a structured JSON guide, and renders it in a sidebar tree (ordered groups → files, theme lines, attention notes). Cached per scope + changed-file-set hash with a visible stale indicator; regenerate is manual.

**Scope:** Prompt builder, agent CLI runner, guide JSON contract + parsing, tree view, cache/staleness. PR title/description enters the prompt in Phase 4 (the prompt builder takes an optional `prContext` string now, always undefined in this phase).

**Success Criteria:**
- [ ] `revu.generateGuide` runs the configured agent CLI with progress UI, non-blocking, cancellable, timeout enforced
- [ ] Tree shows groups in suggested order with theme descriptions; file children open via `revu.openDiff`; attention notes visible (tooltip + expandable note nodes)
- [ ] Guide persists in `workspaceState`; reopening the workspace shows the cached guide instantly
- [ ] Changing the changed-file set (including adding an untracked file in working-tree scope) flips the tree to a stale state; regenerate clears it
- [ ] Malformed agent output produces a clear error notification, not a crash

## Context Loading

```bash
read plans/design-2026-07-18-review-extension.md
read src/git.ts src/scope.ts src/commands/openDiff.ts
```

## Generation Tasks

### Task 1: Guide model, prompt builder, agent runner

**Files:**
- Create: `src/guide/model.ts`, `src/guide/prompt.ts`, `src/guide/agent.ts`
- Test: `src/test/guide.test.ts`

**Steps:**

1. [ ] Create `src/guide/model.ts`:

```ts
export interface GuideFile { path: string; note?: string }
export interface GuideGroup {
  title: string;          // e.g. "Auth service refactor"
  theme: string;          // one-line commentary on what this group is about
  attention: string[];    // "pay attention to" bullets
  files: GuideFile[];
}
export interface Guide {
  summary: string;        // 1-3 sentence overview of the whole change
  groups: GuideGroup[];   // in suggested review order
}
export interface CachedGuide { guide: Guide; scopeKey: string; hash: string; generatedAt: string }
```

2. [ ] Create `src/guide/prompt.ts` — `buildPrompt(files: ChangedFile[], diff: string, prContext?: string): string`:
   - Instructions: group related changed files by theme (generated code together, related tests together, one functional unit per group); order groups core-first, low-signal last (generated/lockfiles last); per group give `title`, one-line `theme`, `attention` bullets; every changed file appears in exactly one group; respond with **only** a JSON object matching the `Guide` shape (include the JSON schema inline in the prompt)
   - Include `prContext` section when provided
   - Include name-status file list, then the unified diff with per-file truncation: max 400 diff lines per file, replaced tail marked `[... truncated N lines]`; hard cap total prompt at ~150k characters (drop diff bodies of the largest files first, keeping their names in the list, marked `[diff omitted for size]`)
3. [ ] Create `src/guide/agent.ts` — `runAgent(prompt: string, token: vscode.CancellationToken): Promise<string>`:
   - Read `revu.agentCommand` + `revu.agentTimeoutSeconds`; split command string into cmd + args; spawn via `child_process.spawn(cmd, args, { cwd: repoRoot, shell: false })`, write prompt to stdin, collect stdout
   - Kill on cancellation or timeout; reject with stderr excerpt on non-zero exit
4. [ ] Add `parseGuide(raw: string): Guide` in `src/guide/model.ts` — first try extracting a ```` ```json ```` fenced block; fall back to the substring between the first `{` and its balanced closing `}` (brace matching, not last-`}`); `JSON.parse`, then validate shape (arrays present, strings non-empty, every group has ≥1 file); throw descriptive `Error` otherwise
5. [ ] Unit tests: `buildPrompt` truncation behavior; `parseGuide` on clean JSON, fenced JSON, prose-wrapped JSON, and garbage (throws)

**Verify:**
```bash
npm test
# Expected: guide suite passing (≥6 assertions), 0 failures
```

### Task 2: generateGuide command with cache

**Context:** `src/guide/*.ts`, `src/git.ts`, `src/scope.ts`

**Files:**
- Create: `src/guide/cache.ts`, `src/commands/generateGuide.ts`
- Modify: `src/extension.ts`

**Steps:**

1. [ ] Create `src/guide/cache.ts` — `workspaceState` key `revu.guide.<scopeKey>` storing `CachedGuide`; `get(scopeKey)`, `put(cached)`, `isStale(cached, currentHash)`
2. [ ] Implement `revu.generateGuide`:
   - Require active scope (prompt to run Start Review otherwise)
   - Gather `changedFiles` + `diffText`; if empty → info message, abort
   - `vscode.window.withProgress({ location: Notification, cancellable: true }, ...)` around `runAgent`
   - Parse, compute `nameStatusHash`, `cache.put(...)`, fire guide-changed event
   - On parse/agent failure: `showErrorMessage` with a "Show raw output" action that opens the raw agent output in an untitled document

**Verify:**
```bash
npm run compile
# Manual: with claude CLI installed, generateGuide on a real diff produces a cached guide;
# error path testable by setting revu.agentCommand to "false" (exits non-zero).
```

## Tree View Tasks

### Task 3: Guide tree view with staleness

**Context:** `src/guide/model.ts`, `src/guide/cache.ts`, `src/scope.ts`

**Files:**
- Create: `src/guide/treeView.ts`
- Modify: `src/extension.ts`, `package.json`

**Steps:**

1. [ ] `package.json` contributions:
   - `viewsContainers.activitybar`: id `revu`, title "Revu", icon (codicon-style SVG `media/revu.svg` — simple checklist glyph)
   - `views.revu`: id `revu.guideView`, name "Review Guide"
   - `view/title` menu: `revu.generateGuide` (icon `$(sparkle)`), `revu.startReview`
   - `viewsWelcome` for `revu.guideView`: "Start a review to begin" → command link, and (when review active, no guide) "Generate a guide"
2. [ ] Create `src/guide/treeView.ts` — `TreeDataProvider<GuideNode>`:
   - Root: group nodes in guide order — `label: "N. <title>"`, `description: theme`, `tooltip`: theme + attention bullets (MarkdownString), collapsible
   - Group children: one `$(warning)`-less note node per attention bullet (non-clickable, `label: "⚠ <bullet>"`), then file nodes — `resourceUri` for icons, `description: note`, `command: revu.openDiff` with the matching `ChangedFile` as arg (if the file is no longer in the changed set, fall back to `vscode.window.showTextDocument` on the plain file)
   - Refresh on guide-changed and scope-changed events
3. [ ] Staleness: on tree refresh and on a debounced (2s) `onDidSaveTextDocument` + `onDidChangeScope` listener, recompute `nameStatusHash`; when it differs from the cached hash set `treeView.message = "⚠ Guide is stale — changes differ from when it was generated. Regenerate."`; clear message when fresh. Known limitation (document in README): file changes made outside VS Code (terminal `touch`/`rm`) aren't detected until a save or manual refresh.
4. [ ] `revu.generateGuide` regenerates over a stale/existing guide (same command, no separate "regenerate")

**Verify:**
```bash
npm run compile
# Manual: guide renders ordered groups with themes; clicking files opens diffs;
# touching a new file flips the stale banner; regenerate clears it; cached guide survives reload.
```

### Task 4: Commit

**Steps:**

1. [ ] Commit: "Phase 3: guided review — agent CLI generation, guide tree view, cache + staleness"

**Verify:**
```bash
git -C /Users/broderick.westrope/dev/helse/revu status --short
# Expected: clean
```
