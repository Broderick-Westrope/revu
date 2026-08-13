import * as path from 'path';
import * as vscode from 'vscode';
import { getCheckpointState } from '../checkpoint';
import { ChangedFile, changedFiles, nameStatusHash } from '../git';
import { getActiveScope, onDidChangeScope, ReviewScope, scopeIncludesUntracked, scopeKey } from '../scope';
import { GuideCache, onDidChangeGuide } from './cache';
import { GuideFile, GuideGroup } from './model';

interface GroupNode {
  kind: 'group';
  index: number;
  group: GuideGroup;
}

interface FileNode {
  kind: 'file';
  file: GuideFile;
  changed?: ChangedFile;
  repoRoot: string;
}

export type GuideNode = GroupNode | FileNode;

const STALE_MESSAGE =
  '⚠ Guide is stale — changes differ from when it was generated. Regenerate.';

export class GuideTreeProvider implements vscode.TreeDataProvider<GuideNode> {
  private readonly emitter = new vscode.EventEmitter<GuideNode | undefined | void>();

  private changedByPathPromise: Promise<Map<string, ChangedFile>> | undefined;

  readonly onDidChangeTreeData: vscode.Event<GuideNode | undefined | void> = this.emitter.event;

  constructor(private readonly cache: GuideCache) {}

  refresh(): void {
    this.changedByPathPromise = undefined;
    this.emitter.fire();
  }

  async getChildren(element?: GuideNode): Promise<GuideNode[]> {
    const scope = getActiveScope();
    if (!scope) {
      return [];
    }
    if (!element) {
      const cached = this.cache.get(scopeKey(scope));
      if (!cached) {
        return [];
      }
      return cached.guide.groups.map((group, i) => ({ kind: 'group', index: i, group }));
    }
    if (element.kind === 'group') {
      const changedByPath = await this.changedByPath(scope);
      return element.group.files.map((file) => ({
        kind: 'file',
        file,
        changed: changedByPath.get(file.path),
        repoRoot: scope.repoRoot,
      }));
    }
    return [];
  }

  getTreeItem(element: GuideNode): vscode.TreeItem {
    switch (element.kind) {
      case 'group': {
        return new vscode.TreeItem(
          `${element.index + 1}. ${element.group.title}`,
          vscode.TreeItemCollapsibleState.Expanded
        );
      }
      case 'file': {
        const item = new vscode.TreeItem(
          path.basename(element.file.path),
          vscode.TreeItemCollapsibleState.None
        );
        item.resourceUri = vscode.Uri.file(path.join(element.repoRoot, element.file.path));
        item.description = element.file.note ?? element.file.path;
        item.tooltip = element.file.note
          ? `${element.file.path} — ${element.file.note}`
          : element.file.path;
        item.command = element.changed
          ? {
              command: 'revu.openDiff',
              title: 'Open Diff',
              arguments: [element.changed],
            }
          : {
              command: 'vscode.open',
              title: 'Open File',
              arguments: [item.resourceUri],
            };
        return item;
      }
    }
  }

  private changedByPath(scope: ReviewScope): Promise<Map<string, ChangedFile>> {
    if (!this.changedByPathPromise) {
      this.changedByPathPromise = changedFiles(
        scope.repoRoot,
        scope.baseRef,
        scopeIncludesUntracked(scope)
      )
        .then((files) => new Map(files.map((f) => [f.path, f])))
        .catch(() => new Map<string, ChangedFile>());
    }
    return this.changedByPathPromise;
  }
}

export function registerGuideTree(
  context: vscode.ExtensionContext,
  cache: GuideCache
): () => void {
  const provider = new GuideTreeProvider(cache);
  const treeView = vscode.window.createTreeView('revu.guideView', {
    treeDataProvider: provider,
  });

  const updateStaleness = async (): Promise<void> => {
    const scope = getActiveScope();
    if (!scope) {
      treeView.message = undefined;
      return;
    }
    const cached = cache.get(scopeKey(scope));
    if (!cached) {
      treeView.message = undefined;
      return;
    }
    try {
      let baseRef = scope.baseRef;
      let currentBaseSha: string | undefined;
      if (scope.type === 'checkpoint') {
        const state = await getCheckpointState(scope.repoRoot);
        if (state.kind === 'explicit' || state.kind === 'implicit') {
          baseRef = state.sha;
          currentBaseSha = state.sha;
        }
      } else if (scope.type === 'branch') {
        currentBaseSha = scope.baseRef;
      }
      const currentHash = await nameStatusHash(
        scope.repoRoot,
        baseRef,
        scopeIncludesUntracked(scope)
      );
      treeView.message = cache.isStale(cached, currentHash, currentBaseSha)
        ? STALE_MESSAGE
        : undefined;
    } catch {
      treeView.message = undefined;
    }
  };

  let debounceTimer: NodeJS.Timeout | undefined;
  const debouncedStaleness = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void updateStaleness();
    }, 2000);
  };

  const refreshAll = (): void => {
    provider.refresh();
    void updateStaleness();
  };

  context.subscriptions.push(
    treeView,
    onDidChangeGuide(refreshAll),
    onDidChangeScope(refreshAll),
    vscode.workspace.onDidSaveTextDocument(debouncedStaleness),
    new vscode.Disposable(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    })
  );

  void updateStaleness();

  return debouncedStaleness;
}
