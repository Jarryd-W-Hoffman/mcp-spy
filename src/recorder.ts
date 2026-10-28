import { classifyFrame } from './jsonrpc.js';
import type { Direction, NewMessage, Store } from './store.js';

interface PendingRequest {
  messageId: number;
  method: string | null;
  startedAt: number;
}

/**
 * Records the frames of one session and pairs each response with the request
 * it answers. Requests flow both ways (servers send sampling and elicitation
 * requests to the client), so pending requests are keyed by sender and id.
 */
export class Recorder {
  private readonly pending = new Map<string, PendingRequest>();

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

      if ((message.kind === 'response' || message.kind === 'error') && message.rpcId !== null) {
        const requester = direction === 'server' ? 'client' : 'server';
        const key = `${requester}:${message.rpcId}`;
        const request = this.pending.get(key);
        if (request) {
          this.pending.delete(key);
          requestId = request.messageId;
          latency = ts - request.startedAt;
          method = request.method;
        }
      }

      const id = this.insert(direction, ts, {
        kind: message.kind,
        method,
        rpc_id: message.rpcId,
        payload: message.json,
        problem: message.problem,
        request_id: requestId,
        latency_ms: latency,
      });

      if (message.kind === 'request' && message.rpcId !== null) {
        this.pending.set(`${direction}:${message.rpcId}`, { messageId: id, method: message.method, startedAt: ts });
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
