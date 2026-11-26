import * as vscode from 'vscode';
import { checkedOutBranch } from '../git';
import { fetchPrNumber, fetchReviewThreads, isGhAvailable } from '../github/gh';
import { GithubThreadRenderer } from '../github/threadRenderer';
import { logWarning } from '../log';

export async function refreshPrThreads(
  renderer: GithubThreadRenderer,
  repoRoot: string,
  options: { announce?: boolean } = {}
): Promise<void> {
  renderer.clear();
  try {
    const branch = await checkedOutBranch(repoRoot);
    if (!branch || !(await isGhAvailable(repoRoot))) {
      return;
    }
    const prNumber = await fetchPrNumber(repoRoot, branch);
    if (prNumber === undefined) {
      return;
    }
    const threads = await fetchReviewThreads(repoRoot, prNumber);
    if ((await checkedOutBranch(repoRoot)) !== branch) {
      return;
    }
    const { shown, skipped } = renderer.renderThreads(repoRoot, threads);
    if (options.announce) {
      void vscode.window.showInformationMessage(
        `Revu: PR #${prNumber}: ${shown} threads shown, ${skipped} skipped (outdated).`
      );
    }
  } catch (err) {
    const message = `could not load GitHub PR threads: ${(err as Error).message}`;
    if (options.announce) {
      void vscode.window.showWarningMessage(`Revu: ${message}`);
    } else {
      logWarning(message);
    }
  }
}
