import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;
const logged = new Set<string>();

export function logWarning(message: string): void {
  channel ??= vscode.window.createOutputChannel('Revu');
  channel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logWarningOnce(message: string): void {
  if (!logged.has(message)) {
    logged.add(message);
    logWarning(message);
  }
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
