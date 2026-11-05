import { verifyChain, type Anchor, type AuditEvent } from '../audit.js';
import { isLoopbackHost } from '../server.js';
import type { Store } from '../store.js';

export interface PushOptions {
  url: string;
  token: string;
  /** Events per request. */
  batch?: number;
  /** Check the whole local chain first; off for pushes in between a follow's periodic checks. */
  checkLocal?: boolean;
}

export interface PushResult {
  sent: number;
  head: Anchor | null;
  /** What the collector found wrong; pushing can't continue past it. */
  problems: string[];
}

/** Tokens, audit events and webhook secrets are sensitive, so they only cross a network encrypted, unless told otherwise. */
export function assertSafeUrl(url: string, allowPlain: boolean, what = 'your token and audit trail', flag = '--insecure-http'): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${url} is not an http(s) URL`);
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.host) && !allowPlain) {
    throw new Error(`${url} would send ${what} unencrypted; use https, or pass ${flag} if the network is already protected`);
  }
  return parsed;
}

type Reply = { head: Anchor | null; accepted: number; problems: { kind: string; seq: number; detail: string }[] };

async function post(options: PushOptions, head: Anchor | null, events: AuditEvent[], localProblem: string | null = null): Promise<Reply> {
  const response = await fetch(new URL('/v1/events', options.url), {
    method: 'POST',
    // A redirect could carry the token to another host.
    redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
    body: JSON.stringify({ head, events, ...(localProblem !== null ? { local_problem: localProblem } : {}) }),
  });
  if (response.status !== 200 && response.status !== 409) throw new Error(`the collector answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as Reply;
}

/**
 * Sends the collector whatever it doesn't have yet. First it asks where the
 * collector's copy ends, then sends from that event on: repeating that event
 * shows the local chain still contains it. The collector decides what's valid,
 * so nothing is remembered here and a failed push just runs again.
 *
 * Events can be removed from the middle of a local chain without moving its
 * head, which the exchange above can't see, so the whole chain is checked too,
 * and any break is reported. Altered mcpspy code could skip this, but what the
 * collector already holds stays as received either way.
 */
export async function pushAudit(store: Store, options: PushOptions): Promise<PushResult> {
  const batch = options.batch ?? 500;
  const describe = (reply: Reply) => reply.problems.map((problem) => `${problem.kind} at event ${problem.seq}: ${problem.detail}`);
  const localProblem = options.checkLocal === false ? null : (verifyChain(store.auditEvents()).problems[0] ?? null);
  let reply = await post(options, store.auditHead(), [], localProblem);
  let sent = 0;
  while (reply.problems.length === 0) {
    const from = Math.max((reply.head?.seq ?? 0) - 1, 0);
    const events = [...store.auditEvents(batch, from, batch)];
    const fresh = events.filter((event) => event.seq > (reply.head?.seq ?? 0));
    if (fresh.length === 0) break;
    reply = await post(options, store.auditHead(), events);
    sent += reply.accepted;
  }
  return { sent, head: reply.head, problems: describe(reply) };
}

/** What to keep sensitive stays out of a progress line: only counts and positions are printed. */
export function describeHead(head: Anchor | null): string {
  return head ? `${head.seq}:${head.hash}` : 'empty';
}


export interface FollowOptions extends PushOptions {
  intervalMs: number;
  /** How often to re-check the whole local chain, which takes longer as it grows. Hourly by default. */
  checkEveryMs?: number;
  /** Told what happened when it changes, so a long outage is one line. */
  log(message: string): void;
  signal: AbortSignal;
}

/**
 * Pushes on a timer until stopped. A push with nothing new still reaches the
 * collector, which is how it can tell a quiet machine from one that went
 * silent. Failures are retried: the chain waits safely in the local log.
 */
export async function followAudit(store: Store, options: FollowOptions): Promise<void> {
  let last = '';
  let nextCheck = 0;
  const say = (message: string) => {
    if (message !== last) options.log(message);
    last = message;
  };
  while (!options.signal.aborted) {
    try {
      const checkLocal = Date.now() >= nextCheck;
      if (checkLocal) nextCheck = Date.now() + (options.checkEveryMs ?? 60 * 60 * 1000);
      const { sent, head, problems } = await pushAudit(store, { ...options, checkLocal });
      if (problems.length > 0) say(`the collector flagged this chain: ${problems.join('; ')}`);
      else if (sent > 0) say(`sent ${sent} event${sent === 1 ? '' : 's'}; the collector is at ${describeHead(head)}`);
    } catch (error) {
      say(`push failed, will retry: ${(error as Error).message}`);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.intervalMs);
      options.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
