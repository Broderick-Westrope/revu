import * as vscode from 'vscode';

export function parseLineRange(
  note: string | undefined
): { start: number; end: number } | undefined {
  if (!note) {
    return undefined;
  }
  const match = /^Lines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/i.exec(note);
  if (!match) {
    return undefined;
  }
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  return { start, end };
}

function findEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
  const target = uri.toString();
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === target);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pointAt(uri: vscode.Uri, range: vscode.Range): Promise<void> {
  let editor = findEditor(uri);
  for (let attempt = 0; !editor && attempt < 5; attempt++) {
    await delay(200);
    editor = findEditor(uri);
  }
  if (!editor) {
    return;
  }
  const decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    isWholeLine: true,
  });
  editor.setDecorations(decoration, [range]);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  setTimeout(() => decoration.dispose(), 2500);
}
