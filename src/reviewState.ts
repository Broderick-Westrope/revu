import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCheckpointState } from './checkpoint';
import { ChangedFile, changedFiles, checkedOutBranch, git } from './git';
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
  private lastFingerprint: string | undefined;
  private lastError: string | undefined;
  private generation = 0;
  private lastBranch: string | undefined;
  private externalFetch: Promise<StackExternal> | undefined;

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
    await this.resolve();
    if (options.external ?? true) {
      this.externalFetch ??= this.fetchExternal(this.repoRoot)
        .catch((): StackExternal => ({ prs: [], prsFailed: true }))
        .finally(() => {
          this.externalFetch = undefined;
        });
      const next = await this.externalFetch;
      this.external = next.prsFailed ? { ...next, prs: this.external.prs } : next;
      await this.resolve();
    }
  }

  private async resolve(): Promise<void> {
    const generation = ++this.generation;
    let next: ReviewSnapshot | undefined;
    let error: string | undefined;
    let fingerprint: string | undefined;
    let branch: string | undefined;
    try {
      branch = await checkedOutBranch(this.repoRoot);
      fingerprint = await this.fingerprint();
      const stack = await resolveStack(this.repoRoot, this.external);
      next = { stack, checkpointMode: this.checkpointMode, ...(await this.base(stack)) };
    } catch (err) {
      error = (err as Error).message;
    }
    if (generation !== this.generation) {
      return;
    }
    this.lastFingerprint = fingerprint;
    this.lastBranch = branch;
    this.current = next;
    this.lastError = error;
    this.emitter.fire();
  }

  get branch(): string | undefined {
    return this.lastBranch;
  }

  get error(): string | undefined {
    return this.lastError;
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

  async refreshIfChanged(): Promise<boolean> {
    if ((await this.fingerprint()) === this.lastFingerprint) {
      return false;
    }
    await this.refresh({ external: false });
    return true;
  }

  private async fingerprint(): Promise<string> {
    const [head, refs, status, configPath] = await Promise.all([
      git(this.repoRoot, ['rev-parse', '--symbolic-full-name', 'HEAD', 'HEAD']).catch(() => ''),
      git(this.repoRoot, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
        'refs/remotes/origin',
        'refs/revu',
      ]),
      git(this.repoRoot, ['status', '--porcelain=v1', '-z']),
      git(this.repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    let config = '';
    try {
      config = fs.readFileSync(path.join(configPath.trim(), 'config'), 'utf8');
    } catch {
      config = '';
    }
    return `${head}\n${refs}\n${status}\n${config}`;
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
