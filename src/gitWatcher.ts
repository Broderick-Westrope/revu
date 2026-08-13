import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { gitDir } from './git';

export interface LogsWatcherOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export function startLogsWatcher(
  gitDirPath: string,
  onChange: () => void,
  onFailure: () => void,
  options?: LogsWatcherOptions
): vscode.Disposable {
  const debounceMs = options?.debounceMs ?? 500;
  const pollIntervalMs = options?.pollIntervalMs ?? 5000;
  const maxPollAttempts = options?.maxPollAttempts ?? 24;
  const logsDir = path.join(gitDirPath, 'logs');

  let watcher: fs.FSWatcher | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const fireDebounced = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      onChange();
    }, debounceMs);
  };

  const attach = (): void => {
    if (disposed) {
      return;
    }
    try {
      watcher = fs.watch(logsDir, (_event, filename) => {
        if (!filename || filename === 'HEAD') {
          fireDebounced();
        }
      });
    } catch {
      onFailure();
      return;
    }
    watcher.on('error', () => {
      watcher?.close();
      watcher = undefined;
      if (!disposed) {
        onFailure();
      }
    });
  };

  if (fs.existsSync(logsDir)) {
    attach();
  } else {
    let attempts = 0;
    const poll = (): void => {
      if (disposed) {
        return;
      }
      if (fs.existsSync(logsDir)) {
        attach();
        fireDebounced();
        return;
      }
      attempts += 1;
      if (attempts >= maxPollAttempts) {
        onFailure();
        return;
      }
      pollTimer = setTimeout(poll, pollIntervalMs);
    };
    pollTimer = setTimeout(poll, pollIntervalMs);
  }

  return new vscode.Disposable(() => {
    disposed = true;
    watcher?.close();
    if (pollTimer) {
      clearTimeout(pollTimer);
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
  });
}

export function registerGitWatcher(
  context: vscode.ExtensionContext,
  repoRootPath: string
): vscode.Event<void> {
  const emitter = new vscode.EventEmitter<void>();
  let watcher: vscode.Disposable | undefined;
  let disposed = false;
  let warned = false;
  const warnDegraded = (): void => {
    if (warned) {
      return;
    }
    warned = true;
    void vscode.window.showWarningMessage(
      "Revu: git watcher failed — checkpoint view won't auto-refresh; use the refresh button."
    );
  };
  void gitDir(repoRootPath).then(
    (dir) => {
      if (disposed) {
        return;
      }
      watcher = startLogsWatcher(dir, () => emitter.fire(), warnDegraded);
    },
    () => {
      warnDegraded();
    }
  );
  context.subscriptions.push(
    emitter,
    new vscode.Disposable(() => {
      disposed = true;
      watcher?.dispose();
    })
  );
  return emitter.event;
}
