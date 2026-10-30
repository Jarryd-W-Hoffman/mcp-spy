import { vi } from 'vitest';
import type { MessageRow, MessageSummary, SessionSummary } from '../../../src/types.js';

export const session = (patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 1,
  name: 'files',
  transport: 'stdio',
  command: '["node","server.js"]',
  cwd: '/work',
  pid: 42,
  started_at: Date.now(),
  ended_at: null,
  exit_code: null,
  exit_signal: null,
  replay_of: null,
  env_keys: null,
  checked: 1,
  message_count: 2,
  ...patch,
});

export const summary = (patch: Partial<MessageSummary> = {}): MessageSummary => ({
  id: 1,
  session_id: 1,
  ts: new Date(2026, 0, 2, 3, 4, 5, 6).getTime(),
  direction: 'client',
  kind: 'request',
  method: 'tools/call',
  rpc_id: '1',
  size: 100,
  problem: null,
  request_id: null,
  latency_ms: null,
  tokens: null,
  mock: null,
  issues: [],
  subject: 'read',
  error: null,
  preview: null,
  ...patch,
});

export const row = (patch: Partial<MessageRow> = {}): MessageRow => ({
  id: 1,
  session_id: 1,
  ts: 0,
  direction: 'client',
  kind: 'request',
  method: 'tools/call',
  rpc_id: '1',
  payload: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read"}}',
  size: 70,
  problem: null,
  request_id: null,
  latency_ms: null,
  tokens: null,
  token_detail: null,
  issues: null,
  mock: null,
  ...patch,
});

type Reply = unknown | ((init: RequestInit | undefined, url: string) => unknown);

/** A JSON reply with a status other than 200. */
export class Status {
  constructor(
    readonly status: number,
    readonly body: unknown = {},
  ) {}
}

/**
 * Stubs fetch with replies looked up by path (and query). A reply that is an
 * Error rejects; a Status sets the status; a function computes the reply.
 * Unknown paths answer 404.
 */
export function stubFetch(routes: Record<string, Reply>) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    let reply = routes[input];
    if (reply === undefined) return new Response('{}', { status: 404 });
    if (typeof reply === 'function') reply = (reply as (init: RequestInit | undefined, url: string) => unknown)(init, input);
    reply = await reply;
    if (reply instanceof Error) throw reply;
    if (reply instanceof Status) return new Response(JSON.stringify(reply.body), { status: reply.status });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** Stands in for the browser's EventSource; tests drive it by hand. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  static get latest(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }

  static install() {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  close() {
    this.closed = true;
  }
}
