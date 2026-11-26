import * as vscode from 'vscode';
import { checkedOutBranch } from '../git';
import { fetchReviewThreads } from '../github/gh';
import { GithubThreadRenderer } from '../github/threadRenderer';
import { logWarning } from '../log';

export async function refreshPrThreads(
  renderer: GithubThreadRenderer,
  repoRoot: string,
  pr: { branch: string; number: number } | undefined,
  options: { announce?: boolean } = {}
): Promise<void> {
  renderer.clear();
  if (!pr) {
    return;
  }
  try {
    const threads = await fetchReviewThreads(repoRoot, pr.number);
    if ((await checkedOutBranch(repoRoot)) !== pr.branch) {
      return;
    }
    const { shown, skipped } = renderer.renderThreads(repoRoot, threads);
    if (options.announce) {
      void vscode.window.showInformationMessage(
        `Revu: PR #${pr.number}: ${shown} threads shown, ${skipped} skipped (outdated).`
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
