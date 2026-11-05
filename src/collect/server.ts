import { timingSafeEqual } from 'node:crypto';
import { createServer as createPlainServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Anchor, AuditEvent } from '../audit.js';
import { isLoopbackHost } from '../server.js';
import { renderPage } from './page.js';
import type { CollectorStore } from './store.js';

export interface CollectorOptions {
  store: CollectorStore;
  host?: string;
  /** 0 picks a free port. */
  port: number;
  /** Secret that opens the web view. The URL carries it once; the server swaps it for a cookie. */
  viewKey: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** A machine not heard from for this long shows as silent. */
  silentAfterMs?: number;
}

export interface Collector {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;
const MAX_EVENTS = 1000;
const TYPES = new Set(['session_start', 'session_end', 'call', 'verdict', 'approval', 'outcome']);
const HASH = /^[0-9a-f]{64}$/;

class BadRequest extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isCount = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;

function isAnchor(value: unknown): value is Anchor {
  const anchor = value as Anchor | null;
  return typeof anchor === 'object' && anchor !== null && isCount(anchor.seq, 1) && typeof anchor.hash === 'string' && HASH.test(anchor.hash);
}

function isEvent(value: unknown): value is AuditEvent {
  const event = value as AuditEvent | null;
  return (
    typeof event === 'object' &&
    event !== null &&
    isCount(event.seq, 1) &&
    isCount(event.ts, 0) &&
    isCount(event.session_id, 0) &&
    TYPES.has(event.type) &&
    typeof event.data === 'string' &&
    typeof event.prev_hash === 'string' &&
    HASH.test(event.prev_hash) &&
    typeof event.hash === 'string' &&
    HASH.test(event.hash)
  );
}

/** Keeps exactly the fields the chain covers, so nothing else a machine sends is stored. */
function parsePush(text: string): { head: Anchor | null; events: AuditEvent[]; localProblem: string | null } {
  let body: { head?: unknown; events?: unknown; local_problem?: unknown } | null;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new BadRequest(400, 'the body is not JSON');
  }
  const head = body?.head ?? null;
  const events = body?.events;
  if (head !== null && !isAnchor(head)) throw new BadRequest(400, 'head must be null or { seq, hash }');
  if (!Array.isArray(events) || !events.every(isEvent)) throw new BadRequest(400, 'events must be a list of audit events');
  if (events.length > MAX_EVENTS) throw new BadRequest(413, `at most ${MAX_EVENTS} events per request`);
  const localProblem = body?.local_problem ?? null;
  if (localProblem !== null && (typeof localProblem !== 'string' || localProblem.length > 1000)) throw new BadRequest(400, 'local_problem must be a short string');
  return { head, events, localProblem };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => (size > MAX_BODY ? reject(new BadRequest(413, 'the body is too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function sameSecret(given: string, secret: string): boolean {
  const [a, b] = [Buffer.from(given), Buffer.from(secret)];
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/**
 * Receives audit events from machines and shows them in one place. Machines
 * prove who they are with their token, so a name in a request means nothing;
 * people use the view key. Anything bound to loopback also refuses other Host
 * names, which stops a web page reaching it through DNS rebinding.
 */
export async function startCollector(options: CollectorOptions): Promise<Collector> {
  const { store, host = '127.0.0.1', viewKey, silentAfterMs = 60 * 60 * 1000 } = options;
  const loopback = isLoopbackHost(host);
  const secure = options.tls !== undefined;

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    void route(req, res).catch((error: Error) => {
      if (error instanceof BadRequest) return json(res, error.status, { error: error.message });
      process.stderr.write(`[mcpspy] collector error: ${error.message}\n`);
      json(res, 500, { error: 'the collector failed to handle this request' });
    });
  };
  const server = options.tls ? createTlsServer(options.tls, listener) : createPlainServer(listener);

  const cookieName = () => `mcpspy_collect_${(server.address() as AddressInfo).port}`;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (loopback && !isLoopbackHost(req.headers.host)) return json(res, 403, { error: 'this collector only answers requests addressed to localhost' });
    const url = new URL(req.url!, 'http://collector');
    if (req.method === 'POST' && url.pathname === '/v1/events') return receive(req, res);
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if (!admitted(req, res, url)) return;
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '', 10) || 200, 1000);
    const filter = { machine: url.searchParams.get('machine') ?? undefined, denied: url.searchParams.get('denied') === '1' };
    switch (url.pathname) {
      case '/': {
        const page = renderPage({ machines: store.machines(), incidents: store.incidents(), events: store.events({ ...filter, limit }), filter, now: Date.now(), silentAfterMs });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
        return;
      }
      case '/api/machines':
        return json(res, 200, store.machines());
      case '/api/incidents':
        return json(res, 200, store.incidents());
      case '/api/events':
        return json(res, 200, store.events({ ...filter, limit }));
      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  async function receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authorization = req.headers.authorization ?? '';
    const machine = authorization.startsWith('Bearer ') ? store.machineForToken(authorization.slice(7)) : undefined;
    if (!machine) {
      req.resume();
      return json(res, 401, { error: 'unknown or revoked token' });
    }
    const { head, events, localProblem } = parsePush(await readBody(req));
    const result = store.ingest(machine, events, head, localProblem);
    json(res, result.problems.length > 0 ? 409 : 200, result);
  }

  /** Lets a person in by key or cookie; a key in the URL becomes a cookie and leaves the address bar. */
  function admitted(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const given = url.searchParams.get('key');
    if (given !== null && sameSecret(given, viewKey)) {
      url.searchParams.delete('key');
      res.writeHead(303, {
        location: `${url.pathname}${url.search}`,
        'set-cookie': `${cookieName()}=${viewKey}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`,
      });
      res.end();
      return false;
    }
    const cookie = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName()}=`));
    if (cookie && sameSecret(cookie.slice(cookieName().length + 1), viewKey)) return true;
    json(res, 401, { error: 'open the link mcpspy collect printed' });
    return false;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const shown = host.includes(':') ? `[${host}]` : host;

  return {
    server,
    url: `${secure ? 'https' : 'http'}://${shown}:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
