import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { getActiveScope } from '../scope';

export class AgentError extends Error {
  constructor(message: string, readonly rawOutput: string) {
    super(message);
  }
}

export async function runAgent(prompt: string, token: vscode.CancellationToken): Promise<string> {
  const config = vscode.workspace.getConfiguration('revu');
  const command = config.get<string>('agentCommand', 'claude -p').trim();
  const timeoutSeconds = config.get<number>('agentTimeoutSeconds', 120);
  if (!command) {
    throw new Error('revu.agentCommand is not configured');
  }
  const [cmd, ...args] = command.split(/\s+/);
  const cwd = getActiveScope()?.repoRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancelSub.dispose();
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Agent timed out after ${timeoutSeconds}s`)));
    }, timeoutSeconds * 1000);

    const cancelSub = token.onCancellationRequested(() => {
      child.kill();
      finish(() => reject(new Error('Guide generation cancelled')));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      finish(() => reject(new Error(`Failed to run agent "${cmd}": ${err.message}`)));
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish(() => resolve(stdout));
      } else {
        const excerpt = stderr.trim().slice(0, 500);
        finish(() =>
          reject(
            new AgentError(
              `Agent exited with code ${code}${excerpt ? `: ${excerpt}` : ''}`,
              stdout
            )
          )
        );
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
