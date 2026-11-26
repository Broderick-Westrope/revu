import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function logWarning(message: string): void {
  channel ??= vscode.window.createOutputChannel('Revu');
  channel.appendLine(`[${new Date().toISOString()}] ${message}`);
}
