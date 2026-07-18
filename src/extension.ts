import * as vscode from 'vscode';
import { startReview, endReview } from './commands/startReview';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('revu.startReview', startReview),
    vscode.commands.registerCommand('revu.endReview', endReview),
    vscode.commands.registerCommand('revu.openDiff', () => {
      void vscode.window.showInformationMessage('Revu: openDiff not implemented yet');
    })
  );
}

export function deactivate(): void {}
