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

  readPaths(scopeKey: string): string[] {
    return this.memento.get<string[]>(READ_PREFIX + scopeKey, []);
  }

  isRead(scopeKey: string, filePath: string): boolean {
    return this.readPaths(scopeKey).includes(filePath);
  }

  async setRead(scopeKey: string, filePath: string, read: boolean): Promise<void> {
    const current = this.readPaths(scopeKey);
    const next = read
      ? current.includes(filePath)
        ? current
        : [...current, filePath]
      : current.filter((p) => p !== filePath);
    await this.memento.update(READ_PREFIX + scopeKey, next.length > 0 ? next : undefined);
  }

  isStale(cached: CachedGuide, currentHash: string): boolean {
    return cached.hash !== currentHash;
  }
}
