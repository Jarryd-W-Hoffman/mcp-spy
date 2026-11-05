import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { AUDIT_STOPPED, AuditTrail } from '../audit.js';
import { LineSplitter } from '../framing.js';
import { Recorder } from '../recorder.js';
import { Redactor } from '../redact.js';
import type { MockEngine } from '../mocks.js';
import type { PolicyEngine } from '../policy.js';
import { Store } from '../store.js';
import { Interceptor, POLICY_ERROR } from './interceptor.js';

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
  /** Keep an audit trail of this session, as a policy always does. */
  audit?: boolean;
  /** Stop the session rather than let unrecorded traffic through. Implies audit. */
  requireAudit?: boolean;
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
 * With requireAudit it's the reverse: each line is recorded before it's
 * forwarded, and a recording failure ends the session.
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
  const required = options.requireAudit === true;

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
    if (required) {
      errorOutput.write(`[mcpspy] not starting ${command}: ${AUDIT_STOPPED} (${(error as Error).message})\n`);
      return Promise.resolve({ sessionId: -1, exitCode: 1 });
    }
    errorOutput.write(`[mcpspy] not recording this session: ${(error as Error).message}\n`);
    store = new Store(':memory:');
    sessionId = store.createSession(session);
  }
  const audit = options.audit || options.policy || required ? new AuditTrail(store, sessionId, session.name) : null;
  const recorder = new Recorder(store, sessionId, undefined, redactor, audit);

  let recordingBroken = false;
  /** Ends the server once it's running; until then, not starting it is enough. */
  let stopServer = (): void => {};
  const record = (fn: () => void): void => {
    if (recordingBroken) return;
    try {
      fn();
    } catch (error) {
      recordingBroken = true;
      errorOutput.write(
        required ? `[mcpspy] stopping the session: ${AUDIT_STOPPED} (${(error as Error).message})\n` : `[mcpspy] recording stopped, still proxying: ${(error as Error).message}\n`,
      );
      if (required) stopServer();
    }
  };
  /** Whether traffic must stop: everything from here on would go unrecorded. */
  const stopped = (): boolean => required && recordingBroken;
  record(() => audit?.started({ transport: session.transport, command: session.command, cwd, policy: options.policy?.identity() ?? null }));
  if (stopped()) return Promise.resolve({ sessionId, exitCode: 1 });

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    stopServer = () => child.kill('SIGTERM');
    const toClient = (line: string) => output.write(`${line}\n`);
    /** Tells the agent why it won't get what it's waiting for, when the message is waiting on an answer. */
    const refuse = (line: string, answers: (message: { id?: unknown; method?: unknown }) => boolean) => {
      const message = parseMessage(line);
      if (message?.id !== undefined && answers(message)) toClient(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: POLICY_ERROR, message: `mcpspy stopped this session: ${AUDIT_STOPPED}` } }));
    };
    const toServer = (line: string) => {
      if (stopped()) return refuse(line, (message) => message.method !== undefined);
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    };
    const interceptor =
      options.mocks || options.policy || required
        ? new Interceptor({
            mocks: options.mocks ?? null,
            policy: options.policy ?? null,
            onVerdict: (method, params, verdict) => record(() => audit?.verdict(method, params, verdict, options.policy!.identity().sha256)),
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
      const { line: forwarded, rule, answers } = interceptor.fromServer(line);
      // What the server sent is recorded even when the policy kept it from the agent,
      // and before the proxy's answers to it, so they pair with what they answer.
      record(() => recorder.frame('server', forwarded ?? line, rule));
      if (forwarded !== null) {
        if (stopped()) refuse(forwarded, (message) => message.method === undefined);
        else toClient(forwarded);
      }
      for (const answer of answers) {
        toServer(answer);
        record(() => recorder.frame('client', answer, rule));
      }
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
      const end = { exit_code: signal ? null : exitCode, exit_signal: signal };
      record(() => store.endSession(sessionId, { ended_at: Date.now(), ...end }));
      record(() => audit?.ended(end));
      resolve({ sessionId, exitCode: stopped() ? 1 : exitCode });
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

/** A line as a single JSON-RPC message, or null when it's something else. */
function parseMessage(line: string): { id?: unknown; method?: unknown } | null {
  try {
    return JSON.parse(line) as { id?: unknown; method?: unknown } | null;
  } catch {
    return null;
  }
}
