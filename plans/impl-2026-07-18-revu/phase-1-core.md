# Phase 1: Core — Scaffold, Scope, Git Engine, Diff Opening

> **Status:** DRAFT
> Part of `plans/impl-2026-07-18-revu/README.md`

## Specification

**Problem:** Nothing exists yet. Every later phase needs an extension skeleton, a notion of "the current review scope", a git layer that answers "what changed and against which base ref", and a way to open a changed file as a native diff.

**Goal:** A runnable extension where the user can start a review (picking working-tree or branch scope), see it activate, and open any changed file as a native diff (base ref left, working file right) — including deleted and renamed files.

**Scope:** Extension scaffold (TypeScript + esbuild), `ReviewScope` model, git CLI wrapper, `revu-git:` content provider, `revu.startReview` + `revu.openDiff` commands. No comments, no guide, no GitHub.

**Success Criteria:**
- [ ] `revu.startReview` shows a QuickPick (Working tree vs HEAD / Branch vs merge-base), warns and aborts on branch scope while on the default branch
- [ ] Changed files (including untracked, renames via `-M`, deletions) are enumerated correctly
- [ ] `revu.openDiff` on a modified file opens native diff: base-ref content left, real working file right
- [ ] Deleted file → diff with empty right side; renamed file → old path left, new path right
- [ ] `npm run compile` clean; extension loads in both VS Code and Cursor Extension Development Host

## Context Loading

_Run before starting:_

```bash
read plans/design-2026-07-18-review-extension.md
```

## Scaffold Tasks

### Task 1: Extension scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `.vscodeignore`, `.gitignore`, `src/extension.ts`

**Steps:**

1. [ ] Create `package.json`:

```json
{
  "name": "revu",
  "displayName": "Revu",
  "description": "Guided review and local review comments for AI-assisted workflows",
  "version": "0.0.1",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      { "command": "revu.startReview", "title": "Revu: Start Review" },
      { "command": "revu.endReview", "title": "Revu: End Review" },
      { "command": "revu.openDiff", "title": "Revu: Open Diff" }
    ],
    "configuration": {
      "title": "Revu",
      "properties": {
        "revu.agentCommand": {
          "type": "string",
          "default": "claude -p",
          "description": "Agent CLI command used for guide generation. Receives the prompt on stdin."
        },
        "revu.agentTimeoutSeconds": { "type": "number", "default": 120 }
      }
    }
  },
  "scripts": {
    "compile": "tsc --noEmit && node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "test": "vscode-test"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "@types/vscode": "^1.85.0",
    "@vscode/test-cli": "^0.0.10",
    "@vscode/test-electron": "^2.4.1",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0"
  }
}
```

2. [ ] Create `esbuild.mjs` bundling `src/extension.ts` → `dist/extension.js` (`platform: 'node'`, `external: ['vscode']`, `format: 'cjs'`, sourcemap, `--watch` flag support)
3. [ ] Create `tsconfig.json` (`module: commonjs`, `target: es2022`, `strict: true`, `outDir: dist`, `rootDir: src`)
4. [ ] Create `src/extension.ts` with `activate`/`deactivate` registering the three commands as stubs
5. [ ] Create `.gitignore` (`node_modules/`, `dist/`, `*.vsix`) and `.vscodeignore`

**Verify:**
```bash
cd /Users/broderick.westrope/dev/helse/revu && npm install && npm run compile
# Expected: exits 0, dist/extension.js exists
```

## Git Engine Tasks

### Task 2: Git wrapper and ReviewScope model

**Context:** `src/extension.ts`

**Files:**
- Create: `src/git.ts`, `src/scope.ts`
- Test: `src/test/git.test.ts`

**Steps:**

1. [ ] Create `src/git.ts` — thin promisified wrapper over `child_process.execFile('git', args, { cwd })` exposing:

```ts
export interface ChangedFile {
  path: string;            // workspace-relative, current name
  oldPath?: string;        // set for renames
  status: 'A' | 'M' | 'D' | 'R' | 'U'; // U = untracked
}

export async function repoRoot(cwd: string): Promise<string>;            // git rev-parse --show-toplevel
export async function currentBranch(cwd: string): Promise<string>;       // git rev-parse --abbrev-ref HEAD
export async function defaultBranch(cwd: string): Promise<string>;
// git symbolic-ref --short refs/remotes/origin/HEAD → strip "origin/";
// fallback: first of main/master that `git rev-parse --verify` resolves
export async function mergeBase(cwd: string, ref: string): Promise<string>; // git merge-base HEAD <ref>
export async function changedFiles(cwd: string, baseRef: string, includeUntracked: boolean): Promise<ChangedFile[]>;
// git diff --name-status -M <baseRef> ; parse R### lines into {oldPath, path, status:'R'}
// if includeUntracked: append git ls-files --others --exclude-standard as status 'U'
export async function showFile(cwd: string, ref: string, path: string): Promise<string>; // git show <ref>:<path>
export async function nameStatusHash(cwd: string, baseRef: string, includeUntracked: boolean): Promise<string>;
// sha256 of (name-status output + '\n' + untracked list if applicable)
export async function diffText(cwd: string, baseRef: string, path?: string): Promise<string>; // git diff <baseRef> [-- <path>]
```

2. [ ] Create `src/scope.ts`:

```ts
export type ScopeType = 'workingTree' | 'branch';
export interface ReviewScope {
  type: ScopeType;
  baseRef: string;   // 'HEAD' for workingTree; merge-base SHA for branch
  repoRoot: string;
}
```

Module holds the active scope in memory, exposes `getActiveScope()`, `setActiveScope()`, `clearActiveScope()`, and an `onDidChangeScope` event (`vscode.EventEmitter`). Also `scopeKey(scope): string` → `"workingTree"` or `"branch:<baseRef>"` (used later for cache keys).

3. [ ] Add integration test `src/test/git.test.ts` using a temp git repo fixture (created in `suiteSetup` via `execFile('git', ['init'])`, config user, commit files): covers changedFiles for modify/add/delete/rename/untracked, defaultBranch fallback, nameStatusHash changes when an untracked file is added

**Verify:**
```bash
npm test
# Expected: git suite passing (≥6 assertions), 0 failures
```

### Task 3: Scope picker command

**Context:** `src/git.ts`, `src/scope.ts`, `src/extension.ts`

**Files:**
- Modify: `src/extension.ts`
- Create: `src/commands/startReview.ts`

**Steps:**

1. [ ] Implement `revu.startReview`:
   - Resolve repo root from first workspace folder; error notification if not a git repo
   - QuickPick: "Working tree vs HEAD" / "Branch vs merge-base with default branch"
   - Working tree → `ReviewScope { type: 'workingTree', baseRef: 'HEAD' }`
   - Branch → resolve default branch; if `currentBranch === defaultBranch`, show warning "You are on <branch>; branch scope would be empty" and abort. Otherwise `baseRef = mergeBase(defaultBranch)`
   - `setActiveScope(...)`; set context key `vscode.commands.executeCommand('setContext', 'revu.reviewActive', true)`
2. [ ] Implement `revu.endReview`: clear scope, unset context key

**Verify:**
```bash
npm run compile
# Manual (F5 Extension Development Host): startReview on a repo with changes → both scopes selectable;
# on default branch, branch scope warns and aborts.
```

## Diff Opening Tasks

### Task 4: Base-ref content provider and openDiff

**Context:** `src/git.ts`, `src/scope.ts`

**Files:**
- Create: `src/gitContentProvider.ts`, `src/commands/openDiff.ts`
- Modify: `src/extension.ts`

**Steps:**

1. [ ] Create `src/gitContentProvider.ts` — `TextDocumentContentProvider` for scheme `revu-git`. URI shape: `revu-git:/<workspace-relative-path>?<JSON {ref, repoRoot, path}>`. `provideTextDocumentContent` returns `showFile(repoRoot, ref, path)`; returns `''` when `ref === 'EMPTY'` or `git show` fails (file absent at ref, e.g., added files). Export `makeGitUri(repoRoot, ref, path): vscode.Uri`. Register in `activate`.
2. [ ] Create `src/commands/openDiff.ts` — `revu.openDiff` takes a `ChangedFile` (or path string), with active scope:
   - `M`/`A`/`U`: `vscode.diff(makeGitUri(root, baseRef, path), fileUri(path), "<basename> (Revu)")` — added/untracked left side resolves to `''`
   - `D`: `vscode.diff(makeGitUri(root, baseRef, path), makeGitUri(root, 'EMPTY', path), "<basename> (deleted)")`
   - `R`: `vscode.diff(makeGitUri(root, baseRef, oldPath), fileUri(path), "<oldName> → <newName>")`
3. [ ] Keep left-side path in the URI path component so the diff editor shows a sensible filename/language mode

**Verify:**
```bash
npm run compile
# Manual: in a repo with a modified, added, deleted, and renamed file (branch scope),
# openDiff on each shows correct left/right content; right side of M/R is the real editable document.
```

### Task 5: Commit scaffold

**Steps:**

1. [ ] `git add -A && git commit` in the revu repo with message "Phase 1: extension scaffold, git engine, scope model, native diff opening"
2. [ ] Note: plan files and spec are committed alongside (first commit of the repo)

**Verify:**
```bash
git -C /Users/broderick.westrope/dev/helse/revu log --oneline
# Expected: at least 1 commit containing src/ and plans/
```
