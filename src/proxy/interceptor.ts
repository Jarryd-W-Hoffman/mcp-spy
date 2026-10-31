import type { MockEngine } from '../mocks.js';
import { sentByServer, type PolicyEngine } from '../policy.js';

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
  /** How long an ask waits for the agent's user before refusing the call. */
  askTimeoutMs?: number;
}

/** Longest a held call's arguments are shown in an ask. */
const ASK_PREVIEW = 500;

type Message = { id?: unknown; method?: unknown; params?: unknown; result?: unknown };
/** Ends an ask. `answered`: the agent replied to it; `cancelled`: the agent cancelled the held call, which then gets no reply. */
type Settle = (approved: boolean, why: string, how?: 'answered' | 'cancelled') => void;

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
  /** Whether the agent said, in initialize, that it can show elicitation requests to its user. */
  private canAsk = false;
  /** Asks awaiting the agent's answer, by the id the proxy gave them. */
  private readonly asking = new Map<string, Settle>();
  /** The ask holding each call, by the call's JSON-RPC id (JSON-encoded). */
  private readonly held = new Map<string, string>();
  /** Asks that ended without an answer; a late answer is dropped, since the server never asked. */
  private readonly unanswered = new Set<string>();
  private asks = 0;

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
    // The agent's answer to an ask of ours: the server never sent it, so it never sees the answer.
    if (isObject(message) && message.method === undefined && typeof message.id === 'string' && this.asking.has(message.id)) {
      const accepted = isObject(message.result) && message.result.action === 'accept';
      this.asking.get(message.id)!(accepted, accepted ? '' : 'the user declined', 'answered');
      return;
    }
    if (isObject(message) && message.method === undefined && typeof message.id === 'string' && this.unanswered.delete(message.id)) return;
    // The agent gave up on a held call: it must not run on a later accept, and the server never saw it.
    if (isObject(message) && message.method === 'notifications/cancelled' && isObject(message.params)) {
      const askId = this.held.get(JSON.stringify(message.params.requestId));
      if (askId !== undefined) return this.asking.get(askId)!(false, 'the agent cancelled it', 'cancelled');
    }
    if (!isObject(message) || typeof message.method !== 'string') return toServer(policy ? JSON.stringify(message) : line);
    const request = message as Message & { method: string };
    if (request.method === 'initialize') this.canAsk = isObject(request.params) && isObject(request.params.capabilities) && request.params.capabilities.elicitation !== undefined;

    if (policy) {
      const verdict = policy.check(request.method, request.params);
      if (!verdict.allow) {
        const what = request.method === 'tools/call' ? `tools/call ${(request.params as { name: string }).name}` : request.method;
        if (verdict.ask !== undefined && request.id !== undefined && this.canAsk) return this.ask(request, what, verdict.rule, verdict.ask);
        const reason = verdict.ask !== undefined ? `${verdict.reason}, but the agent can't be asked` : verdict.reason;
        this.refuse(request, what, verdict.rule, reason);
        return;
      }
    }
    this.forward(request, policy ? JSON.stringify(request) : line);
  }

  /** Refuses every call still waiting on an ask: the agent can't answer once its input has ended. */
  inputEnded(): void {
    for (const settle of [...this.asking.values()]) settle(false, 'the agent closed its input before answering');
  }

  private forward(message: Message & { method: string }, line: string): void {
    const { toServer } = this.options;
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

  /**
   * The line to forward to the client, and the rule that shaped it, if any. The line is
   * null when the policy refused everything in it: the agent never sees it. `answers`
   * are the proxy's replies to the server's refused requests, for the caller to send
   * once it has recorded the line they answer.
   */
  fromServer(line: string): { line: string | null; rule: string | null; answers: string[] } {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return { line, rule: null, answers: [] };
    }
    const items = Array.isArray(message) ? message : [message];
    const checked = items.map((item) => checkFromServer(this.options, item));
    const answers = checked.flatMap((refused) => (refused?.answer ? [refused.answer] : []));
    const kept = items.filter((_item, index) => checked[index] === null);
    if (kept.length === 0) return { line: null, rule: checked[0]!.rule, answers };
    // A batch from the server is shaped item by item, so it can't carry anything past the policy.
    const shaped = kept.map((item) => this.shape(item));
    const rule = checked.find((refused) => refused !== null)?.rule ?? shaped.find((item) => item.rule !== null)?.rule ?? null;
    if (kept.length === items.length && shaped.every((item, index) => item.message === kept[index])) return { line, rule, answers };
    const out = shaped.map((item) => item.message);
    return { line: JSON.stringify(Array.isArray(message) ? out : out[0]), rule, answers };
  }

  /** One message from the server as the agent should get it, and the rule that changed it, if any. */
  private shape(received: unknown): { message: unknown; rule: string | null } {
    const { mocks, policy } = this.options;
    if (!isObject(received)) return { message: received, rule: null };
    const redacted = policy?.redactMessage(received) ?? null;
    if (received.id === undefined || 'method' in received) return { message: redacted ?? received, rule: redacted ? 'policy: redacted' : null };
    let message: Message = received;

    const id = JSON.stringify(message.id);
    let rule = this.delayed.get(id) ?? null;
    this.delayed.delete(id);
    const toolList = this.toolLists.delete(id);
    const toolCall = this.toolCalls.delete(id);
    // Tool results get the policy's limits below, which include redaction.
    if (!toolCall && redacted) [message, rule] = [redacted, 'policy: redacted'];
    if (!('result' in message)) return { message, rule };

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
    return { message: result === message.result ? message : { ...message, result }, rule };
  }

  private refuse(message: Message & { method: string }, what: string, rule: string, reason: string): void {
    this.options.warn(`policy denied ${what} (${rule}): ${reason}`);
    // A notification gets no answer; it just never arrives.
    if (message.id !== undefined) this.reply(JSON.stringify(denial(message, reason)), `policy: ${rule}`);
  }

  /**
   * Holds a call and asks the agent's user, through MCP elicitation, whether
   * to let it through. Anything but an accept in time refuses it.
   */
  private ask(message: Message & { method: string }, what: string, rule: string, prompt: string): void {
    const askId = `mcpspy-ask-${++this.asks}`;
    this.pending++;
    const timer = setTimeout(() => settle(false, 'no answer in time'), this.options.askTimeoutMs ?? 120_000);
    const heldId = JSON.stringify(message.id);
    const settle: Settle = (approved, why, how) => {
      clearTimeout(timer);
      this.asking.delete(askId);
      this.held.delete(heldId);
      if (how !== 'answered') {
        // Lets the agent close its prompt; an answer that comes anyway is dropped.
        this.unanswered.add(askId);
        this.reply(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: askId, reason: why } }), `policy: ${rule}`);
      }
      this.options.warn(`policy ${approved ? 'approved' : 'denied'} ${what} (${rule}) after asking${approved ? '' : `: ${why}`}`);
      if (approved) this.forward(message, JSON.stringify(message));
      else if (how !== 'cancelled') this.reply(JSON.stringify(denial(message, `${prompt} (${why})`)), `policy: ${rule}`);
      if (--this.pending === 0) this.idle?.();
    };
    this.asking.set(askId, settle);
    this.held.set(heldId, askId);
    this.reply(askRequest(askId, prompt, what, message.params), `policy: ${rule}`);
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

/** The elicitation request that asks the agent's user whether to let a held call through (used by the HTTP proxy too). */
export function askRequest(askId: string, prompt: string, what: string, params: unknown): string {
  const args = JSON.stringify(isObject(params) ? (params.arguments ?? params) : {});
  const shown = args.length > ASK_PREVIEW ? `${args.slice(0, ASK_PREVIEW)}…` : args;
  return JSON.stringify({
    jsonrpc: '2.0',
    id: askId,
    method: 'elicitation/create',
    params: { message: `${prompt}\n\nmcpspy is holding ${what} ${shown}. Accept to let it through.`, requestedSchema: { type: 'object', properties: {} } },
  });
}

/**
 * Checks a request or notification only servers send (sampling, elicitation, roots, …)
 * against the policy (used by the HTTP proxy too). Null when it may reach the agent;
 * otherwise the rule that refused it, and for a request, the refusal to answer the
 * server with, so it isn't left waiting. A refused notification is just dropped.
 */
export function checkFromServer(
  { policy, warn }: { policy: PolicyEngine | null; warn(message: string): void },
  item: unknown,
): { rule: string; answer: string | null } | null {
  if (!policy || !isObject(item) || typeof item.method !== 'string' || !sentByServer(item.method)) return null;
  const verdict = policy.check(item.method, item.params);
  if (verdict.allow) return null;
  warn(`policy denied ${item.method} from the server (${verdict.rule}): ${verdict.reason}`);
  return { rule: `policy: ${verdict.rule}`, answer: item.id !== undefined ? JSON.stringify(refusal(item.id, verdict.reason)) : null };
}

export function refusal(id: unknown, reason: string): object {
  return { jsonrpc: '2.0', id, error: { code: POLICY_ERROR, message: `Blocked by mcpspy policy: ${reason}` } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
