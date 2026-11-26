import * as vscode from 'vscode';
import { LocalComment } from './model';

const BRANCH_KEY_PREFIX = 'revu.comments.branch:';

export class CommentStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  private branch: string | undefined;

  readonly onDidChange: vscode.Event<void> = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  async setBranch(branch: string | undefined): Promise<void> {
    this.branch = branch;
  }

  all(): LocalComment[] {
    const key = this.key();
    return key ? this.memento.get<LocalComment[]>(key, []) : [];
  }

  async add(comment: LocalComment): Promise<void> {
    const key = this.key();
    if (!key) {
      throw new Error('Revu: local comments need a checked-out branch.');
    }
    await this.memento.update(key, [...this.all(), comment]);
    this.emitter.fire();
  }

  async update(id: string, text: string): Promise<void> {
    await this.write(this.all().map((c) => (c.id === id ? { ...c, text } : c)));
  }

  async remove(id: string): Promise<void> {
    await this.write(this.all().filter((c) => c.id !== id));
  }

  async clear(): Promise<void> {
    await this.write([]);
  }

  private async write(comments: LocalComment[]): Promise<void> {
    const key = this.key();
    if (!key) {
      return;
    }
    await this.memento.update(key, comments);
    this.emitter.fire();
  }

  private key(): string | undefined {
    return this.branch === undefined ? undefined : `${BRANCH_KEY_PREFIX}${this.branch}`;
  }
}
