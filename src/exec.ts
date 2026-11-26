import { execFile } from 'child_process';

export interface RunOptions {
  cwd: string;
  okCodes?: number[];
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export function run(command: string, args: string[], options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeout ?? 0,
        env: options.env,
      },
      (err, stdout, stderr) => {
        if (err && !(options.okCodes ?? []).includes((err as { code?: number }).code ?? -1)) {
          reject(Object.assign(err, { stderr }));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}
