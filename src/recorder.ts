import { classifyFrame } from './jsonrpc.js';
import { contextCost } from './tokens.js';
import { calledTool, checkMessage, SessionValidator } from './validate.js';
import type { Direction, NewMessage, Store } from './store.js';

interface PendingRequest {
  messageId: number;
  method: string | null;
  startedAt: number;
  /** For tools/call, the tool it names, to validate the result against. */
  tool: string | null;
}

/**
 * Records the frames of one session and pairs each response with the request
 * it answers. Requests flow both ways (servers send sampling and elicitation
 * requests to the client), so pending requests are keyed by sender and id.
 */
export class Recorder {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly validator = new SessionValidator();

  constructor(
    private readonly store: Store,
    readonly sessionId: number,
    private readonly now: () => number = () => performance.timeOrigin + performance.now(),
  ) {}

  /** Records one stdio frame sent by the client or the server. */
  frame(direction: 'client' | 'server', line: string): number[] {
    const ts = this.now();
    const ids: number[] = [];

    for (const message of classifyFrame(line)) {
      let requestId: number | null = null;
      let latency: number | null = null;
      let method = message.method;
      let tool: string | null = null;

      if ((message.kind === 'response' || message.kind === 'error') && message.rpcId !== null) {
        const requester = direction === 'server' ? 'client' : 'server';
        const key = `${requester}:${message.rpcId}`;
        const request = this.pending.get(key);
        if (request) {
          this.pending.delete(key);
          requestId = request.messageId;
          latency = ts - request.startedAt;
          method = request.method;
          tool = request.tool;
        }
      }

      const cost = requestId !== null ? contextCost(method, message.json) : null;
      const issues = checkMessage(this.validator, { direction, kind: message.kind, method, payload: message.json }, tool);
      const id = this.insert(direction, ts, {
        kind: message.kind,
        method,
        rpc_id: message.rpcId,
        payload: message.json,
        problem: message.problem,
        request_id: requestId,
        latency_ms: latency,
        tokens: cost?.tokens ?? null,
        token_detail: cost?.tools ? JSON.stringify(cost.tools) : null,
        issues: issues.length > 0 ? JSON.stringify(issues) : null,
      });

      if (message.kind === 'request' && message.rpcId !== null) {
        this.pending.set(`${direction}:${message.rpcId}`, {
          messageId: id,
          method: message.method,
          startedAt: ts,
          tool: message.method === 'tools/call' ? calledTool(message.json) : null,
        });
      }
      ids.push(id);
    }

    return ids;
  }

  /** Records one line of the server's stderr. */
  stderr(line: string): number {
    return this.insert('stderr', this.now(), {
      kind: 'log',
      method: null,
      rpc_id: null,
      payload: line,
      problem: null,
      request_id: null,
      latency_ms: null,
      tokens: null,
      token_detail: null,
      issues: null,
    });
  }

  /** Requests that never received a response. */
  unanswered(): number {
    return this.pending.size;
  }

  private insert(
    direction: Direction,
    ts: number,
    fields: Omit<NewMessage, 'session_id' | 'ts' | 'direction' | 'size'>,
  ): number {
    return this.store.insertMessage({
      session_id: this.sessionId,
      ts,
      direction,
      size: Buffer.byteLength(fields.payload),
      ...fields,
    });
  }
}

/** Estimates tokens for replies recorded before estimates existed. */
export function backfillTokens(store: Store): number {
  let updated = 0;
  for (;;) {
    const batch = store.messagesMissingTokens();
    if (batch.length === 0) return updated;
    for (const message of batch) {
      const cost = contextCost(message.method, message.payload);
      store.setTokens(message.id, cost?.tokens ?? 0, cost?.tools ? JSON.stringify(cost.tools) : null);
      updated++;
    }
  }
}

/** Validates sessions recorded before validation existed. */
export function backfillValidation(store: Store): number {
  let checked = 0;
  for (const sessionId of store.uncheckedSessions()) {
    const validator = new SessionValidator();
    const tools = new Map<number, string | null>();
    let after = 0;
    for (;;) {
      const batch = store.messagesAfter(after, { sessionId, limit: 1000 });
      if (batch.length === 0) break;
      for (const message of batch) {
        if (message.kind === 'request' && message.method === 'tools/call') tools.set(message.id, calledTool(message.payload));
        const issues = checkMessage(validator, message, message.request_id !== null ? (tools.get(message.request_id) ?? null) : null);
        if (issues.length > 0) store.setIssues(message.id, JSON.stringify(issues));
        after = message.id;
      }
    }
    store.markChecked(sessionId);
    checked++;
  }
  return checked;
}
