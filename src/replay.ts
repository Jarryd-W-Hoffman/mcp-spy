import { Recorder } from './recorder.js';
import { HttpRpcClient } from './http-client.js';
import { RpcClient, RpcError, StdioRpcClient, type JsonRpcReply } from './rpc-client.js';
import type { Store } from './store.js';
import type { MessageRow, SessionRow } from './types.js';

export interface ReplayOptions {
  store: Store;
  /** The recorded request to replay (one the agent sent to the server). */
  messageId: number;
  /** Replaces the request's params; the recorded ones are used otherwise. */
  params?: unknown;
  /** Send the request this many times in the same server session. */
  repeat?: number;
  /** Extra environment variables for the server, on top of this process's. */
  env?: Record<string, string>;
  /** HTTP headers for servers reached over HTTP, e.g. Authorization (which is never recorded). */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ReplayRun {
  requestId: number | null;
  responseId: number | null;
  latencyMs: number;
  response: Record<string, unknown>;
}

export interface ReplayResult {
  /** The new session the replay was recorded in. */
  sessionId: number;
  original: { requestId: number; responseId: number | null; method: string };
  /** Spawn to initialize response. */
  startupMs: number;
  runs: ReplayRun[];
  /** Config-like variables the original server had that aren't set now. */
  missingEnv: string[];
}

export class ReplayError extends Error {
  constructor(
    message: string,
    readonly sessionId: number | null = null,
  ) {
    super(message);
  }
}

const DEFAULT_INITIALIZE = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'mcpspy-replay', version: '1' },
};

/**
 * Replays a recorded request against a fresh copy of the server that
 * received it (or a new session with it, for servers reached over HTTP):
 * same command and working directory, the same initialize
 * the agent sent, and the agent's recorded answers to any requests the
 * server makes back (roots/list, …). The replay is recorded as a new
 * session linked to the original.
 */
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const { store, repeat = 1, timeoutMs = 30_000 } = options;
  const request = store.getMessage(options.messageId);
  if (!request) throw new ReplayError(`no message with id ${options.messageId}`);
  if (request.kind !== 'request' || request.direction !== 'client' || request.method === null) {
    throw new ReplayError(`message ${request.id} is not a request from the agent`);
  }
  if (request.method === 'initialize') throw new ReplayError('initialize is sent automatically; replay a later request');
  const session = store.getSession(request.session_id)!;
  const originSessionId = session.replay_of ?? session.id;
  // Replays are recorded as 'replay'; how to reach the server comes from the session they replay.
  const transport = store.getSession(originSessionId)?.transport ?? session.transport;
  if (!['stdio', 'mock', 'http', 'sse'].includes(transport)) {
    throw new ReplayError(`replaying ${transport} sessions is not supported`);
  }
  const overHttp = transport === 'http' || transport === 'sse';

  const [command, ...args] = JSON.parse(session.command) as [string, ...string[]];
  const env = { ...process.env, ...options.env };
  const params = options.params !== undefined ? options.params : (JSON.parse(request.payload) as { params?: unknown }).params;

  const sessionId = store.createSession({
    name: session.name,
    transport: 'replay',
    command: session.command,
    cwd: session.cwd,
    pid: null,
    started_at: Date.now(),
    replay_of: originSessionId,
    env_keys: overHttp ? null : JSON.stringify(Object.keys(env).sort()),
  });

  const recorder = new Recorder(store, sessionId);
  const toolList = store.latestReply(originSessionId, 'tools/list');
  if (toolList) recorder.useToolList(toolList.payload);

  const onServerRequest = (method: string) => recordedClientReply(store, originSessionId, method);
  const client: RpcClient = overHttp
    ? new HttpRpcClient({ url: command, transport: transport as 'http' | 'sse', headers: options.headers, recorder, onServerRequest })
    : new StdioRpcClient({ command, args, cwd: session.cwd, env, recorder, onServerRequest });
  if (client.pid !== undefined) store.setSessionPid(sessionId, client.pid);

  const runs: ReplayRun[] = [];
  let startupMs = 0;
  let failure: unknown = null;
  try {
    const started = performance.now();
    const initialize = store.firstRequest(originSessionId, 'initialize');
    const init = await client.request(
      'initialize',
      initialize ? (JSON.parse(initialize.payload) as { params?: unknown }).params : DEFAULT_INITIALIZE,
      timeoutMs,
    );
    startupMs = performance.now() - started;
    if ('error' in init.message) throw new RpcError(`initialize failed: ${JSON.stringify(init.message.error)}`);
    client.notify('notifications/initialized');

    for (let run = 0; run < repeat; run++) {
      const reply = await client.request(request.method, params, timeoutMs);
      runs.push({ requestId: reply.requestMessageId, responseId: reply.responseMessageId, latencyMs: reply.latencyMs, response: reply.message });
    }
  } catch (error) {
    failure = error;
  }

  const exit = await client.close();
  store.endSession(sessionId, { ended_at: Date.now(), exit_code: exit.signal ? null : exit.code, exit_signal: exit.signal });
  if (failure) throw new ReplayError((failure as Error).message, sessionId);

  return {
    sessionId,
    original: { requestId: request.id, responseId: store.responseTo(request.id)?.id ?? null, method: request.method },
    startupMs,
    runs,
    missingEnv: missingEnv(session, env),
  };
}

/** The agent's recorded reply to a server-initiated request, so the server sees the same roots etc. */
function recordedClientReply(store: Store, sessionId: number, method: string): JsonRpcReply {
  const recorded = store.clientReplyTo(sessionId, method);
  if (recorded) {
    const message = JSON.parse(recorded.payload) as Record<string, unknown>;
    if ('result' in message) return { result: message.result };
    if ('error' in message) return { error: message.error as { code: number; message: string } };
  }
  if (method === 'ping') return { result: {} };
  return { error: { code: -32601, message: `no recorded reply to ${method} to replay` } };
}

/** Names that typically configure a server: API keys, tokens, endpoints, … */
const CONFIG_LIKE = /KEY|TOKEN|SECRET|PASS|AUTH|CRED|URL|URI|HOST|ENDPOINT|DSN|DATABASE|_DB|ACCOUNT|PROJECT|REGION|ORG/i;

function missingEnv(session: SessionRow, env: NodeJS.ProcessEnv): string[] {
  if (!session.env_keys) return [];
  return (JSON.parse(session.env_keys) as string[]).filter((name) => CONFIG_LIKE.test(name) && env[name] === undefined);
}

/** Replaces the arguments of a tools/call (or prompts/get) request, keeping the rest of its params. */
export function withArguments(request: MessageRow, args: unknown): unknown {
  const params = ((JSON.parse(request.payload) as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
  return { ...params, arguments: args };
}
