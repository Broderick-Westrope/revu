import * as vscode from 'vscode';
import { getCheckpointState } from './checkpoint';
import { ChangedFile, changedFiles } from './git';
import { StackExternal, StackResult, resolveStack } from './stack';

export interface ReviewSnapshot {
  stack: StackResult;
  checkpointMode: boolean;
  base?: string;
  unavailable?: string;
}

export class ReviewState {
  private readonly emitter = new vscode.EventEmitter<void>();
  private external: StackExternal = { prs: [] };
  private checkpointMode = false;
  private current: ReviewSnapshot | undefined;

  readonly onDidChange: vscode.Event<void> = this.emitter.event;

  constructor(
    readonly repoRoot: string,
    private readonly fetchExternal: (repoRoot: string) => Promise<StackExternal>
  ) {}

  get snapshot(): ReviewSnapshot | undefined {
    return this.current;
  }

  setCheckpointMode(on: boolean): void {
    this.checkpointMode = on;
  }

  async refresh(options: { external?: boolean } = {}): Promise<void> {
    if (options.external ?? true) {
      this.external = await this.fetchExternal(this.repoRoot).catch(() => ({ prs: [] }));
    }
    const stack = await resolveStack(this.repoRoot, this.external);
    this.current = { stack, checkpointMode: this.checkpointMode, ...(await this.base(stack)) };
    this.emitter.fire();
  }

  async files(): Promise<ChangedFile[]> {
    const snapshot = this.current;
    const diffBase = snapshot?.stack.current?.diffBase;
    if (!snapshot?.base || !diffBase) {
      return [];
    }
    const all = await changedFiles(this.repoRoot, diffBase, true);
    if (snapshot.base === diffBase) {
      return all;
    }
    const sinceCheckpoint = new Set(
      (await changedFiles(this.repoRoot, snapshot.base, true)).map((file) => file.path)
    );
    return all.filter((file) => sinceCheckpoint.has(file.path));
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private async base(stack: StackResult): Promise<{ base?: string; unavailable?: string }> {
    const current = stack.current;
    if (!current) {
      return {};
    }
    if (!this.checkpointMode) {
      return { base: current.diffBase };
    }
    const state = await getCheckpointState(this.repoRoot, current.diffBase);
    switch (state.kind) {
      case 'explicit':
        return { base: state.sha };
      case 'orphaned':
        return { unavailable: 'The checkpoint is no longer on this branch. Pick a new one in the Checkpoint view.' };
      default:
        return { base: current.diffBase };
    }
  }
}
