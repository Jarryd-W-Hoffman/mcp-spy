import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import { main } from '../src/cli.js';

/** Thrown in place of process.exit, so a command stops where the real one would. */
export class Exited extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** SIGINT/SIGTERM handlers the command registered (not installed on the test process). */
  signals: Map<string, () => void>;
}

export interface Captured {
  stdout: string;
  stderr: string;
  signals: Map<string, () => void>;
  restore(): void;
}

/**
 * Captures what a command writes and how it exits, without touching the test
 * process: stdout and stderr are recorded, process.exit throws Exited and
 * signal handlers are collected instead of installed.
 */
export function capture(stdin?: PassThrough): Captured {
  const captured: Captured = { stdout: '', stderr: '', signals: new Map(), restore: () => {} };
  const writer = (stream: 'stdout' | 'stderr') =>
    ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      captured[stream] += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
      return true;
    }) as typeof process.stdout.write;
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(writer('stdout')),
    vi.spyOn(process.stderr, 'write').mockImplementation(writer('stderr')),
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Exited(Number(code ?? 0));
    }),
    vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGINT' || event === 'SIGTERM') captured.signals.set(event, listener);
      else process.on(event, listener);
      return process;
    }) as typeof process.once),
  ];
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  if (stdin) Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true });
  captured.restore = () => {
    for (const spy of spies) spy.mockRestore();
    if (stdin) Object.defineProperty(process, 'stdin', original);
  };
  return captured;
}

/** Runs `mcpspy <args>` in this process and reports its output and exit code. */
export async function cli(args: string[], options: { stdin?: string | PassThrough } = {}): Promise<CliRun> {
  const stdin = typeof options.stdin === 'string' ? new PassThrough() : options.stdin;
  if (typeof options.stdin === 'string') stdin!.end(options.stdin);
  const captured = capture(stdin);
  process.exitCode = undefined;
  let code: number;
  try {
    await main(args);
    code = Number(process.exitCode ?? 0);
  } catch (error) {
    if (!(error instanceof Exited)) {
      captured.restore();
      throw error;
    }
    code = error.code;
  } finally {
    process.exitCode = undefined;
  }
  captured.restore();
  return { code, stdout: captured.stdout, stderr: captured.stderr, signals: captured.signals };
}
