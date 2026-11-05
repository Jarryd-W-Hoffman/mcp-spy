import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import type { AuditEvent, AuditType, Direction, MessageKind, Verdict } from './audit-types.js';

export type { AuditEvent, AuditType } from './audit-types.js';

/** The hash before the first event. */
export const GENESIS = '0'.repeat(64);

/** What an agent can use to read or send data; other traffic is left to the session log. */
const AUDITED = new Set(['tools/call', 'resources/read', 'prompts/get', 'sampling/createMessage', 'elicitation/create']);

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Each event's hash covers the one before it, so changing, removing or
 * reordering an event breaks every hash after it. `data` is hashed as the
 * stored text, so nothing depends on how JSON is re-serialised.
 */
export function chainHash(event: Pick<AuditEvent, 'prev_hash' | 'seq' | 'ts' | 'session_id' | 'type' | 'data'>): string {
  return sha256(JSON.stringify([event.prev_hash, event.seq, event.ts, event.session_id, event.type, event.data]));
}

/** Who is running the proxy, as the operating system reports it. */
export function currentActor(read: () => { username: string } = userInfo): { user: string; host: string } {
  let user: string;
  try {
    user = read().username;
  } catch {
    // Containers can run under a uid with no passwd entry.
    user = 'unknown';
  }
  return { user, host: hostname() };
}

/** Told to the agent, and to whoever reads the proxy's output, when --require-audit stops traffic. */
export const AUDIT_STOPPED = "the audit trail can't be written, and --require-audit forbids running without it";

export interface AuditWriter {
  appendAudit(event: Pick<AuditEvent, 'ts' | 'session_id' | 'type' | 'data'>): AuditEvent;
}

export interface RecordedMessage {
  id: number;
  ts: number;
  direction: Direction;
  kind: MessageKind | 'log';
  method: string | null;
  rpcId: string | null;
  payload: string;
  latencyMs: number | null;
  /** The mock or policy rule that produced or changed the message. */
  rule: string | null;
}

export interface SessionDetails {
  transport: string;
  command: string;
  cwd: string;
  policy: { path: string | null; sha256: string | null } | null;
}

/**
 * Writes one session's security-relevant events to the audit chain: who ran
 * it, what the agent called, what the policy decided and how each call ended.
 * Arguments and results are referenced by hash, not copied, so the chain holds
 * nothing the session log's redaction and pruning are meant to remove.
 */
export class AuditTrail {
  /** Audited requests awaiting a reply, by sender and JSON-RPC id. */
  private readonly pending = new Map<string, { method: string; subject: string | null }>();
  private agent: string | null = null;

  constructor(
    private readonly store: AuditWriter,
    private readonly sessionId: number,
    private readonly server: string | null,
    private readonly now: () => number = Date.now,
    private readonly actor: { user: string; host: string } = currentActor(),
  ) {}

  started(details: SessionDetails): void {
    this.append('session_start', { ...this.actor, ...details });
  }

  ended(end: { exit_code: number | null; exit_signal: string | null }): void {
    this.append('session_end', end);
  }

  /** Called with each message as it's recorded, so what's hashed is what's in the log. */
  message(message: RecordedMessage): void {
    const { kind, method, direction, rpcId } = message;
    if (kind === 'request') {
      if (method === 'initialize') this.agent = clientName(message.payload);
      // mcpspy's own requests (asking the user, for one) are decisions, reported by verdict().
      if (!AUDITED.has(method!) || message.rule?.startsWith('policy')) return;
      const subject = subjectOf(method!, message.payload);
      this.pending.set(`${direction}:${rpcId}`, { method: method!, subject });
      this.append('call', { method, subject, direction, rpc_id: rpcId, ...reference(message) });
      return;
    }
    if (kind !== 'response' && kind !== 'error') return;
    const key = `${direction === 'server' ? 'client' : 'server'}:${rpcId}`;
    const call = this.pending.get(key);
    if (!call) {
      // Only mcpspy's own asks are missing from pending, so a server can't pass off a request of its own as an approval.
      if (direction === 'client' && method === 'elicitation/create' && rpcId?.startsWith('"mcpspy-ask-')) {
        this.append('approval', { rpc_id: rpcId, action: answerAction(message.payload) });
      }
      return;
    }
    this.pending.delete(key);
    this.append('outcome', {
      method: call.method,
      subject: call.subject,
      rpc_id: rpcId,
      status: kind === 'error' ? 'rpc_error' : flaggedError(message.payload) ? 'tool_error' : 'ok',
      rule: message.rule,
      latency_ms: message.latencyMs,
      ...reference(message),
    });
  }

  /** What a policy decided. Passes on methods no rule named say nothing, so they aren't recorded. */
  verdict(method: string, params: unknown, verdict: Verdict, policySha256: string | null): void {
    if (verdict.allow && verdict.rule === null && method !== 'tools/call') return;
    this.append('verdict', {
      method,
      subject: subjectFromParams(method, params),
      decision: verdict.allow ? 'allow' : verdict.ask !== undefined ? 'ask' : 'deny',
      rule: verdict.rule,
      reason: verdict.allow ? null : verdict.reason,
      policy_sha256: policySha256,
    });
  }

  private append(type: AuditType, data: Record<string, unknown>): void {
    this.store.appendAudit({
      ts: this.now(),
      session_id: this.sessionId,
      type,
      data: JSON.stringify({ server: this.server, agent: this.agent, ...data }),
    });
  }
}

/** Ties an event to the message in the session log, while that message exists. */
function reference(message: RecordedMessage): Record<string, unknown> {
  return { message_id: message.id, message_ts: message.ts, payload_sha256: sha256(message.payload) };
}

function parse(payload: string): Record<string, unknown> {
  return JSON.parse(payload) as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The agent's name and version, as it reports itself: nothing verifies them. */
function clientName(payload: string): string | null {
  const { params } = parse(payload);
  const info = isObject(params) ? params.clientInfo : null;
  if (!isObject(info) || typeof info.name !== 'string') return null;
  return typeof info.version === 'string' ? `${info.name} ${info.version}` : info.name;
}

function subjectOf(method: string, payload: string): string | null {
  return subjectFromParams(method, parse(payload).params);
}

function subjectFromParams(method: string, params: unknown): string | null {
  if (!isObject(params)) return null;
  const subject = method === 'resources/read' ? params.uri : params.name;
  return typeof subject === 'string' ? subject : null;
}

function answerAction(payload: string): string {
  const { result } = parse(payload);
  return isObject(result) && typeof result.action === 'string' ? result.action : 'none';
}

function flaggedError(payload: string): boolean {
  const { result } = parse(payload);
  return isObject(result) && result.isError === true;
}

export interface Anchor {
  seq: number;
  hash: string;
}

export interface ChainReport {
  count: number;
  head: Anchor | null;
  /** What's wrong with the chain, starting at the first break. Empty when it's intact. */
  problems: string[];
}

/** Parses an anchor in the form `verify` prints: seq:hash. */
export function parseAnchor(text: string): Anchor {
  const match = /^(\d+):([0-9a-f]{64})$/.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not an anchor; use the <seq>:<hash> that mcpspy audit verify prints`);
  return { seq: Number(match[1]), hash: match[2]! };
}

/**
 * Checks that events form an unbroken chain from the first, and that the
 * anchor (a head saved somewhere else earlier) is still part of it. Without an
 * anchor, someone who can write to the log could rewrite the whole chain or
 * cut off its end, so only an anchor proves those didn't happen.
 */
export function verifyChain(events: Iterable<AuditEvent>, anchor?: Anchor): ChainReport {
  const problems: string[] = [];
  let count = 0;
  let previous: Anchor = { seq: 0, hash: GENESIS };
  let anchored = false;

  for (const event of events) {
    count++;
    if (event.seq !== previous.seq + 1) {
      problems.push(`event ${previous.seq + 1} is missing: the next event is ${event.seq}`);
      break;
    }
    if (event.prev_hash !== previous.hash) {
      problems.push(`event ${event.seq} doesn't follow event ${previous.seq}: its previous hash differs`);
      break;
    }
    if (chainHash(event) !== event.hash) {
      problems.push(`event ${event.seq} was changed: its contents don't match its hash`);
      break;
    }
    if (anchor?.seq === event.seq) {
      if (event.hash !== anchor.hash) problems.push(`event ${event.seq} doesn't match the anchor: the chain was rewritten`);
      anchored = true;
    }
    previous = { seq: event.seq, hash: event.hash };
  }

  if (anchor && !anchored && problems.length === 0) {
    problems.push(`the chain ends at event ${previous.seq}, before the anchor at event ${anchor.seq}: its end was removed`);
  }
  return { count, head: previous.seq === 0 ? null : previous, problems };
}

/** The first line of an export, identifying the file. */
export const EXPORT_HEADER = { format: 'mcpspy-audit', version: 1 };

/** An event's data. A forged event can hold anything, and listing or checking it must not fall over. */
export function eventData(event: Pick<AuditEvent, 'data'>): Record<string, unknown> {
  const data = parseLine(event.data);
  return isObject(data) ? data : {};
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Reads an export back into events, without checking the chain. */
export function parseExport(text: string): AuditEvent[] {
  const [header, ...lines] = text.split('\n').filter((line) => line.trim() !== '');
  const first = header === undefined ? null : parseLine(header);
  if (!isObject(first) || first.format !== EXPORT_HEADER.format || first.version !== EXPORT_HEADER.version) throw new Error('not an mcpspy audit export');
  return lines.map((line, index) => {
    const event = parseLine(line);
    if (!isObject(event)) throw new Error(`line ${index + 2} is not an audit event`);
    return event as unknown as AuditEvent;
  });
}

/** Where recorded messages stand against the hashes the chain holds for them. */
export interface MessageCheck {
  matched: number;
  /** Pruned since, or their ids reused by later messages. */
  gone: number;
  changed: number[];
}

/**
 * Compares the messages still in the log against the hashes in the chain, so
 * an edit to a recorded argument or result shows up too. A message with a
 * different timestamp is a later one that reused a pruned message's id.
 */
export function checkMessages(
  events: Iterable<AuditEvent>,
  lookup: (id: number) => { ts: number; payload: string } | undefined,
): MessageCheck {
  const check: MessageCheck = { matched: 0, gone: 0, changed: [] };
  for (const event of events) {
    if (event.type !== 'call' && event.type !== 'outcome') continue;
    const { message_id: id, message_ts: ts, payload_sha256: hash } = eventData(event);
    const message = typeof id === 'number' ? lookup(id) : undefined;
    if (!message || message.ts !== ts) check.gone++;
    else if (sha256(message.payload) === hash) check.matched++;
    else check.changed.push(id as number);
  }
  return check;
}
