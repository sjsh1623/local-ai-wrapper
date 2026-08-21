import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called per stdout line, for streaming consumers. */
  onLine?: (line: string) => void;
  input?: string;
}

export class CommandFailed extends Error {
  constructor(
    readonly command: string,
    readonly result: RunResult,
  ) {
    super(
      `${command} exited with ${result.code}` +
        (result.timedOut ? ' (timed out)' : '') +
        (result.stderr ? `: ${result.stderr.trim().slice(-400)}` : ''),
    );
    this.name = 'CommandFailed';
  }
}

export function run(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const opts: SpawnOptions = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, opts);
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;

    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (options.onLine) {
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) options.onLine(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (pending.trim() && options.onLine) options.onLine(pending);
      resolve(result);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut }));
  });
}

/** Same as `run`, but a non-zero exit throws. */
export async function runOrThrow(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(file, args, options);
  if (result.code !== 0) throw new CommandFailed(`${file} ${args.join(' ')}`, result);
  return result;
}

/** Operator-supplied verify commands go through a shell on purpose. */
export function runShell(command: string, options: RunOptions = {}): Promise<RunResult> {
  return run('/bin/sh', ['-c', command], options);
}
