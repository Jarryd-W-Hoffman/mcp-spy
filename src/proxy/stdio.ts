import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { LineSplitter } from '../framing.js';
import { Recorder } from '../recorder.js';
import { Redactor } from '../redact.js';
import type { MockEngine } from '../mocks.js';
import type { PolicyEngine } from '../policy.js';
import { Store } from '../store.js';
import { Interceptor } from './interceptor.js';

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
  /** Mock rules; when set, traffic is handled line by line so requests can be intercepted. */
  mocks?: MockEngine;
  /** A policy the agent's requests must pass; traffic is handled line by line, as with mocks. */
  policy?: PolicyEngine;
  /** How long a policy's ask waits for the agent's user; two minutes by default. */
  askTimeoutMs?: number;
  /** What to remove from the record; built-in secret patterns by default. */
  redactor?: Redactor;
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
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    forwardSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'],
  } = options;
  const cwd = options.cwd ?? process.cwd();

  const redactor = options.redactor ?? new Redactor();
  const session = {
    name: options.name ?? null,
    transport: 'stdio',
    command: JSON.stringify(redactor.args([command, ...args])),
    cwd,
    pid: null,
    started_at: Date.now(),
    // Names only: replay uses them to point out variables that are missing.
    env_keys: JSON.stringify(Object.keys(options.env ?? process.env).sort()),
  };
  // The agent started us to reach its server: if the log can't take this session,
  // record into memory (and so nowhere) rather than leave the agent without it.
  let store = options.store;
  let sessionId: number;
  try {
    sessionId = store.createSession(session);
  } catch (error) {
    errorOutput.write(`[mcpspy] not recording this session: ${(error as Error).message}\n`);
    store = new Store(':memory:');
    sessionId = store.createSession(session);
  }
  const recorder = new Recorder(store, sessionId, undefined, redactor);

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


  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const toServer = (line: string) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    };
    const toClient = (line: string) => output.write(`${line}\n`);
    const interceptor =
      options.mocks || options.policy
        ? new Interceptor({
            mocks: options.mocks ?? null,
            policy: options.policy ?? null,
            toServer,
            toClient,
            recordReply: (line, rule) => record(() => recorder.frame('server', line, rule)),
            warn: (message) => errorOutput.write(`[mcpspy] ${message}\n`),
            askTimeoutMs: options.askTimeoutMs,
          })
        : null;

    const fromClient = new LineSplitter((line) => {
      record(() => recorder.frame('client', line));
      interceptor?.fromClient(line);
    });
    const fromServer = new LineSplitter((line) => {
      if (!interceptor) {
        record(() => recorder.frame('server', line));
        return;
      }
      const { line: forwarded, rule } = interceptor.fromServer(line);
      toClient(forwarded);
      record(() => recorder.frame('server', forwarded, rule));
    });
    const fromStderr = new LineSplitter((line) => record(() => recorder.stderr(line)));

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
      // Without mocks, bytes go straight through; with them, whole lines are forwarded by the interceptor.
      if (!interceptor && child.stdin.writable) child.stdin.write(chunk);
      fromClient.push(chunk);
    };
    const onInputEnd = (): void => {
      if (!interceptor) return void child.stdin.end();
      fromClient.flush();
      interceptor.inputEnded();
      // Requests a rule is still delaying go to the server before its input ends.
      interceptor.whenIdle(() => child.stdin.end());
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
      if (!interceptor) output.write(chunk);
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

    // "close" waits for the server's stdio to drain, unlike "exit". Node gives
    // either an exit code or the signal that ended the process.
    child.on('close', (code, signal) => {
      finish(code ?? 128 + constants.signals[signal!], signal);
    });
  });
}
