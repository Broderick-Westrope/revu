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
    return this.memento.get<LocalComment[]>(this.key(), []);
  }

  async add(comment: LocalComment): Promise<void> {
    await this.memento.update(this.key(), [...this.all(), comment]);
    this.emitter.fire();
  }

  async update(id: string, text: string): Promise<void> {
    await this.memento.update(
      this.key(),
      this.all().map((c) => (c.id === id ? { ...c, text } : c))
    );
    this.emitter.fire();
  }

  async remove(id: string): Promise<void> {
    await this.memento.update(
      this.key(),
      this.all().filter((c) => c.id !== id)
    );
    this.emitter.fire();
  }

  async clear(): Promise<void> {
    await this.memento.update(this.key(), []);
    this.emitter.fire();
  }

  private key(): string {
    return `${BRANCH_KEY_PREFIX}${this.branch}`;
  }
}
