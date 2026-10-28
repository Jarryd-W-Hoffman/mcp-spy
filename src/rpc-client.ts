import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LineSplitter } from './framing.js';
import type { Recorder } from './recorder.js';

export type JsonRpcReply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

export interface BaseRpcClientOptions {
  /** Records both directions, as the proxy would. */
  recorder?: Recorder;
  /** Answers requests the server sends (roots/list, sampling, …). Defaults to "method not found". */
  onServerRequest?(method: string, params: unknown): JsonRpcReply | Promise<JsonRpcReply>;
}

export interface RpcClientOptions extends BaseRpcClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ClientExit {
  code: number | null;
  signal: NodeJS.Signals | null;
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
 * A minimal MCP client used to replay recorded requests. It speaks raw
 * JSON-RPC so requests go out exactly as recorded (or edited), rather than
 * as an SDK would rebuild them. Subclasses move the bytes.
 */
export abstract class RpcClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;

  constructor(protected readonly base: BaseRpcClientOptions) {}

  /** The server's process id, when there is one. */
  get pid(): number | undefined {
    return undefined;
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<RpcResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${timeoutMs}ms${this.detail()}`));
      }, timeoutMs);
      const pending: Pending = { resolve, reject, startedAt: performance.now(), timer, requestMessageId: null };
      this.pending.set(id, pending);
      pending.requestMessageId = this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  abstract close(): Promise<ClientExit>;

  /** Delivers one serialised message to the server. */
  protected abstract transmit(line: string, message: object): void;

  /** Extra context for errors, e.g. the server's stderr. */
  protected detail(): string {
    return '';
  }

  /** Writes a message and returns its recorded id, if recording. */
  private send(message: object): number | null {
    const line = JSON.stringify(message);
    const recorded = this.base.recorder?.frame('client', line)[0] ?? null;
    this.transmit(line, message);
    return recorded;
  }

  /** Handles one message from the server. */
  protected receive(line: string): void {
    const recorded = this.base.recorder?.frame('server', line)[0] ?? null;
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
      reply = this.base.onServerRequest
        ? await this.base.onServerRequest(method, params)
        : { error: { code: -32601, message: `mcpspy replay does not handle ${method}` } };
    } catch (error) {
      reply = { error: { code: -32603, message: (error as Error).message } };
    }
    this.send({ jsonrpc: '2.0', id, ...reply });
  }

  /** Fails one request (e.g. its HTTP POST was refused). */
  protected failRequest(id: unknown, error: Error): void {
    const pending = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id as number);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  /** Fails every request, now and later. */
  protected fail(error: Error): void {
    this.failure ??= error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Replays against a server started as a child process, over stdio. */
export class StdioRpcClient extends RpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrText = '';
  private exited: Promise<ClientExit>;

  constructor(options: RpcClientOptions) {
    super(options);
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = new LineSplitter((line) => this.receive(line));
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
        this.fail(new RpcError(`server exited (${signal ?? `code ${code}`}) before responding${this.detail()}`));
        resolve({ code, signal });
      });
    });
  }

  override get pid(): number | undefined {
    return this.child.pid;
  }

  get stderr(): string {
    return this.stderrText;
  }

  /** Closes stdin and waits for the server to exit, killing it if it lingers. */
  async close(graceMs = 2000): Promise<ClientExit> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), graceMs);
    const result = await this.exited;
    clearTimeout(timer);
    return result;
  }

  protected transmit(line: string): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${line}\n`);
  }

  protected override detail(): string {
    const tail = this.stderrText.trim().split('\n').slice(-5).join('\n');
    return tail ? `\nserver stderr:\n${tail}` : '';
  }
}
