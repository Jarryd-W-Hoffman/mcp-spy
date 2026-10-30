import type { Readable, Writable } from 'node:stream';
import { LineSplitter } from '../framing.js';
import type { MockEngine } from '../mocks.js';
import { Recorder } from '../recorder.js';
import type { Store } from '../store.js';

export interface MockServerOptions {
  mocks: MockEngine;
  /** The mock file, recorded as the session's command. */
  path: string;
  store: Store;
  name?: string | null;
  input?: Readable;
  output?: Writable;
}

/**
 * A stand-in MCP server driven entirely by a mock file: it lists the file's
 * tools and answers calls from its rules, so an agent can be developed
 * against an API that isn't available. Traffic is recorded like a proxy's.
 */
export function runMockServer(options: MockServerOptions): Promise<{ sessionId: number }> {
  const { mocks, store, input = process.stdin, output = process.stdout } = options;
  const sessionId = store.createSession({
    name: options.name ?? mocks.server?.name ?? null,
    transport: 'mock',
    command: JSON.stringify(['mcpspy', 'mock', 'serve', options.path]),
    cwd: process.cwd(),
    pid: process.pid,
    started_at: Date.now(),
  });
  const recorder = new Recorder(store, sessionId);
  // Replies waiting out a rule's delay; the session ends once they're sent.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let finish: (() => void) | null = null;

  const reply = (id: unknown, body: { result: unknown } | { error: unknown }, rule: string | null) => {
    const line = JSON.stringify({ jsonrpc: '2.0', id, ...body });
    output.write(`${line}\n`);
    recorder.frame('server', line, rule);
  };

  const handle = (line: string) => {
    recorder.frame('client', line);
    let message: { id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.method !== 'string' || message.id === undefined) return; // notifications and replies

    const { id, method, params } = message;
    if (method === 'initialize') {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return reply(
        id,
        {
          result: {
            protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: mocks.server?.name ?? 'mcpspy-mock', version: mocks.server?.version ?? '0.0.0' },
            ...(mocks.server?.instructions ? { instructions: mocks.server.instructions } : {}),
          },
        },
        'mock server',
      );
    }
    if (method === 'ping') return reply(id, { result: {} }, 'mock server');
    if (method === 'tools/list') return reply(id, { result: { tools: mocks.tools } }, 'mock tools');

    const decision = mocks.decide(method, params);
    if (!decision) {
      const tool = method === 'tools/call' ? (params as { name?: unknown } | undefined)?.name : undefined;
      if (typeof tool === 'string' && mocks.tools.some((candidate) => candidate.name === tool)) {
        return reply(id, { result: { content: [{ type: 'text', text: `No mock rule matches this call to ${tool}.` }], isError: true } }, 'no rule');
      }
      return reply(
        id,
        { error: tool !== undefined ? { code: -32602, message: `Unknown tool: ${String(tool)}` } : { code: -32601, message: `Method not found: ${method}` } },
        'no rule',
      );
    }
    if (decision.action === 'drop') return;
    if (decision.action === 'passthrough') {
      return reply(id, { error: { code: -32601, message: `rule "${decision.rule}" passes through, but mock serve has no real server` } }, decision.rule);
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      reply(id, decision.reply, decision.rule);
      if (timers.size === 0) finish?.();
    }, decision.delayMs);
    timers.add(timer);
  };

  const splitter = new LineSplitter(handle);
  return new Promise((resolve) => {
    input.on('data', (chunk: Buffer) => splitter.push(chunk));
    input.on('end', () => {
      splitter.flush();
      // The agent may close stdin straight after its last request: answer it first.
      finish = () => {
        store.endSession(sessionId, { ended_at: Date.now(), exit_code: 0, exit_signal: null });
        resolve({ sessionId });
      };
      if (timers.size === 0) finish();
    });
  });
}
