import * as vscode from 'vscode';
import { PrMetadata } from './github/model';

export type ScopeType = 'workingTree' | 'branch' | 'checkpoint';

export interface ReviewScope {
  type: ScopeType;
  baseRef: string;
  repoRoot: string;
  branch?: string;
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
  switch (scope.type) {
    case 'workingTree':
      return 'workingTree';
    case 'checkpoint':
      return `checkpoint:${scope.branch}`;
    case 'branch':
      return `branch:${scope.baseRef}`;
  }
}

export function scopeIncludesUntracked(scope: ReviewScope): boolean {
  return scope.type === 'workingTree' || scope.type === 'checkpoint';
}

let prContext: PrMetadata | undefined;

export function setPrContext(meta: PrMetadata | undefined): void {
  prContext = meta;
}

export function getPrContext(): PrMetadata | undefined {
  return prContext;
}
