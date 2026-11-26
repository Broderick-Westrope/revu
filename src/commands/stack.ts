import * as vscode from 'vscode';
import { mergeParent, planSwitch, pullDefaultBranch, PullResult } from '../branchActions';
import { checkedOutBranch, git, hasTrackedChanges, isInside, listWorktrees } from '../git';
import { ReviewState } from '../reviewState';
import { descendantsOf, resetParentOverride, setParentOverride } from '../stack';
import { StackNode } from '../stackTree';
import { addWorktree } from '../wtp';

function errorText(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr?.trim();
  return stderr || (err instanceof Error ? err.message : String(err));
}

function hasUnsavedFiles(root: string): boolean {
  return vscode.workspace.textDocuments.some(
    (doc) => doc.isDirty && doc.uri.scheme === 'file' && isInside(root, doc.uri.fsPath)
  );
}

function openFolder(folder: string, forceNewWindow: boolean): Thenable<unknown> {
  return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), {
    forceNewWindow,
  });
}

async function createWorktree(root: string, branch: string): Promise<void> {
  let folder: string | undefined;
  try {
    folder = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Revu: creating a worktree for ${branch}` },
      () => addWorktree(root, branch)
    );
  } catch (err) {
    const text =
      (err as { code?: string }).code === 'ENOENT'
        ? 'wtp is not on the PATH VS Code was started with'
        : errorText(err);
    void vscode.window.showErrorMessage(`Revu: couldn't create a worktree for ${branch}: ${text}`);
    return;
  }
  if (!folder) {
    void vscode.window.showErrorMessage(`Revu: wtp finished but no worktree has ${branch} checked out.`);
    return;
  }
  await openFolder(folder, false);
}

export async function switchToBranchCommand(
  state: ReviewState,
  node: StackNode | undefined
): Promise<void> {
  const stack = state.snapshot?.stack;
  if (!node || !stack) {
    return;
  }
  const root = state.repoRoot;
  try {
    const plan = planSwitch({
      target: node.branch,
      trunk: stack.trunk.name,
      current: stack.current?.branch,
      currentWorktree: root,
      worktrees: await listWorktrees(root),
      sameGhStack:
        stack.current?.inGhStack === true && stack.branches.get(node.branch)?.inGhStack === true,
      dirty:
        (await hasTrackedChanges(root)) ||
        hasUnsavedFiles(root),
    });
    switch (plan.kind) {
      case 'none':
        return;
      case 'openFolder':
        await openFolder(plan.path, false);
        return;
      case 'switch':
        await git(root, ['switch', node.branch]);
        await state.refresh({ external: true });
        return;
      case 'refuseDirty':
        void vscode.window.showWarningMessage(
          `Revu: commit or save your changes before switching to ${node.branch}.`
        );
        return;
      case 'createWorktree':
        await createWorktree(root, node.branch);
        return;
      case 'offerWorktree': {
        const choice = await vscode.window.showWarningMessage(
          `Revu: this worktree has uncommitted changes or unsaved files, so it won't switch to ${node.branch}.`,
          'Create Worktree'
        );
        if (choice === 'Create Worktree') {
          await createWorktree(root, node.branch);
        }
        return;
      }
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Revu: couldn't switch to ${node.branch}: ${errorText(err)}`);
    await state.refresh({ external: true });
  }
}

export async function openBranchInNewWindowCommand(node: StackNode | undefined): Promise<void> {
  if (node?.worktree) {
    await openFolder(node.worktree, true);
  }
}

export async function openPrCommand(node: StackNode | undefined): Promise<void> {
  const url = node?.resolution?.pr?.url;
  if (url) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

function pullMessage(result: PullResult, trunk: string): { warn: boolean; text: string } {
  const behind = `so ${trunk} in the root worktree stayed behind origin/${trunk}. Diffs already use origin/${trunk}.`;
  switch (result.kind) {
    case 'fastForwarded':
      return { warn: false, text: `Revu: fast-forwarded ${trunk} in the root worktree.` };
    case 'upToDate':
      return { warn: false, text: `Revu: ${trunk} is up to date with origin/${trunk}.` };
    case 'stayedBehind':
      switch (result.reason) {
        case 'dirty':
          return { warn: true, text: `Revu: fetched origin. The root worktree has tracked changes, ${behind}` };
        case 'diverged':
          return {
            warn: true,
            text: `Revu: fetched origin. Local ${trunk} has commits origin/${trunk} doesn't, so it can't fast-forward. Diffs already use origin/${trunk}.`,
          };
        case 'notOnTrunk':
          return {
            warn: true,
            text: `Revu: fetched origin. The root worktree is on ${result.branch ?? 'a detached HEAD'}, ${behind}`,
          };
      }
  }
}

export async function pullDefaultBranchCommand(state: ReviewState): Promise<void> {
  const stack = state.snapshot?.stack;
  if (!stack) {
    return;
  }
  const trunk = stack.trunk.name;
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Revu: pulling ${trunk}` },
      () => pullDefaultBranch(state.repoRoot, trunk)
    );
    const { warn, text } = pullMessage(result, trunk);
    void (warn ? vscode.window.showWarningMessage(text) : vscode.window.showInformationMessage(text));
  } catch (err) {
    void vscode.window.showErrorMessage(`Revu: Pull Default Branch failed: ${errorText(err)}`);
  }
  await state.refresh();
}

export async function mergeParentCommand(state: ReviewState): Promise<void> {
  const stack = state.snapshot?.stack;
  const current = stack?.current;
  if (!stack || !current || current.onTrunk) {
    void vscode.window.showInformationMessage('Revu: check out a feature branch to merge its parent.');
    return;
  }
  if (current.inGhStack) {
    void vscode.window.showInformationMessage(
      'Revu: this branch is in a gh stack; restack it from the terminal instead of merging.'
    );
    return;
  }
  if (hasUnsavedFiles(state.repoRoot)) {
    void vscode.window.showWarningMessage('Revu: save your files before merging the parent.');
    return;
  }
  if (current.ambiguous) {
    const choice = await vscode.window.showWarningMessage(
      `Revu: ${current.parent} is a guess at this branch's parent. Merge it into ${current.branch} anyway?`,
      { modal: true },
      'Merge'
    );
    if (choice !== 'Merge') {
      return;
    }
  }
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Revu: merging ${current.parent}` },
      () => mergeParent(state.repoRoot, current)
    );
    switch (result.kind) {
      case 'mergeInProgress':
        void vscode.window.showWarningMessage(
          'Revu: a merge is already in progress here. Finish or abort it in Source Control first.'
        );
        break;
      case 'branchChanged':
        void vscode.window.showWarningMessage(
          `Revu: ${current.branch} is no longer checked out here, so nothing was merged.`
        );
        break;
      case 'dirty':
        void vscode.window.showWarningMessage(
          'Revu: this worktree has tracked changes. Commit them before merging the parent.'
        );
        break;
      case 'upToDate':
        void vscode.window.showInformationMessage(
          `Revu: ${current.branch} already contains ${current.parent}.`
        );
        break;
      case 'conflict':
        void vscode.window.showWarningMessage(
          `Revu: merging ${current.parent} hit conflicts. The merge is still in progress; resolve it in Source Control.`
        );
        await vscode.commands.executeCommand('workbench.view.scm');
        break;
      case 'merged':
        void vscode.window.showInformationMessage(
          `Revu: merged ${current.parent} into ${current.branch}.` +
            (result.checkpointMoved ? ' The checkpoint moved to the merge commit.' : '')
        );
        break;
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Revu: Merge Parent failed: ${errorText(err)}`);
  }
  await state.refresh();
}

export async function compareWithCommand(state: ReviewState): Promise<void> {
  const stack = state.snapshot?.stack;
  const current = stack?.current;
  if (!stack || !current || current.onTrunk) {
    void vscode.window.showInformationMessage('Revu: check out a feature branch to pick its parent.');
    return;
  }
  const above = descendantsOf(stack, current.branch);
  const names = [stack.trunk.name, ...[...stack.branches.keys()].sort()].filter(
    (name) => name !== current.branch && !above.has(name)
  );
  const picked = await vscode.window.showQuickPick(
    names.map((name) => ({
      label: name,
      description: name === current.parent ? 'current parent' : undefined,
    })),
    { placeHolder: `Compare ${current.branch} with…` }
  );
  if (!picked) {
    return;
  }
  try {
    await setParentOverride(state.repoRoot, current.branch, picked.label);
  } catch (err) {
    void vscode.window.showErrorMessage(`Revu: couldn't set the parent: ${errorText(err)}`);
  }
  await state.refresh();
}

export async function resetParentCommand(state: ReviewState): Promise<void> {
  const branch = await checkedOutBranch(state.repoRoot);
  if (!branch) {
    return;
  }
  try {
    await resetParentOverride(state.repoRoot, branch);
  } catch (err) {
    void vscode.window.showErrorMessage(`Revu: couldn't reset the parent: ${errorText(err)}`);
  }
  await state.refresh();
}
