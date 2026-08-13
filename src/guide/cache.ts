import * as vscode from 'vscode';
import { CachedGuide } from './model';

const KEY_PREFIX = 'revu.guide.';
const READ_PREFIX = 'revu.guideRead.';

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
    await this.memento.update(READ_PREFIX + cached.scopeKey, undefined);
  }

  readMarks(scopeKey: string): string[] {
    return this.memento.get<string[]>(READ_PREFIX + scopeKey, []);
  }

  isRead(scopeKey: string, id: string): boolean {
    return this.readMarks(scopeKey).includes(id);
  }

  async setRead(scopeKey: string, id: string, read: boolean): Promise<void> {
    const current = this.readMarks(scopeKey);
    const next = read
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((p) => p !== id);
    await this.memento.update(READ_PREFIX + scopeKey, next.length > 0 ? next : undefined);
  }

  isStale(cached: CachedGuide, currentHash: string, currentBaseSha?: string): boolean {
    if (cached.hash !== currentHash) {
      return true;
    }
    return (
      cached.baseSha !== undefined &&
      currentBaseSha !== undefined &&
      cached.baseSha !== currentBaseSha
    );
  }
}
