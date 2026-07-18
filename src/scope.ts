import * as vscode from 'vscode';
import { PrMetadata } from './github/model';

export type ScopeType = 'workingTree' | 'branch';

export interface ReviewScope {
  type: ScopeType;
  baseRef: string;
  repoRoot: string;
}

let activeScope: ReviewScope | undefined;

const scopeEmitter = new vscode.EventEmitter<ReviewScope | undefined>();

export const onDidChangeScope: vscode.Event<ReviewScope | undefined> = scopeEmitter.event;

export function scopeDisposables(): vscode.Disposable[] {
  return [scopeEmitter];
}

export function getActiveScope(): ReviewScope | undefined {
  return activeScope;
}

export function setActiveScope(scope: ReviewScope): void {
  activeScope = scope;
  scopeEmitter.fire(activeScope);
}

export function clearActiveScope(): void {
  activeScope = undefined;
  scopeEmitter.fire(undefined);
}

export function scopeKey(scope: ReviewScope): string {
  return scope.type === 'workingTree' ? 'workingTree' : `branch:${scope.baseRef}`;
}

let prContext: PrMetadata | undefined;

export function setPrContext(meta: PrMetadata | undefined): void {
  prContext = meta;
}

export function getPrContext(): PrMetadata | undefined {
  return prContext;
}
