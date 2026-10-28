import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { toSummary, type MessageDetail, type ServerEvent } from './api.js';
import { backfillTokens, backfillValidation } from './recorder.js';
import { replay, ReplayError } from './replay.js';
import { toolsReport } from './report.js';
import type { Store } from './store.js';

export interface UiServerOptions {
  store: Store;
  port?: number;
  host?: string;
  /** Directory holding the built web UI. API-only when null. */
  staticDir: string | null;
  /** How often to look for new messages, in ms. */
  pollInterval?: number;
  /** Disables replay, so the UI can only read. */
  readOnly?: boolean;
}

export interface UiServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/**
 * Serves the web UI and its JSON API. Recorded payloads can hold secrets, so
 * the server binds to loopback and rejects requests whose Host header isn't a
 * loopback name (guarding against DNS rebinding from a malicious page).
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const { store, host = '127.0.0.1', staticDir, pollInterval = 250 } = options;
  backfillTokens(store);
  backfillValidation(store);
  const clients = new Set<{ res: ServerResponse; sessionId: number | undefined }>();

  const send = (res: ServerResponse, event: ServerEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // One poller for all connected clients: forward new messages, and the session
  // list whenever it changes (new session, exit, message counts).
  let lastId = store.idBeforeLast(0);
  let lastSessions = '';
  const poll = setInterval(() => {
    if (clients.size === 0) {
      lastId = store.idBeforeLast(0);
      return;
    }
    const fresh = store.messagesAfter(lastId, { limit: 1000 });
    if (fresh.length > 0) {
      lastId = fresh.at(-1)!.id;
      const summaries = fresh.map(toSummary);
      for (const client of clients) {
        const messages =
          client.sessionId === undefined ? summaries : summaries.filter((m) => m.session_id === client.sessionId);
        if (messages.length > 0) send(client.res, { type: 'messages', messages });
      }
    }
    const sessions = store.listSessions(200);
    const signature = JSON.stringify(sessions);
    if (signature !== lastSessions) {
      lastSessions = signature;
      for (const client of clients) send(client.res, { type: 'sessions', sessions });
    }
  }, pollInterval);

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  });

  /**
   * Replay starts processes and sends them arbitrary arguments, so beyond the
   * Host check it must be impossible to trigger from another site: browsers
   * can't send the custom header or a JSON content type cross-origin without
   * a CORS preflight, which this server never approves.
   */
  async function handleReplay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.readOnly) {
      json(res, 403, { error: 'replay is disabled (mcpspy ui --read-only)' });
      return;
    }
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    if (
      req.headers['x-mcpspy'] !== '1' ||
      !req.headers['content-type']?.startsWith('application/json') ||
      (origin !== undefined && !isLoopbackOrigin(origin, (server.address() as AddressInfo).port)) ||
      (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')
    ) {
      json(res, 403, { error: 'replay requests must come from the mcpspy UI' });
      return;
    }

    let body: { messageId?: unknown; params?: unknown; repeat?: unknown };
    try {
      body = JSON.parse(await readBody(req, 1024 * 1024)) as typeof body;
    } catch (error) {
      json(res, 400, { error: `bad request body: ${(error as Error).message}` });
      return;
    }
    if (typeof body.messageId !== 'number') {
      json(res, 400, { error: 'messageId is required' });
      return;
    }
    const repeat = typeof body.repeat === 'number' ? Math.min(Math.max(1, Math.floor(body.repeat)), 100) : 1;

    try {
      json(res, 200, await replay({ store, messageId: body.messageId, params: body.params, repeat }));
    } catch (error) {
      const sessionId = error instanceof ReplayError ? error.sessionId : null;
      json(res, error instanceof ReplayError ? 422 : 500, { error: (error as Error).message, sessionId });
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopbackHost(req.headers.host)) {
      json(res, 403, { error: 'mcpspy only answers requests addressed to localhost' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/replay') {
      void handleReplay(req, res);
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }

    if (url.pathname === '/api/sessions') {
      json(res, 200, store.listSessions(200));
      return;
    }

    if (url.pathname === '/api/messages') {
      const sessionId = optionalInt(url.searchParams.get('session'));
      const tail = optionalInt(url.searchParams.get('tail')) ?? 2000;
      const after = store.idBeforeLast(tail, sessionId);
      json(res, 200, store.messagesAfter(after, { sessionId, limit: tail }).map(toSummary));
      return;
    }

    const tools = /^\/api\/sessions\/(\d+)\/tools$/.exec(url.pathname);
    if (tools) {
      const sessionId = Number(tools[1]);
      if (!store.getSession(sessionId)) {
        json(res, 404, { error: 'no such session' });
        return;
      }
      json(res, 200, toolsReport(store, sessionId));
      return;
    }

    const detail = /^\/api\/messages\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const message = store.getMessage(Number(detail[1]));
      if (!message) {
        json(res, 404, { error: 'no such message' });
        return;
      }
      const request =
        message.kind === 'request' ? message : message.request_id !== null ? (store.getMessage(message.request_id) ?? null) : null;
      const response = message.kind === 'request' ? (store.responseTo(message.id) ?? null) : message.request_id !== null ? message : null;
      json(res, 200, { message, request, response } satisfies MessageDetail);
      return;
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const client = { res, sessionId: optionalInt(url.searchParams.get('session')) };
      clients.add(client);
      // Catch up on anything recorded between the client's initial fetch and now.
      const after = optionalInt(url.searchParams.get('after'));
      if (after !== undefined) {
        const missed = store.messagesAfter(after, { sessionId: client.sessionId, limit: 5000 }).filter((m) => m.id <= lastId);
        if (missed.length > 0) send(res, { type: 'messages', messages: missed.map(toSummary) });
      }
      send(res, { type: 'sessions', sessions: store.listSessions(200) });
      req.on('close', () => clients.delete(client));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      json(res, 404, { error: 'not found' });
      return;
    }

    serveStatic(url.pathname, res);
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    if (staticDir === null) {
      json(res, 404, { error: 'web UI not built; run npm run build' });
      return;
    }
    const root = resolve(staticDir);
    let file = resolve(join(root, normalize(decodeURIComponent(pathname))));
    if (file !== root && !file.startsWith(root + sep)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    // Single-page app: unknown paths get index.html.
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) {
      json(res, 404, { error: 'web UI not built; run npm run build' });
      return;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7777, host, () => resolvePromise());
  });
  const { port } = server.address() as AddressInfo;

  return {
    server,
    url: `http://${host === '127.0.0.1' || host === '::1' ? 'localhost' : host}:${port}`,
    close: () =>
      new Promise((resolvePromise) => {
        clearInterval(poll);
        for (const client of clients) client.res.end();
        server.close(() => resolvePromise());
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(body));
}

function optionalInt(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isLoopbackOrigin(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && isLoopbackHost(url.host) && Number(url.port || 80) === port;
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}
