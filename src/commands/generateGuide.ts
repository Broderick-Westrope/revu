import * as vscode from 'vscode';
import { changedFiles, diffText, nameStatusHash } from '../git';
import { getActiveScope, getPrContext, scopeKey } from '../scope';
import { runAgent, AgentError } from '../guide/agent';
import { fireGuideChanged, GuideCache } from '../guide/cache';
import { parseGuide } from '../guide/model';
import { buildPrompt } from '../guide/prompt';

export async function generateGuide(cache: GuideCache): Promise<void> {
  const scope = getActiveScope();
  if (!scope) {
    const action = await vscode.window.showInformationMessage(
      'Revu: no active review. Start one to generate a guide.',
      'Start Review'
    );
    if (action === 'Start Review') {
      await vscode.commands.executeCommand('revu.startReview');
    }
    return;
  }

  const includeUntracked = scope.type === 'workingTree';
  const files = await changedFiles(scope.repoRoot, scope.baseRef, includeUntracked);
  if (files.length === 0) {
    void vscode.window.showInformationMessage('Revu: no changed files in the current scope.');
    return;
  }
  const diff = await diffText(scope.repoRoot, scope.baseRef);
  const pr = getPrContext();
  const prContext = pr ? `PR #${pr.number}: ${pr.title}\n\n${pr.body}` : undefined;
  const prompt = buildPrompt(files, diff, prContext);

  let raw: string | undefined;
  try {
    raw = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Revu: generating review guide…',
        cancellable: true,
      },
      (_progress, token) => runAgent(prompt, token)
    );
    const guide = parseGuide(raw);
    const hash = await nameStatusHash(scope.repoRoot, scope.baseRef, includeUntracked);
    await cache.put({
      guide,
      scopeKey: scopeKey(scope),
      hash,
      generatedAt: new Date().toISOString(),
    });
    fireGuideChanged();
  } catch (err) {
    const message = `Revu: guide generation failed: ${(err as Error).message}`;
    const output = err instanceof AgentError ? err.rawOutput : raw;
    if (output !== undefined) {
      const action = await vscode.window.showErrorMessage(message, 'Show raw output');
      if (action === 'Show raw output') {
        const doc = await vscode.workspace.openTextDocument({ content: output });
        await vscode.window.showTextDocument(doc);
      }
    } else {
      void vscode.window.showErrorMessage(message);
    }
  }
}
