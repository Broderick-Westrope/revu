import * as vscode from 'vscode';
import { CachedGuide } from './model';

const KEY_PREFIX = 'revu.guide.';

const guideEmitter = new vscode.EventEmitter<void>();

export const onDidChangeGuide: vscode.Event<void> = guideEmitter.event;

export function guideDisposables(): vscode.Disposable[] {
  return [guideEmitter];
}

export function fireGuideChanged(): void {
  guideEmitter.fire();
}

export class GuideCache {
  constructor(private readonly memento: vscode.Memento) {}

  get(scopeKey: string): CachedGuide | undefined {
    return this.memento.get<CachedGuide>(KEY_PREFIX + scopeKey);
  }

  async put(cached: CachedGuide): Promise<void> {
    await this.memento.update(KEY_PREFIX + cached.scopeKey, cached);
  }

  isStale(cached: CachedGuide, currentHash: string): boolean {
    return cached.hash !== currentHash;
  }
}
