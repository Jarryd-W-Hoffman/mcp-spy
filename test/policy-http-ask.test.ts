import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePolicy, PolicyEngine, type PolicyFile } from '../src/policy.js';
import { POLICY_ERROR } from '../src/proxy/interceptor.js';
import { startHttpProxy, type HttpProxy } from '../src/proxy/http.js';
import { SseParser } from '../src/sse.js';
import { Store } from '../src/store.js';

type Message = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** A Streamable HTTP server whose answer to each call the test chooses; it keeps every message it receives. */
async function upstream() {
  const received: Message[] = [];
  let reply: (req: IncomingMessage, res: ServerResponse, message: Message) => void = (_req, res, message) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'searched' }] } }));
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const message = JSON.parse(body) as Message;
      received.push(message);
      if (message.method === 'initialize') {
        return void res
          .writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'S' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'up', version: '1' } } }));
      }
      if (message.id === undefined || message.method === undefined) return void res.writeHead(202).end();
      reply(req, res, message);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    received,
    answerWith: (handler: typeof reply) => (reply = handler),
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('HTTP proxy: ask rules', () => {
  let store: Store;
  let up: Awaited<ReturnType<typeof upstream>>;
  let proxy: HttpProxy;
  const warnings: string[] = [];
  const policy: PolicyFile = {
    default: 'allow',
    rules: [
      { name: 'searches', tool: 'search', ask: 'Search?' },
      { name: 'listing', method: 'tools/list', ask: 'List tools?' },
      { name: 'reading', method: 'resources/read', ask: 'Read it?' },
    ],
    results: { redact: ['secret-\\d+'] },
  };

  beforeEach(async () => {
    store = new Store(':memory:');
    up = await upstream();
    warnings.length = 0;
    proxy = await startHttpProxy({
      upstream: up.url,
      store,
      port: 0,
      askTimeoutMs: 300,
      policy: new PolicyEngine(null, 'remote', '/', () => {}, parsePolicy(JSON.stringify(policy), '/')),
      warn: (message) => warnings.push(message),
    });
  });
  afterEach(async () => {
    await proxy.close();
    await up.close();
    store.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    fetch(proxy.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'S', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  const initialize = (capabilities: object = { elicitation: {} }) => post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities } });
  /**
   * Makes a call and reads its event stream, giving each ask to `onAsk` as it arrives.
   * Resolves with every message the agent received.
   */
  const ask = async (body: unknown, onAsk: (ask: Message) => void | Promise<void> = () => {}) => {
    const response = await post(body);
    const messages: Message[] = [];
    const parser = new SseParser((event) => {
      const message = JSON.parse(event.data!) as Message;
      messages.push(message);
      if (message.method === 'elicitation/create') void onAsk(message);
    });
    for await (const chunk of response.body!) parser.push(Buffer.from(chunk));
    return messages;
  };
  const answer = (askMessage: Message, action: string) => post({ jsonrpc: '2.0', id: askMessage.id, result: { action, content: {} } });
  const searches = () => up.received.filter((message) => message.method === 'tools/call');

  it('holds the call, asks on its stream, and forwards it once the user accepts', async () => {
    await initialize();
    up.answerWith((_req, res, message) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'found secret-7' }] } })),
    );
    let answered: Response | undefined;
    const messages = await ask(call(1, 'search', { q: 'x' }), async (asked) => {
      // Nothing reaches the server while the call is held.
      expect(searches()).toEqual([]);
      answered = await answer(asked, 'accept');
    });
    expect(answered!.status).toBe(202);
    expect(messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 'mcpspy-ask-1',
        method: 'elicitation/create',
        params: { message: 'Search?\n\nmcpspy is holding tools/call search {"q":"x"}. Accept to let it through.', requestedSchema: { type: 'object', properties: {} } },
      },
      { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'found [redacted by policy]' }] } },
    ]);
    // The server got the call, and never the answer, which was for mcpspy.
    expect(up.received.map((message) => message.method ?? message.id)).toEqual(['initialize', 'tools/call']);
    expect(warnings).toEqual(['policy approved tools/call search (searches) after asking']);
    const recorded = store.messagesAfter(0).map((message) => [message.direction, message.method, message.mock]);
    expect(recorded).toEqual([
      ['client', 'initialize', null],
      ['server', 'initialize', null],
      ['client', 'tools/call', null],
      ['server', 'elicitation/create', 'policy: searches'],
      ['client', 'elicitation/create', null],
      ['server', 'tools/call', 'policy: result redacted'],
    ]);
  });

  it('streams a reply the server sends as events, and refuses replies it cannot check or read', async () => {
    await initialize();
    const accept = (asked: Message) => void answer(asked, 'accept');
    up.answerWith((_req, res, message) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } })}\n\n`);
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'secret-1' }] } })}\n\n`);
    });
    expect((await ask(call(1, 'search'), accept)).slice(1)).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } },
      { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[redacted by policy]' }] } },
    ]);

    up.answerWith((_req, res, message) =>
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }))),
    );
    expect((await ask(call(2, 'search'), accept)).at(-1)).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [] } });

    const refusedWith = (id: number, why: string) => ({ jsonrpc: '2.0', id, error: { code: POLICY_ERROR, message: `Blocked by mcpspy policy: ${why}` } });
    up.answerWith((_req, res) => res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end('not gzip'));
    await expect(ask(call(7, 'search'), accept)).rejects.toThrow(); // a corrupt body resets the stream
    up.answerWith((_req, res) => res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'zstd' }).end('??'));
    expect((await ask(call(3, 'search'), accept)).at(-1)).toEqual(refusedWith(3, "mcpspy's policy can't check a reply compressed with zstd"));
    up.answerWith((_req, res) => res.writeHead(500, 'Internal Server Error', { 'content-type': 'text/plain' }).end('down'));
    expect((await ask(call(4, 'search'), accept)).at(-1)).toEqual(refusedWith(4, 'the server answered 500 Internal Server Error'));
    up.answerWith((_req, res) => res.writeHead(502, 'Bad Gateway').end());
    expect((await ask(call(5, 'search'), accept)).at(-1)).toEqual(refusedWith(5, 'the server answered 502 Bad Gateway'));
    up.answerWith((req) => req.socket.destroy());
    expect((await ask(call(6, 'search'), accept)).at(-1)).toMatchObject({ id: 6, error: { message: expect.stringMatching(/^Blocked by mcpspy policy: mcpspy could not reach http:\/\/127\.0\.0\.1:\d+: /) } });

    const logs = store.messagesAfter(0).filter((message) => message.direction === 'stderr').map((message) => message.payload);
    expect(logs).toEqual([
      '[http] 500 Internal Server Error for POST /mcp: down',
      '[http] 502 Bad Gateway for POST /mcp',
      expect.stringMatching(/^\[http\] POST http:\/\/127\.0\.0\.1:\d+\/mcp failed: /),
    ]);
    expect(warnings).toContain("policy: refused a reply compressed with zstd, which mcpspy can't read");
  });

  it('holds other methods too, and shapes a tool list let through', async () => {
    await initialize();
    const accept = (asked: Message) => void answer(asked, 'accept');
    up.answerWith((_req, res, message) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list' ? { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } : { contents: [] } })),
    );
    expect((await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, accept)).at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } });
    expect((await ask({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'x' } }, accept)).at(-1)).toEqual({ jsonrpc: '2.0', id: 2, result: { contents: [] } });
  });

  it('refuses the call when the user declines or nobody answers, dropping a late answer', async () => {
    await initialize();
    const declined = await ask(call(1, 'search'), (asked) => void answer(asked, 'decline'));
    expect(declined.at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Blocked by mcpspy policy: Search? (the user declined)' }], isError: true } });

    let late: Message | undefined;
    const timedOut = await ask(call(2, 'search'), (asked) => void (late = asked));
    expect(timedOut.slice(1)).toEqual([
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'mcpspy-ask-2', reason: 'no answer in time' } },
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Blocked by mcpspy policy: Search? (no answer in time)' }], isError: true } },
    ]);
    expect((await answer(late!, 'accept')).status).toBe(202);
    expect(searches()).toEqual([]);
    expect(up.received.some((message) => message.id === 'mcpspy-ask-2')).toBe(false);
    expect(warnings).toEqual(['policy denied tools/call search (searches) after asking: the user declined', 'policy denied tools/call search (searches) after asking: no answer in time']);
  });

  it('drops a held call the agent cancels or walks away from', async () => {
    await initialize();
    const cancelled = await ask(call(1, 'search'), () => void post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }));
    expect(cancelled.slice(1)).toEqual([{ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'mcpspy-ask-1', reason: 'the agent cancelled it' } }]);

    const aborted = new AbortController();
    const response = await post(call(2, 'search'), {}, aborted.signal);
    const reader = response.body!.getReader();
    await reader.read(); // the ask
    aborted.abort();
    await expect.poll(() => warnings.at(-1)).toBe('policy denied tools/call search (searches) after asking: the agent closed the connection');
    // A cancellation for a call nothing holds is just forwarded.
    expect((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } })).status).toBe(202);
    expect(searches()).toEqual([]);
    expect(up.received.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: 9 } });
  });

  it("refuses instead when the agent can't be asked", async () => {
    const reason = (body: unknown) => (body as Message).result!.content as { text: string }[];
    // No elicitation declared.
    await initialize({});
    expect(reason(await (await post(call(1, 'search'))).json())[0]!.text).toBe("Blocked by mcpspy policy: needs approval (Search?), but the agent can't be asked");
    // Elicitation, but no event stream accepted.
    await initialize();
    expect(reason(await (await post(call(2, 'search'), { accept: 'application/json' })).json())[0]!.text).toBe(
      "Blocked by mcpspy policy: needs approval (Search?), but the agent can't be asked",
    );
    // A notification can't be held: there's nothing to answer.
    expect((await post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'search' } })).status).toBe(202);
    // An answer to nothing mcpspy asked goes to the server, which may have asked.
    expect((await post({ jsonrpc: '2.0', id: 'srv-1', result: {} })).status).toBe(202);
    expect(up.received.at(-1)).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: {} });
    expect(searches()).toEqual([]);
  });

  it('waits two minutes for an answer by default, and refuses asking on the legacy transport', async () => {
    const legacy = createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return void res.write('event: endpoint\ndata: /messages?sessionId=1\n\n');
      }
      res.writeHead(202).end();
    });
    await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(legacy.address() as AddressInfo).port}`;
    const other = await startHttpProxy({ upstream: `${origin}/sse`, store, port: 0, policy: new PolicyEngine(null, 'remote', '/', () => {}, parsePolicy(JSON.stringify(policy), '/')), warn: () => {} });
    try {
      const local = new URL(other.url).origin;
      const stream = await fetch(`${local}/sse`);
      const reader = stream.body!.getReader();
      await reader.read(); // the endpoint event, which ties /messages?sessionId=1 to this session
      const send = (body: unknown) => fetch(`${local}/messages?sessionId=1`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
      await send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: { elicitation: {} } } });
      const refused = (await (await send(call(1, 'search'))).json()) as Message;
      expect((refused.result!.content as { text: string }[])[0]!.text).toBe('Blocked by mcpspy policy: needs approval (Search?), but asking needs Streamable HTTP');
      await reader.cancel();
    } finally {
      await other.close();
      legacy.closeAllConnections();
      legacy.close();
    }

    // Streamable HTTP, with the default wait: answered at once, so it never runs out.
    const patient = await startHttpProxy({ upstream: up.url, store, port: 0, policy: new PolicyEngine(null, 'remote', '/', () => {}, parsePolicy(JSON.stringify(policy), '/')), warn: () => {} });
    try {
      const at = (body: unknown) => fetch(patient.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'S' }, body: JSON.stringify(body) });
      await at({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: { elicitation: {} } } });
      const response = await at(call(1, 'search'));
      const events: Message[] = [];
      const parser = new SseParser((event) => {
        const message = JSON.parse(event.data!) as Message;
        events.push(message);
        if (message.method === 'elicitation/create') void at({ jsonrpc: '2.0', id: message.id, result: { action: 'accept' } });
      });
      for await (const chunk of response.body!) parser.push(Buffer.from(chunk));
      expect(events.at(-1)).toMatchObject({ id: 1, result: { content: [{ text: 'searched' }] } });
    } finally {
      await patient.close();
    }
  });
});
