import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockEngine } from '../src/mocks.js';
import { startHttpProxy, type HttpProxy } from '../src/proxy/http.js';
import { Store } from '../src/store.js';

/** An upstream whose every reply is written by the test. */
async function upstream(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, port, close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

const rpc = (id: number | string, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

describe('HTTP proxy edge cases', () => {
  let store: Store;
  let proxy: HttpProxy | undefined;
  let up: Awaited<ReturnType<typeof upstream>> | undefined;
  const warnings: string[] = [];

  beforeEach(() => {
    store = new Store(':memory:');
    warnings.length = 0;
  });
  afterEach(async () => {
    await proxy?.close();
    await up?.close();
    proxy = undefined;
    up = undefined;
    store.close();
  });

  const start = async (handler: Parameters<typeof upstream>[0], options: Partial<Parameters<typeof startHttpProxy>[0]> = {}) => {
    up = await upstream(handler);
    proxy = await startHttpProxy({ upstream: up.url, store, port: 0, warn: (message) => warnings.push(message), ...options });
    return proxy;
  };
  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(proxy!.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body });
  const logs = () => store.messagesAfter(0).filter((message) => message.direction === 'stderr').map((message) => message.payload);

  it('refuses URLs that are not http(s), and warns on stderr by default', async () => {
    await expect(startHttpProxy({ upstream: 'ftp://x/mcp', store })).rejects.toThrow('ftp://x/mcp is not an http(s) URL');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      up = await upstream((_req, res) => res.end());
      proxy = await startHttpProxy({ upstream: up.url, store, port: 0 });
      vi.spyOn(store, 'insertMessage').mockImplementation(() => {
        throw new Error('disk full');
      });
      await (await post(rpc(1, 'initialize'))).text();
      await (await post(rpc(2, 'ping'))).text();
      expect(write.mock.calls.filter(([text]) => String(text).includes('recording stopped, still proxying: disk full'))).toHaveLength(1);
    } finally {
      write.mockRestore();
    }
  });

  it('only proxies paths on the upstream, so an -H token never goes elsewhere', async () => {
    const elsewhere = await upstream((req, res) => res.end(`elsewhere saw ${req.headers.authorization}`));
    try {
      await start((req, res) => res.end(`upstream ${req.url}`), { headers: { Authorization: 'Bearer secret' } });
      const { port } = new URL(proxy!.url);
      const raw = (path: string) =>
        new Promise<[number, string]>((resolve, reject) => {
          request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString()));
            res.on('end', () => resolve([res.statusCode!, body]));
          })
            .on('error', reject)
            .end();
        });
      const refused = [400, `mcpspy only proxies paths on http://127.0.0.1:${up!.port}`];
      for (const path of [`http://127.0.0.1:${elsewhere.port}/steal`, `//127.0.0.1:${elsewhere.port}/steal`, `/\\127.0.0.1:${elsewhere.port}/steal`]) {
        expect(await raw(path)).toEqual(refused);
      }
      // An absolute target naming the upstream itself is still a request off a path, so it's refused too.
      expect(await raw(`http://127.0.0.1:${up!.port}/mcp`)).toEqual(refused);
      expect(await raw('/mcp?x=1')).toEqual([200, 'upstream /mcp?x=1']);
    } finally {
      await elsewhere.close();
    }
  });

  it('reaches https upstreams, reporting TLS failures', async () => {
    up = await upstream((_req, res) => res.end('plain'));
    proxy = await startHttpProxy({ upstream: up.url.replace('http:', 'https:'), store, port: 0, warn: (message) => warnings.push(message) });
    const response = await post(rpc(1, 'initialize'));
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/^mcpspy could not reach https:\/\/127\.0\.0\.1:\d+: /);
  });

  it('answers 502 when reading the request or starting the upstream request fails', async () => {
    await start((_req, res) => res.end(), { headers: { 'x-bad': 'line\nbreak' } });
    const response = await post(rpc(1, 'initialize'));
    expect(response.status).toBe(502);
    expect(warnings).toEqual([expect.stringMatching(/^proxy error: /)]);
  });

  it('refuses origins it cannot parse', async () => {
    await start((_req, res) => res.end());
    expect((await post(rpc(1, 'ping'), { origin: 'not a url' })).status).toBe(403);
  });

  it('decodes compressed replies, so they are recorded and the agent gets them plain', async () => {
    const bodies: Record<string, [string, Buffer]> = {
      gzip: ['gzip', gzipSync('{"jsonrpc":"2.0","id":1,"result":{}}')],
      br: ['br', brotliCompressSync('server exploded')],
      deflate: ['deflate', deflateSync('x')],
      identity: ['identity', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}')],
    };
    await start((req, res) => {
      const [encoding, body] = bodies[req.headers['x-want'] as string]!;
      res.writeHead(encoding === 'br' ? 500 : 200, { 'content-type': 'application/json', 'content-encoding': encoding }).end(body);
    });
    for (const want of Object.keys(bodies)) {
      const response = await post(rpc(1, 'initialize'), { 'x-want': want });
      expect(response.headers.get('content-encoding')).toBe(want === 'identity' ? 'identity' : null);
      await response.arrayBuffer();
    }
    expect(logs()).toEqual(['[http] 500 Internal Server Error for POST /mcp: server exploded']);
    expect(store.messagesAfter(0).filter((message) => message.direction === 'server')).toHaveLength(2);
  });

  it('passes replies in encodings it cannot read through untouched, and resets corrupt ones', async () => {
    await start((req, res) => {
      if (req.headers['x-want'] === 'corrupt') return res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end('not gzip');
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'x-opaque' }).end('opaque');
    });
    const response = await fetch(proxy!.url, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' }, body: rpc(1, 'initialize') });
    expect(response.headers.get('content-encoding')).toBe('x-opaque');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('opaque');
    await expect(post(rpc(2, 'ping'), { 'x-want': 'corrupt' }).then((reply) => reply.text())).rejects.toThrow();
  });

  it('records an empty error body without detail', async () => {
    await start((_req, res) => res.writeHead(500).end());
    await (await post(rpc(1, 'initialize'))).text();
    expect(logs()).toEqual(['[http] 500 Internal Server Error for POST /mcp']);
  });

  it('records batch replies and ignores events it cannot use', async () => {
    await start((req, res, body) => {
      if (body.startsWith('[')) return res.writeHead(200, { 'content-type': 'application/json' }).end('[{"jsonrpc":"2.0","id":1,"result":{}}]');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: ping\ndata: x\n\ndata: \n\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n');
    });
    await (await post(`[${rpc(1, 'initialize')}]`)).text();
    const stream = await (await post(rpc(2, 'ping'))).text();
    expect(stream).toContain('event: ping');
    expect(store.messagesAfter(0).filter((message) => message.direction === 'server').map((message) => message.rpc_id)).toEqual(['1', '2']);
  });

  it('reads compressed event streams for legacy sessions, and leaves foreign endpoints alone', async () => {
    await start((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
      res.end(gzipSync(`event: endpoint\ndata: https://elsewhere.example/messages\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n`));
    });
    const response = await fetch(proxy!.url, { headers: { accept: 'text/event-stream', 'accept-encoding': 'gzip' } });
    await response.arrayBuffer();
    await vi.waitFor(() => expect(store.messagesAfter(0).some((message) => message.method === 'notifications/message')).toBe(true));
    expect(store.listSessions()[0]).toMatchObject({ transport: 'sse' });
  });

  it('records a GET stream for a session that began before the proxy, in that session', async () => {
    await start((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    await (await fetch(proxy!.url, { headers: { accept: 'text/event-stream', 'mcp-session-id': 'early' } })).text();
    await (await post(rpc(1, 'ping'), { 'mcp-session-id': 'early' })).text();
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ transport: 'http', ended_at: null, message_count: 3 });
  });

  it('passes through event streams it cannot attribute to a session', async () => {
    await start((req, res) => {
      res.writeHead(500, { 'content-type': 'text/event-stream', ...(req.headers['x-gzip'] ? { 'content-encoding': 'gzip' } : {}) });
      const events = 'data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n';
      res.end(req.headers['x-gzip'] ? gzipSync(events) : events);
    });
    for (const extra of [{}, { 'x-gzip': '1' }] as Record<string, string>[]) {
      const response = await fetch(proxy!.url, { headers: { accept: 'text/event-stream', ...extra } });
      expect(response.status).toBe(500);
      await response.arrayBuffer();
    }
    expect(store.listSessions()).toEqual([]);
  });

  it('closes the reply when the upstream drops mid-body', async () => {
    await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"jsonrpc"');
      setTimeout(() => res.socket!.destroy(), 20);
    });
    await expect(post(rpc(1, 'initialize')).then((response) => response.text())).rejects.toThrow();
  });

  it('closes an event stream when the upstream drops it', async () => {
    await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
      setTimeout(() => res.socket!.destroy(), 20);
    });
    await expect(post(rpc(1, 'initialize')).then((response) => response.text())).rejects.toThrow();
  });

  it('ends sessions on DELETE, whichever session is the fallback', async () => {
    let next = 0;
    await start((req, res) => {
      if (req.method === 'DELETE') return res.writeHead(200).end();
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `s${++next}` }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    await (await post(rpc(1, 'initialize'))).text();
    await (await post(rpc(1, 'initialize'))).text();
    for (const session of ['s1', 's2']) await (await fetch(proxy!.url, { method: 'DELETE', headers: { 'mcp-session-id': session } })).text();
    expect(store.listSessions().map((session) => session.ended_at !== null)).toEqual([true, true]);
  });

  it('ends a legacy session on DELETE to its endpoint', async () => {
    await start((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages?s=1\n\n');
        return;
      }
      res.writeHead(200).end();
    });
    const stream = await fetch(proxy!.url, { headers: { accept: 'text/event-stream' } });
    const reader = stream.body!.getReader();
    await reader.read();
    const origin = new URL(proxy!.url).origin;
    await (await fetch(`${origin}/messages?s=1`, { method: 'DELETE' })).text();
    expect(store.listSessions()[0]!.ended_at).not.toBeNull();
    await reader.cancel();
  });

  it('drops requests by rule, patches JSON tool lists and leaves them alone without mock tools', async () => {
    await start(
      (_req, res, body) => {
        const { id } = JSON.parse(body) as { id: number };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'real' }] } }));
      },
      { mocks: new MockEngine(null, null, () => {}, { tools: [{ name: 'fake', inputSchema: { type: 'object' } }], rules: [{ match: { method: 'void' }, drop: true }] }) },
    );
    await (await post(rpc(1, 'initialize'))).text();
    const list = (await (await post(rpc(2, 'tools/list'))).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['real', 'fake']);
    const dropped = await Promise.race([post(rpc(3, 'void')).then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('silent'), 100))]);
    expect(dropped).toBe('silent');
    await (await post('[1]')).text();
  });

  it('adds nothing to tool lists when the mock file has no tools', async () => {
    await start(
      (_req, res, body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(body) as { id: number }).id, result: { tools: [] } })),
      { mocks: new MockEngine(null, null, () => {}, { rules: [] }) },
    );
    expect(await (await post(rpc(1, 'tools/list'))).json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  it('listens on IPv6 loopback, and on port 7800 by default', async () => {
    up = await upstream((_req, res) => res.end());
    proxy = await startHttpProxy({ upstream: up.url, store, port: 0, host: '::1' });
    expect(proxy.url).toMatch(/^http:\/\/\[::1\]:\d+\/mcp$/);
    await proxy.close();
    proxy = undefined;
    const started = await startHttpProxy({ upstream: up.url, store }).then(
      async (fallback) => {
        await fallback.close();
        return fallback.port;
      },
      (error: NodeJS.ErrnoException) => error.code,
    );
    expect([7800, 'EADDRINUSE']).toContain(started);
  });

  it('gives up on a client that disconnects mid-body', async () => {
    await start((_req, res) => res.end());
    const port = Number(new URL(proxy!.url).port);
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: { host: `localhost:${port}`, 'content-length': '1000' } });
      req.on('error', () => resolve());
      req.write('{"partial":');
      setTimeout(() => req.destroy(), 20);
    });
    await vi.waitFor(() => expect(warnings).toEqual([expect.stringMatching(/^proxy error: /)]));
  });
});


describe('HTTP proxy streams', () => {
  let store: Store;
  let proxy: HttpProxy | undefined;
  let up: Awaited<ReturnType<typeof upstream>> | undefined;

  beforeEach(() => (store = new Store(':memory:')));
  afterEach(async () => {
    await proxy?.close();
    await up?.close();
    proxy = undefined;
    up = undefined;
    store.close();
  });

  const start = async (handler: Parameters<typeof upstream>[0]) => {
    up = await upstream(handler);
    proxy = await startHttpProxy({ upstream: up.url, store, port: 0, warn: () => {} });
  };
  const get = (headers: Record<string, string> = {}) => fetch(proxy!.url, { headers: { accept: 'text/event-stream', ...headers } });

  it('ends a legacy session when its stream ends', async () => {
    await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: endpoint\ndata: /messages\n\n');
    });
    await (await get()).text();
    await vi.waitFor(() => expect(store.listSessions()[0]!.ended_at).not.toBeNull());
  });

  it('reads brotli, deflate and corrupt event streams', async () => {
    const events = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n';
    const encoded: Record<string, Buffer> = { br: brotliCompressSync(events), deflate: deflateSync(events), gzip: Buffer.from('not gzip at all') };
    await start((req, res) => {
      const encoding = req.headers['x-want'] as string;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': encoding });
      res.end(encoded[encoding]);
    });
    // fetch decodes too, and rejects the corrupt body; the proxy shrugs it off.
    for (const want of Object.keys(encoded)) await (await get({ 'x-want': want })).arrayBuffer().catch(() => {});
    await vi.waitFor(() => expect(store.messagesAfter(0).filter((message) => message.method === 'notifications/message')).toHaveLength(2));
  });

  it('reports an unreachable upstream for an untracked stream', async () => {
    up = await upstream((_req, res) => res.end());
    await up.close();
    proxy = await startHttpProxy({ upstream: up.url, store, port: 0, warn: () => {} });
    up = undefined;
    const response = await get();
    expect(response.status).toBe(502);
    expect(store.listSessions()).toEqual([]);
  });

  it('stops the upstream request when the client hangs up mid-stream', async () => {
    let closed = false;
    await start((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
      req.on('close', () => (closed = true));
    });
    const response = await fetch(proxy!.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: rpc(1, 'initialize') });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(closed).toBe(true));
  });
});

describe('HTTP proxy session lifetimes', () => {
  let store: Store;
  let proxy: HttpProxy | undefined;
  let up: Awaited<ReturnType<typeof upstream>> | undefined;

  beforeEach(() => (store = new Store(':memory:')));
  afterEach(async () => {
    await proxy?.close();
    await up?.close();
    proxy = undefined;
    up = undefined;
    store.close();
  });

  const start = async (handler: Parameters<typeof upstream>[0], sessionIdleMs?: number) => {
    up = await upstream(handler);
    proxy = await startHttpProxy({ upstream: up.url, store, port: 0, warn: () => {}, sessionIdleMs });
  };
  const post = (body: string, session?: string) =>
    fetch(proxy!.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
      body,
    }).then((response) => response.text());
  const json = (_req: IncomingMessage, res: ServerResponse) => res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
  const ended = () => store.listSessions().map((session) => session.ended_at !== null);

  it('ends sessions that go quiet, and starts a new one if the agent comes back', async () => {
    await start(json, 30);
    await post(rpc(1, 'initialize'));
    await vi.waitFor(() => expect(ended()).toEqual([true]));
    await post(rpc(2, 'ping'), 's1');
    expect(ended()).toEqual([false, true]);
  });

  it('keeps a session while one of its streams is open', async () => {
    await start((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
      }
      json(req, res);
    }, 30);
    await post(rpc(1, 'initialize'));
    const stream = await fetch(proxy!.url, { headers: { accept: 'text/event-stream', 'mcp-session-id': 's1' } });
    const reader = stream.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ended()).toEqual([false]);
    await reader.cancel();
    await vi.waitFor(() => expect(ended()).toEqual([true]));
  });

  it('keeps a session while a request waits for a slow reply', async () => {
    await start((req, res) => {
      if (req.headers['mcp-session-id'] === undefined) return json(req, res);
      setTimeout(() => json(req, res), 150);
    }, 30);
    await post(rpc(1, 'initialize'));
    const slow = post(rpc(2, 'tools/call'), 's1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ended()).toEqual([false]);
    await slow;
    expect(ended()).toEqual([false]);
    expect(store.listSessions()[0]!.message_count).toBe(4);
    await vi.waitFor(() => expect(ended()).toEqual([true]));
  });

  it('records nothing more into a session once it has ended', async () => {
    await start((req, res) => (req.method === 'DELETE' ? res.writeHead(200).end() : json(req, res)));
    await post(rpc(1, 'initialize'));
    await (await fetch(proxy!.url, { method: 'DELETE', headers: { 'mcp-session-id': 's1' } })).text();
    await post(rpc(2, 'ping'), 's1');
    const [newer, older] = store.listSessions();
    expect([newer!.ended_at, older!.message_count]).toEqual([null, 2]);
  });
});
