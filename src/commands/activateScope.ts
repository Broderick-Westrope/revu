import * as vscode from 'vscode';
import { fetchPrMetadata, fetchReviewThreads, isGhAvailable, resetGhAvailability } from '../github/gh';
import { GithubThreadRenderer } from '../github/threadRenderer';
import { ReviewScope, getActiveScope, setActiveScope, setPrContext } from '../scope';

export async function refreshPrThreads(renderer: GithubThreadRenderer): Promise<void> {
  const scope = getActiveScope();
  if (!scope) {
    return;
  }
  resetGhAvailability();
  try {
    if (!(await isGhAvailable(scope.repoRoot))) {
      return;
    }
    const meta = await fetchPrMetadata(scope.repoRoot);
    if (!meta) {
      setPrContext(undefined);
      renderer.clear();
      return;
    }
    setPrContext(meta);
    const threads = await fetchReviewThreads(scope.repoRoot, meta.number);
    const { shown, skipped } = renderer.renderThreads(scope.repoRoot, threads);
    void vscode.window.showInformationMessage(
      `Revu: PR #${meta.number}: ${shown} threads shown, ${skipped} skipped (outdated).`
    );
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Revu: could not load GitHub PR data: ${(err as Error).message}`
    );
  }
}

export async function activateScope(
  scope: ReviewScope,
  renderer: GithubThreadRenderer
): Promise<void> {
  setActiveScope(scope);
  await vscode.commands.executeCommand('setContext', 'revu.reviewActive', true);
  void refreshPrThreads(renderer);
}
