import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small MCP server over HTTP for proxy tests. /mcp speaks Streamable HTTP
 * (JSON or SSE replies, a GET stream, sessions); /sse + /messages speak the
 * legacy HTTP+SSE transport.
 */
export async function startHttpFixture(): Promise<{ url: string; origin: string; close(): Promise<void>; deleted: string[] }> {
  let nextSession = 1;
  const sessions = new Set<string>();
  const deleted: string[] = [];
  const waiting = new Map<string, (message: Record<string, unknown>) => void>();
  const legacyStreams = new Map<string, ServerResponse>();
  let origin = '';

  const tools = [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];

  const sse = (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    return (message: unknown, event?: string) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(message)}\n\n`);
  };

  async function answer(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const { id, method, params } = message as { id: unknown; method: string; params?: { name?: string; arguments?: { text?: string } } };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
    if (method === 'tools/call' && params?.name === 'echo') {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: params.arguments?.text ?? '' }] } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown: ${method}` } };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await read(req);
    const message = body ? (JSON.parse(body) as Record<string, unknown>) : null;

    if (url.pathname === '/sse' && req.method === 'GET') {
      const id = `L${nextSession++}`;
      legacyStreams.set(id, res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // An absolute URL, which the proxy must point back at itself.
      res.write(`event: endpoint\ndata: ${origin}/messages?sessionId=${id}\n\n`);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const stream = legacyStreams.get(url.searchParams.get('sessionId') ?? '');
      if (!stream) return void res.writeHead(404).end('no such session');
      res.writeHead(202).end();
      if (message && 'id' in message && 'method' in message) {
        const reply = message.method === 'initialize' ? { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'legacy', version: '1' } } } : await answer(message);
        stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      }
      return;
    }
    if (url.pathname !== '/mcp') return void res.writeHead(404).end();

    const session = req.headers['mcp-session-id'] as string | undefined;
    if (req.method === 'DELETE') {
      deleted.push(session ?? '');
      sessions.delete(session ?? '');
      return void res.writeHead(200).end();
    }
    if (req.method === 'GET') {
      if (!session || !sessions.has(session)) return void res.writeHead(400).end('missing session');
      const send = sse(res);
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello from the GET stream' } });
      return;
    }
    if (!message) return void res.writeHead(400).end('no body');

    if (message.method === 'initialize') {
      const id = `S${nextSession++}`;
      sessions.add(id);
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
      return void res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }));
    }
    if (!session || !sessions.has(session)) return void res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad Request: no valid session ID');

    // A reply to one of our requests, or a notification.
    if (!('method' in message) || !('id' in message)) {
      if ('id' in message) waiting.get(String(message.id))?.(message);
      return void res.writeHead(202).end();
    }

    const params = message.params as { name?: string } | undefined;
    if (message.method === 'tools/list') {
      // Answered over SSE, as many servers do.
      const send = sse(res);
      send(await answer(message));
      return void res.end();
    }
    if (message.method === 'tools/call' && params?.name === 'roots') {
      // Ask the client something mid-call, on this call's stream, and wait for its POSTed answer.
      const send = sse(res);
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 0.5 } });
      const asked = new Promise<Record<string, unknown>>((resolve) => waiting.set('ask-1', resolve));
      send({ jsonrpc: '2.0', id: 'ask-1', method: 'roots/list' });
      const reply = await asked;
      const roots = (reply.result as { roots: unknown[] }).roots;
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${roots.length} roots` }] } });
      return void res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await answer(message)));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    deleted,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString()));
    req.on('end', () => resolve(text));
  });
}
