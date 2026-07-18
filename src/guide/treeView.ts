import * as path from 'path';
import * as vscode from 'vscode';
import { ChangedFile, changedFiles, nameStatusHash } from '../git';
import { getActiveScope, onDidChangeScope, ReviewScope, scopeKey } from '../scope';
import { GuideCache, onDidChangeGuide } from './cache';
import { GuideFile, GuideGroup } from './model';

interface GroupNode {
  kind: 'group';
  index: number;
  group: GuideGroup;
}

interface NoteNode {
  kind: 'note';
  bullet: string;
}

interface FileNode {
  kind: 'file';
  file: GuideFile;
  changed?: ChangedFile;
  repoRoot: string;
}

export type GuideNode = GroupNode | NoteNode | FileNode;

const STALE_MESSAGE =
  '⚠ Guide is stale — changes differ from when it was generated. Regenerate.';

export class GuideTreeProvider implements vscode.TreeDataProvider<GuideNode> {
  private readonly emitter = new vscode.EventEmitter<GuideNode | undefined | void>();

  readonly onDidChangeTreeData: vscode.Event<GuideNode | undefined | void> = this.emitter.event;

  constructor(private readonly cache: GuideCache) {}

  refresh(): void {
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
      const notes: GuideNode[] = element.group.attention.map((bullet) => ({
        kind: 'note',
        bullet,
      }));
      const files: GuideNode[] = element.group.files.map((file) => ({
        kind: 'file',
        file,
        changed: changedByPath.get(file.path),
        repoRoot: scope.repoRoot,
      }));
      return [...notes, ...files];
    }
    return [];
  }

  getTreeItem(element: GuideNode): vscode.TreeItem {
    switch (element.kind) {
      case 'group': {
        const item = new vscode.TreeItem(
          `${element.index + 1}. ${element.group.title}`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.description = element.group.theme;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${element.group.title}**\n\n${element.group.theme}`);
        if (element.group.attention.length > 0) {
          tooltip.appendMarkdown('\n\n**Pay attention to:**\n');
          for (const bullet of element.group.attention) {
            tooltip.appendMarkdown(`\n- ${bullet}`);
          }
        }
        item.tooltip = tooltip;
        return item;
      }
      case 'note': {
        const item = new vscode.TreeItem(
          `⚠ ${element.bullet}`,
          vscode.TreeItemCollapsibleState.None
        );
        item.tooltip = element.bullet;
        return item;
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

  private async changedByPath(scope: ReviewScope): Promise<Map<string, ChangedFile>> {
    try {
      const files = await changedFiles(scope.repoRoot, scope.baseRef, scope.type === 'workingTree');
      return new Map(files.map((f) => [f.path, f]));
    } catch {
      return new Map();
    }
  }
}

export function registerGuideTree(
  context: vscode.ExtensionContext,
  cache: GuideCache
): void {
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
      const currentHash = await nameStatusHash(
        scope.repoRoot,
        scope.baseRef,
        scope.type === 'workingTree'
      );
      treeView.message = cache.isStale(cached, currentHash) ? STALE_MESSAGE : undefined;
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
}
