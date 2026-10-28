import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { LineSplitter } from '../framing.js';
import { Recorder } from '../recorder.js';
import type { Store } from '../store.js';

export interface StdioProxyOptions {
  command: string;
  args: string[];
  store: Store;
  name?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** The agent side of the pipe. Defaults to this process's stdio. */
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  /** Signals forwarded to the server. Empty in tests. */
  forwardSignals?: NodeJS.Signals[];
}

export interface StdioProxyResult {
  sessionId: number;
  exitCode: number;
}

/**
 * Sits between an MCP client and a stdio MCP server. Bytes are forwarded
 * untouched as soon as they arrive; a copy of each chunk is framed and
 * recorded on the side, so a recording failure never breaks the session.
 */
export function runStdioProxy(options: StdioProxyOptions): Promise<StdioProxyResult> {
  const {
    command,
    args,
    store,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    forwardSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'],
  } = options;
  const cwd = options.cwd ?? process.cwd();

  const sessionId = store.createSession({
    name: options.name ?? null,
    transport: 'stdio',
    command: JSON.stringify([command, ...args]),
    cwd,
    pid: null,
    started_at: Date.now(),
    // Names only: replay uses them to point out variables that are missing.
    env_keys: JSON.stringify(Object.keys(options.env ?? process.env).sort()),
  });
  const recorder = new Recorder(store, sessionId);

  let recordingBroken = false;
  const record = (fn: () => void): void => {
    if (recordingBroken) return;
    try {
      fn();
    } catch (error) {
      recordingBroken = true;
      errorOutput.write(`[mcpspy] recording stopped, still proxying: ${(error as Error).message}\n`);
    }
  };

  const fromClient = new LineSplitter((line) => record(() => recorder.frame('client', line)));
  const fromServer = new LineSplitter((line) => record(() => recorder.frame('server', line)));
  const fromStderr = new LineSplitter((line) => record(() => recorder.stderr(line)));

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      for (const signalName of forwardSignals) process.off(signalName, forward);
      input.off('data', onInput);
      input.off('end', onInputEnd);

      fromClient.flush();
      fromServer.flush();
      fromStderr.flush();
      record(() => store.endSession(sessionId, { ended_at: Date.now(), exit_code: signal ? null : exitCode, exit_signal: signal }));
      resolve({ sessionId, exitCode });
    };

    const onInput = (chunk: Buffer): void => {
      if (child.stdin.writable) child.stdin.write(chunk);
      fromClient.push(chunk);
    };
    const onInputEnd = (): void => {
      child.stdin.end();
    };
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };

    if (child.pid !== undefined) record(() => store.setSessionPid(sessionId, child.pid!));

    input.on('data', onInput);
    input.on('end', onInputEnd);
    for (const signalName of forwardSignals) process.on(signalName, forward);

    // The server may exit before reading everything we wrote; that is not our error.
    child.stdin.on('error', () => {});

    child.stdout.on('data', (chunk: Buffer) => {
      output.write(chunk);
      fromServer.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorOutput.write(chunk);
      fromStderr.push(chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      errorOutput.write(`[mcpspy] failed to start ${command}: ${error.message}\n`);
      finish(error.code === 'ENOENT' ? 127 : 126, null);
    });

    // "close" waits for the server's stdio to drain, unlike "exit".
    child.on('close', (code, signal) => {
      finish(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0), signal);
    });
  });
}
