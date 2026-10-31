import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { MockEngine } from '../mocks.js';
import type { PolicyEngine } from '../policy.js';
import { Recorder } from '../recorder.js';
import { Redactor } from '../redact.js';
import { isLoopbackHost } from '../server.js';
import { formatSseEvent, SseParser, type SseEvent } from '../sse.js';
import type { Store } from '../store.js';
import { askRequest, checkFromServer, denial, refusal } from './interceptor.js';

export interface HttpProxyOptions {
  /** The real server's MCP endpoint, e.g. https://mcp.example.com/mcp. */
  upstream: string;
  store: Store;
  /** Session label; defaults to the upstream host. */
  name?: string | null;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  mocks?: MockEngine;
  /** A policy the agent's requests must pass before they're forwarded (see src/policy.ts). */
  policy?: PolicyEngine;
  /**
   * Headers to send upstream with every request, replacing the agent's (e.g. an
   * Authorization token, so the agent needn't log in). Never recorded.
   */
  headers?: Record<string, string>;
  /** What to remove from the record; built-in secret patterns by default. */
  redactor?: Redactor;
  warn?: (message: string) => void;
  /**
   * Sessions with no traffic and no open stream for this long are ended and
   * forgotten, so agents that vanish without a DELETE don't pile up. 30 minutes by default.
   */
  sessionIdleMs?: number;
  /** How long an ask waits for the agent's user before refusing the call. Two minutes by default. */
  askTimeoutMs?: number;
}

export interface HttpProxy {
  /** The local URL to give the agent in place of the upstream one. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Headers that describe one hop, not the message, so they are never forwarded. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

interface Tracked {
  sessionId: number;
  recorder: Recorder;
  open: boolean;
  /** When the agent or server last sent anything in this session. */
  lastSeen: number;
  /** HTTP exchanges in flight (requests awaiting a reply, open event streams); it never goes idle while one is. */
  busy: number;
  /** Legacy transport: where the server's event stream said to POST messages. */
  endpoint?: URL;
  transport: 'http' | 'sse';
  /** Whether the agent said, in initialize, that it can show elicitation requests to its user. */
  canAsk: boolean;
  /** Asks awaiting the agent's answer, by the id the proxy gave them. */
  asking: Map<string, Settle>;
  /** The ask holding each call, by the call's JSON-RPC id (JSON-encoded). */
  held: Map<string, string>;
  /** Asks that ended without an answer; a late answer is dropped, since the server never asked. */
  unanswered: Set<string>;
}

/** Ends an ask. `answered`: the agent replied to it; `cancelled`: the agent cancelled the held call, or went away. */
type Settle = (approved: boolean, why: string, how?: 'answered' | 'cancelled') => void;

/**
 * A local reverse proxy for MCP servers spoken to over HTTP: Streamable HTTP
 * (POSTs answered with JSON or an SSE stream, plus an optional GET stream)
 * and the older HTTP+SSE transport (a GET stream that names a POST endpoint).
 *
 * Requests are forwarded to the same path on the upstream origin. JSON-RPC
 * found in request bodies, JSON responses and SSE events is recorded; each
 * MCP session (by Mcp-Session-Id, or by legacy endpoint) becomes a session in
 * the log. Credentials in headers pass through and are never recorded.
 */
export async function startHttpProxy(options: HttpProxyOptions): Promise<HttpProxy> {
  const upstream = new URL(options.upstream);
  const redactor = options.redactor ?? new Redactor();
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') throw new Error(`${options.upstream} is not an http(s) URL`);
  const { store, mocks = null, policy = null } = options;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[mcpspy] ${message}\n`));
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;

  const bySessionHeader = new Map<string, Tracked>();
  const byEndpoint = new Map<string, Tracked>();
  const all = new Set<Tracked>();
  /** Where traffic from servers that never assign a session id goes: the latest initialize. */
  let fallback: Tracked | null = null;
  let asks = 0;
  /** Ids (per session) of tools/list and tools/call requests whose replies mocks or the policy may change. */
  const awaiting = new WeakMap<Tracked, Map<string, 'list' | 'call'>>();

  let recordingBroken = false;
  const record = (fn: () => void): void => {
    if (recordingBroken) return;
    try {
      fn();
    } catch (error) {
      recordingBroken = true;
      warn(`recording stopped, still proxying: ${(error as Error).message}`);
    }
  };

  const track = (transport: 'http' | 'sse'): Tracked => {
    const sessionId = store.createSession({
      name: options.name ?? upstream.host,
      transport,
      command: JSON.stringify([redactor.text(upstream.href)]),
      cwd: process.cwd(),
      pid: null,
      started_at: Date.now(),
    });
    const tracked: Tracked = {
      sessionId,
      recorder: new Recorder(store, sessionId, undefined, redactor),
      open: true,
      lastSeen: Date.now(),
      busy: 0,
      transport,
      canAsk: false,
      asking: new Map(),
      held: new Map(),
      unanswered: new Set(),
    };
    all.add(tracked);
    return tracked;
  };
  const held = new WeakSet<ServerResponse>();
  /** Keeps a session alive until this exchange's response closes. Counted once, though a legacy stream is only tied to its session late. */
  const hold = (tracked: Tracked, res: ServerResponse): void => {
    tracked.lastSeen = Date.now();
    if (held.has(res)) return;
    held.add(res);
    tracked.busy++;
    res.on('close', () => {
      tracked.busy--;
      tracked.lastSeen = Date.now();
    });
  };

  /** Ends a session in the log and forgets it, so a request naming it later starts a new one. */
  const end = (tracked: Tracked): void => {
    if (!tracked.open) return;
    tracked.open = false;
    all.delete(tracked);
    for (const map of [bySessionHeader, byEndpoint]) {
      for (const [key, value] of map) if (value === tracked) map.delete(key);
    }
    if (fallback === tracked) fallback = null;
    record(() => store.endSession(tracked.sessionId, { ended_at: Date.now(), exit_code: null, exit_signal: null }));
  };

  const server = createServer((req, res) => {
    // Only reading the body or starting the upstream request can throw, both before any reply.
    void handle(req, res).catch((error: Error) => {
      warn(`proxy error: ${error.message}`);
      res.writeHead(502, { 'content-type': 'text/plain' }).end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Like the UI, refuse anything a web page could aim at us (DNS rebinding, cross-site POSTs).
    if (!isLoopbackHost(req.headers.host) || (req.headers.origin !== undefined && !isLoopbackOrigin(req.headers.origin))) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('mcpspy only proxies requests from localhost');
      return;
    }

    // Node sets url and method on every request a server receives. Only paths on the
    // upstream are proxied: an absolute-form target (`GET http://elsewhere/`), or a path
    // like //elsewhere or /\\elsewhere, would otherwise send the request, with any -H
    // token, to another server.
    const target = new URL(req.url!, upstream);
    if (!req.url!.startsWith('/') || target.origin !== upstream.origin) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end(`mcpspy only proxies paths on ${upstream.origin}`);
      return;
    }
    const local = `${target.pathname}${target.search}`;
    const method = req.method!;
    const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? Buffer.alloc(0) : await readAll(req);
    // Only POST bodies are checked, so with a policy, a body on any other method (PUT, PATCH, …) never reaches the server.
    if (policy && method !== 'POST' && body.length > 0) {
      warn(`policy: refused a ${method} request with a body`);
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, POST, DELETE' }).end(`mcpspy's policy only checks POST bodies, so it refuses a ${method} with one`);
      return;
    }
    const text = body.toString('utf8');
    const parsed = parseJson(text);
    const sessionHeader = header(req.headers, 'mcp-session-id');

    let tracked = sessionHeader !== null ? bySessionHeader.get(sessionHeader) : byEndpoint.get(local);
    if (!tracked && method === 'POST') {
      if (sessionHeader !== null) {
        // A session that began before the proxy started.
        tracked = track('http');
        bySessionHeader.set(sessionHeader, tracked);
      } else if (isInitialize(parsed)) {
        tracked = track('http');
        fallback = tracked;
      } else {
        tracked = fallback ?? (fallback = track('http'));
      }
    }
    // A GET without a session is the legacy transport's event stream (or not MCP at all); tracked once we see SSE.
    if (tracked) hold(tracked, res);

    let forwarded = body;
    if (tracked && method === 'POST' && text.trim() !== '') {
      const session = tracked;
      record(() => session.recorder.frame('client', text));
      if (policy) {
        if (isInitialize(parsed)) session.canAsk = declaresElicitation(parsed);
        // The agent's answer to an ask, or its cancellation of a held call: for the proxy, not the server.
        if (settleAsk(session, parsed)) {
          res.writeHead(202).end();
          return;
        }
        const reply = checkPolicy(parsed, session, String(req.headers.accept).includes('text/event-stream'));
        if (reply && 'ask' in reply) {
          holdAndAsk(session, req, res, parsed as Asked, reply.ask, target);
          return;
        }
        if (reply) {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (sessionHeader !== null) headers['mcp-session-id'] = sessionHeader;
          if (reply.text === null) res.writeHead(202, headers).end();
          else {
            const replyText = reply.text;
            res.writeHead(200, headers).end(replyText);
            record(() => session.recorder.frame('server', replyText, reply.rule));
          }
          return;
        }
        // What's forwarded is the message as checked, so the server can't read anything the policy didn't.
        forwarded = Buffer.from(JSON.stringify(parsed));
      }
      if (isRequest(parsed) && (parsed.method === 'tools/list' || parsed.method === 'tools/call')) {
        awaitingOf(session).set(JSON.stringify(parsed.id), parsed.method === 'tools/list' ? 'list' : 'call');
      }
    }

    // Mock rules apply to single requests; batches and replies always go through.
    let mockedBy: string | null = null;
    if (mocks && tracked && isRequest(parsed)) {
      const decision = mocks.decide(parsed.method, parsed.params);
      if (decision?.action === 'drop') return; // never answer; the client times out
      if (decision?.action === 'respond') {
        const session = tracked;
        awaitingOf(session).delete(JSON.stringify(parsed.id));
        await delay(decision.delayMs);
        const reply = JSON.stringify({ jsonrpc: '2.0', id: parsed.id, ...decision.reply });
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (sessionHeader !== null) headers['mcp-session-id'] = sessionHeader;
        res.writeHead(200, headers).end(reply);
        record(() => session.recorder.frame('server', reply, decision.rule));
        return;
      }
      if (decision?.action === 'passthrough') {
        mockedBy = decision.rule;
        await delay(decision.delayMs);
      }
    }

    const headers = upstreamHeaders(req.headers);
    if (forwarded.length > 0) headers['content-length'] = String(forwarded.length);

    const upstreamReq = send(target, { method, headers });
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    upstreamReq.on('error', (error) => {
      const reason = error.message;
      if (tracked) {
        const session = tracked;
        record(() => session.recorder.stderr(`[http] ${method} ${target.href} failed: ${reason}`));
      }
      // Requests only fail before a response, so nothing has been sent yet.
      res.writeHead(502, { 'content-type': 'text/plain' }).end(`mcpspy could not reach ${upstream.origin}: ${reason}`);
    });
    upstreamReq.on('response', (up) => {
      const assigned = header(up.headers, 'mcp-session-id');
      if (assigned !== null && tracked && !bySessionHeader.has(assigned)) bySessionHeader.set(assigned, tracked);

      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (value !== undefined && endToEnd(up.headers, name)) responseHeaders[name] = value;
      }
      const type = header(up.headers, 'content-type') ?? '';
      const encoding = header(up.headers, 'content-encoding');
      const encoded = encoding !== null && encoding !== 'identity';
      if (encoded && !DECODERS.has(encoding)) {
        if (policy) {
          // Replies the policy can't read can't be checked: hidden tools or unredacted results could get through.
          up.resume();
          warn(`policy: refused a reply compressed with ${encoding}, which mcpspy can't read`);
          res.writeHead(502, { 'content-type': 'text/plain' }).end(`mcpspy's policy can't check a reply compressed with ${encoding}`);
          return;
        }
        res.writeHead(up.statusCode!, responseHeaders);
        up.pipe(res);
        return;
      }
      // We asked for identity; a server that compressed anyway is decoded here, so what's
      // checked and recorded is exactly what the agent gets. A corrupt body resets the reply.
      const source: NodeJS.ReadableStream = encoded ? decompress(up, encoding, () => res.destroy()) : up;
      if (encoded) {
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
      }

      if (type.startsWith('text/event-stream')) {
        if (!tracked && method === 'GET' && up.statusCode === 200) {
          // With a session id, a Streamable HTTP session that began before the proxy; without, the legacy transport.
          tracked = track(sessionHeader !== null ? 'http' : 'sse');
          if (sessionHeader !== null) bySessionHeader.set(sessionHeader, tracked);
        }
        delete responseHeaders['content-length'];
        res.writeHead(up.statusCode!, responseHeaders);
        res.flushHeaders();
        const session = tracked;
        if (session) hold(session, res);
        const parser = new SseParser((event) => {
          res.write(session ? (onServerEvent(session, event, target, req.headers) ?? event.raw) : event.raw);
        });
        source.on('data', (chunk: Buffer) => parser.push(chunk));
        source.on('end', () => {
          res.end(parser.rest());
          if (session && method === 'GET' && sessionHeader === null) end(session); // the legacy stream is the session
        });
        up.on('error', () => res.destroy());
        res.on('close', () => {
          if (session && method === 'GET' && sessionHeader === null) end(session);
        });
        return;
      }

      // JSON and anything else: buffer (MCP responses are single messages), record, then forward.
      const chunks: Buffer[] = [];
      source.on('data', (chunk: Buffer) => chunks.push(chunk));
      up.on('error', () => res.destroy());
      source.on('end', () => {
        let raw = Buffer.concat(chunks);
        // Responses always carry a status line.
        const status = up.statusCode!;
        const session = tracked;
        const decoded = raw.toString('utf8');
        const reply = type.includes('json') ? parseJson(decoded) : undefined;

        if (session && reply !== undefined && isJsonRpc(reply)) {
          const shaped = shapeReply(session, reply);
          if (shaped !== null) {
            raw = Buffer.from(shaped.text);
            responseHeaders['content-length'] = String(raw.length);
          }
          record(() => session.recorder.frame('server', shaped?.text ?? decoded, shaped?.rule ?? mockedBy));
        } else if (session && status >= 400) {
          const detail = decoded.trim().slice(0, 500);
          record(() => session.recorder.stderr(`[http] ${status} ${up.statusMessage} for ${method} ${local}${detail ? `: ${detail}` : ''}`));
        }
        res.writeHead(status, responseHeaders).end(raw);

        if (method === 'DELETE' && session && status < 300) end(session);
      });
    });
    upstreamReq.end(forwarded);
  }

  /** The agent's headers as sent upstream: end-to-end ones, the configured ones on top, and no compression. */
  function upstreamHeaders(agentHeaders: IncomingHttpHeaders): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(agentHeaders)) {
      if (value !== undefined && endToEnd(agentHeaders, name) && name !== 'content-length') headers[name] = value;
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value;
    headers['accept-encoding'] = 'identity'; // so bodies can be read on the way through
    return headers;
  }

  /**
   * The reply to give instead of forwarding, when the policy refuses a body:
   * refused requests get a refusal, refused notifications nothing (text null).
   * Batches and bodies that aren't JSON are refused whole. A call an ask rule
   * holds comes back as `ask`, when the agent can be asked.
   */
  function checkPolicy(
    parsed: unknown,
    session: Tracked,
    acceptsStream: boolean,
  ): { text: string | null; rule: string } | { ask: { what: string; rule: string; prompt: string } } | null {
    if (parsed === undefined || Array.isArray(parsed)) {
      warn(parsed === undefined ? 'policy: refused a request body that is not JSON' : 'policy: refused a batch of messages');
      const requests = Array.isArray(parsed) ? parsed.filter(isRequest) : [];
      const why = parsed === undefined ? 'the request body is not JSON' : 'batched requests are not allowed by the policy';
      return { text: requests.length > 0 ? JSON.stringify(requests.map((request) => refusal(request.id, why))) : null, rule: 'policy' };
    }
    const message = parsed as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof message !== 'object' || message === null || typeof message.method !== 'string') return null;
    const verdict = policy!.check(message.method, message.params);
    if (verdict.allow) return null;
    const what = message.method === 'tools/call' ? `tools/call ${(message.params as { name: string }).name}` : message.method;
    // Asking holds the call's response open as an event stream and sends the question on it. The legacy
    // transport answers on another stream, and an agent that can't take a stream or show the question can't be asked.
    if (verdict.ask !== undefined && message.id !== undefined && session.canAsk && acceptsStream && session.transport === 'http') {
      return { ask: { what, rule: verdict.rule, prompt: verdict.ask } };
    }
    const reason =
      verdict.ask === undefined ? verdict.reason : `${verdict.reason}, but ${session.transport === 'sse' ? 'asking needs Streamable HTTP' : "the agent can't be asked"}`;
    warn(`policy denied ${what} (${verdict.rule}): ${reason}`);
    return { text: message.id !== undefined ? JSON.stringify(denial(message, reason)) : null, rule: `policy: ${verdict.rule}` };
  }

  /**
   * Holds a call and asks the agent's user, through MCP elicitation, whether to let it
   * through. The call's response becomes an event stream: the question goes out on it,
   * and then the call's reply, or its refusal. Anything but an accept in time refuses it.
   */
  function holdAndAsk(session: Tracked, req: IncomingMessage, res: ServerResponse, request: Asked, ask: { what: string; rule: string; prompt: string }, target: URL): void {
    const askId = `mcpspy-ask-${++asks}`;
    const heldId = JSON.stringify(request.id);
    const rule = `policy: ${ask.rule}`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const emit = (text: string) => {
      record(() => session.recorder.frame('server', text, rule));
      // Recorded even when the agent has gone, so the log says how the ask ended.
      if (!res.destroyed) res.write(formatSseEvent({ event: 'message', data: text }));
    };
    const timer = setTimeout(() => settle(false, 'no answer in time'), options.askTimeoutMs ?? 120_000);
    const gone = () => settle(false, 'the agent closed the connection', 'cancelled');
    const settle: Settle = (approved, why, how) => {
      clearTimeout(timer);
      res.off('close', gone);
      session.asking.delete(askId);
      session.held.delete(heldId);
      if (how !== 'answered') {
        // Lets the agent close its prompt; an answer that comes anyway is dropped.
        session.unanswered.add(askId);
        emit(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: askId, reason: why } }));
      }
      warn(`policy ${approved ? 'approved' : 'denied'} ${ask.what} (${ask.rule}) after asking${approved ? '' : `: ${why}`}`);
      if (approved) return forwardAsked(session, req, res, request, target);
      if (how !== 'cancelled') emit(JSON.stringify(denial(request, `${ask.prompt} (${why})`)));
      res.end();
    };
    res.on('close', gone);
    session.asking.set(askId, settle);
    session.held.set(heldId, askId);
    emit(askRequest(askId, ask.prompt, ask.what, request.params));
  }

  /** Whether a message from the agent answered one of the proxy's asks, or cancelled a call one holds; settles it if so. */
  function settleAsk(session: Tracked, message: unknown): boolean {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
    const { id, method, params, result } = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown };
    if (method === undefined && typeof id === 'string') {
      const settle = session.asking.get(id);
      if (settle) {
        const accepted = typeof result === 'object' && result !== null && (result as { action?: unknown }).action === 'accept';
        settle(accepted, accepted ? '' : 'the user declined', 'answered');
        return true;
      }
      return session.unanswered.delete(id);
    }
    if (method !== 'notifications/cancelled' || typeof params !== 'object' || params === null) return false;
    const askId = session.held.get(JSON.stringify((params as { requestId?: unknown }).requestId));
    if (askId === undefined) return false;
    session.asking.get(askId)!(false, 'the agent cancelled it', 'cancelled');
    return true;
  }

  /** Sends a call an ask let through to the server, and streams its reply to the agent as policy-shaped events. */
  function forwardAsked(session: Tracked, req: IncomingMessage, res: ServerResponse, request: Asked, target: URL): void {
    const body = Buffer.from(JSON.stringify(request));
    const headers = upstreamHeaders(req.headers);
    headers['content-length'] = String(body.length);
    if (request.method === 'tools/call' || request.method === 'tools/list') awaitingOf(session).set(JSON.stringify(request.id), request.method === 'tools/list' ? 'list' : 'call');
    const fail = (why: string) => {
      const text = JSON.stringify(refusal(request.id, why));
      record(() => session.recorder.frame('server', text, 'policy'));
      res.end(formatSseEvent({ event: 'message', data: text }));
    };
    const upstreamReq = send(target, { method: 'POST', headers });
    upstreamReq.on('error', (error) => {
      record(() => session.recorder.stderr(`[http] POST ${target.href} failed: ${error.message}`));
      fail(`mcpspy could not reach ${upstream.origin}: ${error.message}`);
    });
    upstreamReq.on('response', (up) => {
      const encoding = header(up.headers, 'content-encoding');
      const encoded = encoding !== null && encoding !== 'identity';
      if (encoded && !DECODERS.has(encoding)) {
        up.resume();
        warn(`policy: refused a reply compressed with ${encoding}, which mcpspy can't read`);
        return fail(`mcpspy's policy can't check a reply compressed with ${encoding}`);
      }
      const source: NodeJS.ReadableStream = encoded ? decompress(up, encoding, () => res.destroy()) : up;
      if (header(up.headers, 'content-type')?.startsWith('text/event-stream')) {
        const parser = new SseParser((event) => res.write(onServerEvent(session, event, target, req.headers) ?? event.raw));
        source.on('data', (chunk: Buffer) => parser.push(chunk));
        source.on('end', () => res.end(parser.rest()));
        return;
      }
      const chunks: Buffer[] = [];
      source.on('data', (chunk: Buffer) => chunks.push(chunk));
      source.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const reply = parseJson(text);
        if (!isJsonRpc(reply)) {
          record(() => session.recorder.stderr(`[http] ${up.statusCode} ${up.statusMessage} for POST ${target.pathname}${text.trim() ? `: ${text.trim().slice(0, 500)}` : ''}`));
          return fail(`the server answered ${up.statusCode} ${up.statusMessage}`);
        }
        const shaped = shapeReply(session, reply);
        record(() => session.recorder.frame('server', shaped?.text ?? text, shaped?.rule ?? null));
        res.end(formatSseEvent({ event: 'message', data: shaped?.text ?? text }));
      });
    });
    upstreamReq.end(body);
  }

  /** Records an event from the server and returns replacement text, if it had to change. */
  function onServerEvent(session: Tracked, event: SseEvent, target: URL, agentHeaders: IncomingHttpHeaders): string | null {
    const localHost = agentHeaders.host;
    if (event.event === 'endpoint' && event.data !== null) {
      // Legacy transport: the stream names the URL to POST to. Route those POSTs to this session,
      // and point absolute URLs at the proxy instead of the server.
      const endpoint = new URL(event.data, target);
      session.endpoint = endpoint;
      byEndpoint.set(`${endpoint.pathname}${endpoint.search}`, session);
      if (/^[a-z][a-z0-9+.-]*:/i.test(event.data) && endpoint.origin === upstream.origin && localHost) {
        return formatSseEvent({ event: 'endpoint', id: event.id, data: `http://${localHost}${endpoint.pathname}${endpoint.search}` });
      }
      return null;
    }
    if (event.event !== 'message' || event.data === null || event.data.trim() === '') return null;
    session.lastSeen = Date.now();
    const data = event.data;
    const parsed = parseJson(data);

    // Requests and notifications only servers send pass the policy first; refused ones never reach the agent.
    const items = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
    const checked = items.map((item) => checkFromServer({ policy, warn }, item));
    const refusedBy = checked.find((refused) => refused !== null)?.rule;
    if (refusedBy !== undefined) {
      const kept = items.filter((_item, index) => checked[index] === null);
      // A single message was refused whole; only a batch can have something left to forward.
      const text = kept.length === 0 ? null : JSON.stringify(kept);
      record(() => session.recorder.frame('server', text ?? data, refusedBy));
      for (const refused of checked) if (refused?.answer) answerServer(session, refused.answer, refused.rule, session.endpoint ?? target, agentHeaders);
      return text === null ? '' : formatSseEvent({ event: event.event, id: event.id, data: text });
    }

    const shaped = shapeReply(session, parsed);
    record(() => session.recorder.frame('server', shaped?.text ?? data, shaped?.rule ?? null));
    return shaped !== null ? formatSseEvent({ event: event.event, id: event.id, data: shaped.text }) : null;
  }

  /**
   * Sends the server the proxy's answer to one of its requests, as the agent would:
   * POSTed to the session's MCP endpoint with the agent's headers (session id, protocol
   * version, its own credentials) and any configured ones. Only ever to the upstream's
   * origin, so configured credentials go nowhere else.
   */
  function answerServer(session: Tracked, answer: string, rule: string, url: URL, agentHeaders: IncomingHttpHeaders): void {
    record(() => session.recorder.frame('client', answer, rule));
    if (url.origin !== upstream.origin) {
      warn(`policy: can't answer the server at ${url.origin}; its request will go unanswered`);
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(agentHeaders)) {
      if (value !== undefined && endToEnd(agentHeaders, name) && name !== 'content-length' && name !== 'last-event-id') headers[name] = value;
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = value;
    Object.assign(headers, { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(Buffer.byteLength(answer)) });
    const post = send(url, { method: 'POST', headers });
    post.on('response', (up) => {
      up.resume();
      if (up.statusCode! >= 400) record(() => session.recorder.stderr(`[http] the server refused mcpspy's answer to its request: ${up.statusCode} ${up.statusMessage}`));
    });
    post.on('error', (error) => record(() => session.recorder.stderr(`[http] could not answer the server's request: ${error.message}`)));
    post.end(answer);
  }

  function awaitingOf(session: Tracked): Map<string, 'list' | 'call'> {
    let ids = awaiting.get(session);
    if (!ids) awaiting.set(session, (ids = new Map()));
    return ids;
  }

  /**
   * A message from the server as the agent should get it: tool lists with mock
   * tools added and forbidden ones removed, tool results held to the policy's
   * limits, anything else redacted. A batch is shaped item by item. Null when
   * nothing changes.
   */
  function shapeReply(session: Tracked, message: unknown): { text: string; rule: string } | null {
    const items = Array.isArray(message) ? message : [message];
    const shaped = items.map((item) => shapeOne(session, item));
    if (shaped.every((item) => item === null)) return null;
    const out = shaped.map((item, index) => (item === null ? items[index] : item.message));
    return { text: JSON.stringify(Array.isArray(message) ? out : out[0]), rule: shaped.find((item) => item !== null)!.rule };
  }

  function shapeOne(session: Tracked, message: unknown): { message: unknown; rule: string } | null {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
    const record = message as Record<string, unknown>;
    const redacted = policy?.redactMessage(record) ?? null;
    const plain = redacted ? { message: redacted, rule: 'policy: redacted' } : null;
    const { id, result } = record;
    const key = JSON.stringify(id);
    const kind = id === undefined || 'method' in record ? undefined : awaitingOf(session).get(key);
    if (kind === undefined) return plain;
    awaitingOf(session).delete(key);
    if (result === undefined) return plain;

    // Tool results get the policy's limits below, which include redaction; lists are redacted first, as on stdio.
    let shaped: unknown = kind === 'list' && redacted ? redacted.result : result;
    let rule: string | null = kind === 'list' && redacted ? 'policy: redacted' : null;
    if (kind === 'list' && mocks && mocks.tools.length > 0) {
      shaped = mocks.patchToolList(shaped);
      rule = 'mock tools';
    }
    if (kind === 'list' && policy) {
      const filtered = policy.filterToolList(shaped);
      if (filtered.hidden.length > 0) [shaped, rule] = [filtered.result, `policy: hid ${filtered.hidden.join(', ')}`];
    }
    if (kind === 'call' && policy) {
      const limited = policy.limitResult(shaped);
      if (limited.change) [shaped, rule] = [limited.result, `policy: ${limited.change}`];
    }
    return rule === null ? null : { message: { ...record, result: shaped }, rule };
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7800, options.host ?? '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const idleMs = options.sessionIdleMs ?? 30 * 60_000;
  const sweep = setInterval(
    () => {
      for (const tracked of all) if (tracked.busy === 0 && Date.now() - tracked.lastSeen > idleMs) end(tracked);
    },
    Math.min(idleMs, 60_000),
  ).unref();
  const host = options.host ?? '127.0.0.1';

  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}${upstream.pathname}${upstream.search}`,
    port,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweep);
        for (const tracked of all) end(tracked);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Whether a header goes beyond this hop: not a standard hop-by-hop one, nor one the Connection header names. */
function endToEnd(headers: IncomingHttpHeaders, name: string): boolean {
  if (HOP_BY_HOP.has(name)) return false;
  const connection = header(headers, 'connection');
  return connection === null || !connection.split(',').some((listed) => listed.trim().toLowerCase() === name);
}

/** A single-valued header (Node only gives arrays for set-cookie, which this never reads). */
function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function readAll(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** The content encodings mcpspy can decode. */
const DECODERS = new Map([
  ['gzip', createGunzip],
  ['x-gzip', createGunzip],
  ['deflate', createInflate],
  ['br', createBrotliDecompress],
]);

function decompress(stream: IncomingMessage, encoding: string, onError: () => void): NodeJS.ReadableStream {
  const decoder = DECODERS.get(encoding)!();
  decoder.on('error', onError);
  return stream.pipe(decoder);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonRpc(value: unknown): boolean {
  const looks = (item: unknown) => typeof item === 'object' && item !== null && (item as { jsonrpc?: unknown }).jsonrpc === '2.0';
  return Array.isArray(value) ? value.some(looks) : looks(value);
}

function isRequest(value: unknown): value is { id: string | number; method: string; params?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { id, method } = value as { id?: unknown; method?: unknown };
  return typeof method === 'string' && (typeof id === 'string' || typeof id === 'number');
}

function isInitialize(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.some((item) => isRequest(item) && item.method === 'initialize');
}

/** A request held by an ask. */
type Asked = { id: string | number; method: string; params?: unknown };

/** Whether an initialize request says the agent can show elicitation requests to its user. */
function declaresElicitation(message: unknown): boolean {
  const params = (message as { params?: { capabilities?: { elicitation?: unknown } } }).params;
  return params?.capabilities?.elicitation !== undefined;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
