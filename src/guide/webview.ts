import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { showDiff } from '../commands/openDiff';
import { changedFiles } from '../git';
import { getActiveScope, onDidChangeScope, scopeKey } from '../scope';
import { GuideCache, onDidChangeGuide } from './cache';
import { Guide } from './model';
import { parseLineRange, pointAt } from './pointAt';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInline(text: string): string {
  return escapeHtml(text).replace(/`([^`]+?)`/g, '<code>$1</code>');
}

const STYLE = `
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    padding: 0 20px 40px;
    max-width: 900px;
    line-height: 1.5;
  }
  h1 {
    font-size: 1.4em;
    border-bottom: 1px solid var(--vscode-editorWidget-border);
    padding-bottom: 8px;
  }
  h2 {
    font-size: 1.15em;
    margin-top: 28px;
    margin-bottom: 4px;
  }
  .summary {
    font-size: 1.05em;
  }
  .theme {
    margin-top: 4px;
    opacity: 0.9;
  }
  ul.attention {
    margin: 8px 0;
    padding-left: 20px;
  }
  ul.files {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 4px;
  }
  li.file {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-editorWidget-border);
  }
  li.file:last-child {
    border-bottom: none;
  }
  li.file:hover {
    background-color: var(--vscode-list-hoverBackground);
  }
  li.file .path {
    color: var(--vscode-textLink-foreground);
    white-space: nowrap;
  }
  li.file .note {
    opacity: 0.75;
    font-size: 0.9em;
  }
  li.file .check {
    margin-left: auto;
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--vscode-foreground);
    padding: 0 5px;
    cursor: pointer;
    opacity: 0.6;
  }
  li.file .check:hover {
    border-color: var(--vscode-editorWidget-border);
    background: none;
    opacity: 1;
  }
  li.file.visited {
    opacity: 0.6;
  }
  code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.9em;
  }
  .empty {
    margin-top: 40px;
    text-align: center;
  }
  button {
    font-family: var(--vscode-font-family);
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: none;
    border-radius: 2px;
    padding: 6px 14px;
    cursor: pointer;
  }
  button:hover {
    background-color: var(--vscode-button-hoverBackground);
  }
`;

function page(nonce: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLE}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

export function renderGuideHtml(
  guide: Guide,
  nonce: string,
  readPaths: ReadonlySet<string> = new Set()
): string {
  const sections = guide.groups
    .map((group, i) => {
      const attention =
        group.attention.length > 0
          ? `<ul class="attention">${group.attention
              .map((bullet) => `<li>${renderInline(bullet)}</li>`)
              .join('')}</ul>`
          : '';
      const files = group.files
        .map((file) => {
          const note = file.note ? `<span class="note">${renderInline(file.note)}</span>` : '';
          const read = readPaths.has(file.path);
          return `<li class="file${read ? ' visited' : ''}" data-path="${escapeHtml(
            file.path
          )}"><span class="path">${escapeHtml(file.path)}</span>${note}<button class="check" title="Toggle read">${
            read ? '✓' : '○'
          }</button></li>`;
        })
        .join('');
      return `<section>
<h2>${i + 1}. ${renderInline(group.title)}</h2>
<p class="theme">${renderInline(group.theme)}</p>
${attention}
<ul class="files">${files}</ul>
</section>`;
    })
    .join('\n');

  const body = `<h1>Review Guide</h1>
<p class="summary">${renderInline(guide.summary)}</p>
${sections}`;

  const script = `
const vscode = acquireVsCodeApi();
for (const row of document.querySelectorAll('li.file')) {
  row.addEventListener('click', () => {
    vscode.postMessage({ type: 'openFile', path: row.dataset.path });
  });
  row.querySelector('.check').addEventListener('click', (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: 'toggleRead', path: row.dataset.path });
  });
}
`;
  return page(nonce, body, script);
}

function renderEmptyHtml(nonce: string): string {
  const body = `<div class="empty">
<p>No review guide for the current scope.</p>
<button id="generate">Generate</button>
</div>`;
  const script = `
const vscode = acquireVsCodeApi();
document.getElementById('generate').addEventListener('click', () => {
  vscode.postMessage({ type: 'generate' });
});
`;
  return page(nonce, body, script);
}

function makeNonce(): string {
  return randomBytes(16).toString('base64');
}

interface WebviewMessage {
  type: string;
  path?: string;
}

async function handleMessage(
  message: WebviewMessage,
  cache: GuideCache,
  rerender: () => void
): Promise<void> {
  if (message.type === 'generate') {
    await vscode.commands.executeCommand('revu.generateGuide');
    return;
  }
  if (typeof message.path !== 'string') {
    return;
  }
  const scope = getActiveScope();
  if (!scope) {
    return;
  }
  if (message.type === 'toggleRead') {
    const key = scopeKey(scope);
    await cache.setRead(key, message.path, !cache.isRead(key, message.path));
    rerender();
    return;
  }
  if (message.type !== 'openFile') {
    return;
  }
  if (vscode.workspace.getConfiguration('revu').get<boolean>('autoMarkRead', false)) {
    await cache.setRead(scopeKey(scope), message.path, true);
    rerender();
  }
  const cached = cache.get(scopeKey(scope));
  const note = cached?.guide.groups
    .flatMap((group) => group.files)
    .find((file) => file.path === message.path)?.note;
  const lines = parseLineRange(note);
  const range = lines
    ? new vscode.Range(lines.start - 1, 0, lines.end - 1, 0)
    : undefined;
  const options: vscode.TextDocumentShowOptions = {
    viewColumn: vscode.ViewColumn.Two,
    preview: true,
    ...(range ? { selection: range } : {}),
  };
  const files = await changedFiles(
    scope.repoRoot,
    scope.baseRef,
    scope.type === 'workingTree'
  ).catch(() => []);
  const changed = files.find((f) => f.path === message.path);
  const uri = vscode.Uri.file(path.join(scope.repoRoot, message.path));
  if (changed) {
    await showDiff(changed, scope, options);
  } else {
    await vscode.window.showTextDocument(uri, options);
  }
  if (range) {
    void pointAt(uri, range);
  }
}

export function registerGuideWebview(
  context: vscode.ExtensionContext,
  cache: GuideCache
): void {
  let panel: vscode.WebviewPanel | undefined;
  let panelDisposables: vscode.Disposable[] = [];

  const render = (): void => {
    if (!panel) {
      return;
    }
    const scope = getActiveScope();
    const cached = scope ? cache.get(scopeKey(scope)) : undefined;
    panel.webview.html =
      scope && cached
        ? renderGuideHtml(cached.guide, makeNonce(), new Set(cache.readPaths(scopeKey(scope))))
        : renderEmptyHtml(makeNonce());
  };

  const open = (): void => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return;
    }
    panel = vscode.window.createWebviewPanel(
      'revu.guide',
      'Review Guide',
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [] }
    );
    panelDisposables.push(
      panel.webview.onDidReceiveMessage(
        (message: WebviewMessage) => void handleMessage(message, cache, render)
      )
    );
    panel.onDidDispose(() => {
      panel = undefined;
      for (const d of panelDisposables) {
        d.dispose();
      }
      panelDisposables = [];
    });
    render();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('revu.openGuide', open),
    onDidChangeGuide(render),
    onDidChangeScope(render),
    new vscode.Disposable(() => {
      panel?.dispose();
    })
  );
}
