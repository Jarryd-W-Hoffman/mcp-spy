import type { MockEngine } from '../mocks.js';
import type { PolicyEngine } from '../policy.js';

/** JSON-RPC error code for requests a policy refuses (in the implementation-defined server error range). */
export const POLICY_ERROR = -32001;

export interface InterceptorOptions {
  mocks: MockEngine | null;
  policy: PolicyEngine | null;
  toServer(line: string): void;
  toClient(line: string): void;
  /** Records a reply the proxy wrote itself, with the rule that wrote it. */
  recordReply(line: string, rule: string): void;
  warn(message: string): void;
}

type Message = { id?: unknown; method?: unknown; params?: unknown; result?: unknown };

/**
 * Handles stdio traffic line by line when the proxy has to act on it. A
 * policy is checked first: refused requests are answered here and never
 * reach the server, and what is forwarded is the message as checked
 * (re-serialised, so the server can't read anything the policy didn't).
 * Mock rules then answer, drop or delay what's left. On the way back, tool
 * lists get mock tools added and forbidden tools removed, and tool results
 * are held to the policy's limits.
 */
export class Interceptor {
  /** Ids (JSON-encoded) of client tools/list requests awaiting a response. */
  private readonly toolLists = new Set<string>();
  /** Ids of client tools/call requests awaiting a response. */
  private readonly toolCalls = new Set<string>();
  /** Requests forwarded late by a passthrough rule, so their responses can be labelled. */
  private readonly delayed = new Map<string, string>();
  private pending = 0;
  private idle: (() => void) | null = null;

  constructor(private readonly options: InterceptorOptions) {}

  fromClient(line: string): void {
    const { policy, toServer } = this.options;
    let message: Message | Message[];
    try {
      message = JSON.parse(line) as Message | Message[];
    } catch {
      // Not JSON, so no server could act on it; with a policy, nothing unchecked goes through.
      if (policy) this.options.warn('policy: dropped a line from the agent that is not JSON');
      else toServer(line);
      return;
    }

    if (Array.isArray(message)) {
      if (!policy) return toServer(line);
      // Batches went away in MCP 2025-06-18; refusing them keeps the policy simple to reason about.
      const replies = message.filter((item) => isObject(item) && item.id !== undefined && typeof item.method === 'string');
      this.options.warn('policy: refused a batch of messages');
      if (replies.length > 0) this.reply(JSON.stringify(replies.map((item) => refusal(item.id, 'batched requests are not allowed by the policy'))), 'policy');
      return;
    }
    if (!isObject(message) || typeof message.method !== 'string') return toServer(policy ? JSON.stringify(message) : line);

    if (policy) {
      const verdict = policy.check(message.method, message.params);
      if (!verdict.allow) {
        const what = message.method === 'tools/call' ? `tools/call ${(message.params as { name: string }).name}` : message.method;
        this.options.warn(`policy denied ${what} (${verdict.rule}): ${verdict.reason}`);
        // A notification gets no answer; it just never arrives.
        if (message.id !== undefined) this.reply(JSON.stringify(denial(message, verdict.reason)), `policy: ${verdict.rule}`);
        return;
      }
      line = JSON.stringify(message);
    }
    if (message.id === undefined) return toServer(line);

    const id = JSON.stringify(message.id);
    if (message.method === 'tools/list') this.toolLists.add(id);
    if (message.method === 'tools/call') this.toolCalls.add(id);
    const decision = this.options.mocks?.decide(message.method, message.params) ?? null;
    if (!decision) return toServer(line);
    switch (decision.action) {
      case 'drop':
        return;
      case 'passthrough':
        this.delayed.set(id, decision.rule);
        this.later(decision.delayMs, () => toServer(line));
        return;
      case 'respond':
        this.toolLists.delete(id);
        this.toolCalls.delete(id);
        this.later(decision.delayMs, () => this.reply(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...decision.reply }), decision.rule));
    }
  }

  /** The line to forward to the client, and the rule that shaped it, if any. */
  fromServer(line: string): { line: string; rule: string | null } {
    const { mocks, policy } = this.options;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return { line, rule: null };
    }
    if (!isObject(message) || message.id === undefined || 'method' in message) return { line, rule: null };

    const id = JSON.stringify(message.id);
    let rule = this.delayed.get(id) ?? null;
    this.delayed.delete(id);
    const toolList = this.toolLists.delete(id);
    const toolCall = this.toolCalls.delete(id);
    if (!('result' in message)) return { line, rule };

    let result = message.result;
    if (toolList && mocks && mocks.tools.length > 0) {
      result = mocks.patchToolList(result);
      rule = 'mock tools';
    }
    if (toolList && policy) {
      const filtered = policy.filterToolList(result);
      if (filtered.hidden.length > 0) {
        result = filtered.result;
        rule = `policy: hid ${filtered.hidden.join(', ')}`;
      }
    }
    if (toolCall && policy) {
      const limited = policy.limitResult(result);
      if (limited.change) {
        result = limited.result;
        rule = `policy: ${limited.change}`;
      }
    }
    return result === message.result ? { line, rule } : { line: JSON.stringify({ ...message, result }), rule };
  }

  /** Calls `done` once no delayed request or reply is waiting to be sent. */
  whenIdle(done: () => void): void {
    if (this.pending === 0) done();
    else this.idle = done;
  }

  private later(ms: number, fn: () => void): void {
    this.pending++;
    setTimeout(() => {
      fn();
      if (--this.pending === 0) this.idle?.();
    }, ms);
  }

  private reply(line: string, rule: string): void {
    this.options.toClient(line);
    this.options.recordReply(line, rule);
  }
}

/** A refusal the agent can read (used by the HTTP proxy too): a failed tool result for tools/call, a JSON-RPC error otherwise. */
export function denial(message: { id?: unknown; method?: unknown }, reason: string): object {
  if (message.method === 'tools/call') {
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `Blocked by mcpspy policy: ${reason}` }], isError: true } };
  }
  return refusal(message.id, reason);
}

export function refusal(id: unknown, reason: string): object {
  return { jsonrpc: '2.0', id, error: { code: POLICY_ERROR, message: `Blocked by mcpspy policy: ${reason}` } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
