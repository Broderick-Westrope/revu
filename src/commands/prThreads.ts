import * as vscode from 'vscode';
import { currentBranch, isDetachedHead } from '../git';
import { fetchPrMetadata, fetchReviewThreads, isGhAvailable, resetGhAvailability } from '../github/gh';
import { GithubThreadRenderer } from '../github/threadRenderer';

async function checkedOutBranch(repoRoot: string): Promise<string | undefined> {
  return (await isDetachedHead(repoRoot)) ? undefined : currentBranch(repoRoot);
}

export async function refreshPrThreads(
  renderer: GithubThreadRenderer,
  repoRoot: string,
  options: { announce?: boolean } = {}
): Promise<void> {
  renderer.clear();
  resetGhAvailability();
  try {
    const branch = await checkedOutBranch(repoRoot);
    if (!branch || !(await isGhAvailable(repoRoot))) {
      return;
    }
    const meta = await fetchPrMetadata(repoRoot, branch);
    if (!meta) {
      return;
    }
    const threads = await fetchReviewThreads(repoRoot, meta.number);
    if ((await checkedOutBranch(repoRoot)) !== branch) {
      return;
    }
    const { shown, skipped } = renderer.renderThreads(repoRoot, threads);
    if (options.announce) {
      void vscode.window.showInformationMessage(
        `Revu: PR #${meta.number}: ${shown} threads shown, ${skipped} skipped (outdated).`
      );
    }
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Revu: could not load GitHub PR data: ${(err as Error).message}`
    );
  }
}
