import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('revu.startReview', () => {
      void vscode.window.showInformationMessage('Revu: startReview not implemented yet');
    }),
    vscode.commands.registerCommand('revu.endReview', () => {
      void vscode.window.showInformationMessage('Revu: endReview not implemented yet');
    }),
    vscode.commands.registerCommand('revu.openDiff', () => {
      void vscode.window.showInformationMessage('Revu: openDiff not implemented yet');
    })
  );
}

export function deactivate(): void {}
