import * as vscode from 'vscode';
import { fetchPrMetadata, fetchReviewThreads, isGhAvailable, resetGhAvailability } from '../github/gh';
import { GithubThreadRenderer } from '../github/threadRenderer';

export async function refreshPrThreads(
  renderer: GithubThreadRenderer,
  repoRoot: string,
  options: { announce?: boolean } = {}
): Promise<void> {
  resetGhAvailability();
  try {
    if (!(await isGhAvailable(repoRoot))) {
      renderer.clear();
      return;
    }
    const meta = await fetchPrMetadata(repoRoot);
    if (!meta) {
      renderer.clear();
      return;
    }
    const threads = await fetchReviewThreads(repoRoot, meta.number);
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
