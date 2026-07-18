import * as vscode from 'vscode';
import { LocalComment } from './model';

const STORE_KEY = 'revu.comments';

export class CommentStore {
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChange: vscode.Event<void> = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  all(): LocalComment[] {
    return this.memento.get<LocalComment[]>(STORE_KEY, []);
  }

  add(comment: LocalComment): void {
    void this.memento.update(STORE_KEY, [...this.all(), comment]);
    this.emitter.fire();
  }

  update(id: string, text: string): void {
    void this.memento.update(
      STORE_KEY,
      this.all().map((c) => (c.id === id ? { ...c, text } : c))
    );
    this.emitter.fire();
  }

  remove(id: string): void {
    void this.memento.update(
      STORE_KEY,
      this.all().filter((c) => c.id !== id)
    );
    this.emitter.fire();
  }

  clear(): void {
    void this.memento.update(STORE_KEY, []);
    this.emitter.fire();
  }
}
