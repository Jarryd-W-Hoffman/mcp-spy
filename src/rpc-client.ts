import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LineSplitter } from './framing.js';
import type { Recorder } from './recorder.js';

export type JsonRpcReply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

export interface RpcClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Records both directions, as the proxy would. */
  recorder?: Recorder;
  /** Answers requests the server sends (roots/list, sampling, …). Defaults to "method not found". */
  onServerRequest?(method: string, params: unknown): JsonRpcReply | Promise<JsonRpcReply>;
}

export interface RpcResponse {
  /** The full JSON-RPC response message. */
  message: Record<string, unknown>;
  latencyMs: number;
  /** Ids of the recorded request and response, when recording. */
  requestMessageId: number | null;
  responseMessageId: number | null;
}

export class RpcError extends Error {}

interface Pending {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  requestMessageId: number | null;
}

/**
 * A minimal MCP client over stdio, used to replay recorded requests. It
 * speaks raw JSON-RPC so requests go out exactly as recorded (or edited),
 * rather than as an SDK would rebuild them.
 */
export class StdioRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrText = '';
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private failure: Error | null = null;

  constructor(private readonly options: RpcClientOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = new LineSplitter((line) => this.onLine(line));
    const stderr = new LineSplitter((line) => options.recorder?.stderr(line));
    this.child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrText = (this.stderrText + chunk.toString('utf8')).slice(-8000);
      stderr.push(chunk);
    });
    this.child.stdin.on('error', () => {});

    this.exited = new Promise((resolve) => {
      this.child.on('error', (error) => {
        this.fail(new RpcError(`failed to start ${options.command}: ${error.message}`));
        resolve({ code: null, signal: null });
      });
      this.child.on('close', (code, signal) => {
        stdout.flush();
        stderr.flush();
        this.fail(new RpcError(`server exited (${signal ?? `code ${code}`}) before responding${this.stderrTail()}`));
        resolve({ code, signal });
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stderr(): string {
    return this.stderrText;
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<RpcResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${timeoutMs}ms${this.stderrTail()}`));
      }, timeoutMs);
      const pending: Pending = { resolve, reject, startedAt: performance.now(), timer, requestMessageId: null };
      this.pending.set(id, pending);
      pending.requestMessageId = this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Closes stdin and waits for the server to exit, killing it if it lingers. */
  async close(graceMs = 2000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), graceMs);
    const result = await this.exited;
    clearTimeout(timer);
    return result;
  }

  /** Writes a message and returns its recorded id, if recording. */
  private send(message: object): number | null {
    const line = JSON.stringify(message);
    const recorded = this.options.recorder?.frame('client', line)[0] ?? null;
    if (this.child.stdin.writable) this.child.stdin.write(`${line}\n`);
    return recorded;
  }

  private onLine(line: string): void {
    const recorded = this.options.recorder?.frame('server', line)[0] ?? null;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Recorded as invalid; nothing to dispatch.
    }

    if (typeof message.method === 'string') {
      if (message.id !== undefined) void this.answer(message.id, message.method, message.params);
      return;
    }

    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (pending) {
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      pending.resolve({
        message,
        latencyMs: performance.now() - pending.startedAt,
        requestMessageId: pending.requestMessageId,
        responseMessageId: recorded,
      });
    }
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    let reply: JsonRpcReply;
    try {
      reply = this.options.onServerRequest
        ? await this.options.onServerRequest(method, params)
        : { error: { code: -32601, message: `mcpspy replay does not handle ${method}` } };
    } catch (error) {
      reply = { error: { code: -32603, message: (error as Error).message } };
    }
    this.send({ jsonrpc: '2.0', id, ...reply });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private stderrTail(): string {
    const tail = this.stderrText.trim().split('\n').slice(-5).join('\n');
    return tail ? `\nserver stderr:\n${tail}` : '';
  }
}
