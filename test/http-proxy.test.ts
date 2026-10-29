import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockEngine } from '../src/mocks.js';
import { startHttpProxy, type HttpProxy } from '../src/proxy/http.js';
import { SseParser, type SseEvent } from '../src/sse.js';
import { Store } from '../src/store.js';
import { startHttpFixture } from './fixtures/http-server.js';

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;

/** Reads SSE events from a fetch response as they arrive. */
function events(response: Response): { next(): Promise<SseEvent> } {
  const queue: SseEvent[] = [];
  let wake: (() => void) | null = null;
  const parser = new SseParser((event) => {
    queue.push(event);
    wake?.();
  });
  void (async () => {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) parser.push(chunk);
  })().catch(() => {});
  return {
    async next() {
      while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      return queue.shift()!;
    },
  };
}

describe('HTTP proxy', () => {
  let store: Store;
  let fixture: Fixture;
  let proxy: HttpProxy;

  beforeEach(async () => {
    store = new Store(':memory:');
    fixture = await startHttpFixture();
  });
  afterEach(async () => {
    await proxy?.close();
    await fixture.close();
    store.close();
  });

  const post = (body: unknown, session?: string, url = proxy.url) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(body),
    });

  it('records a Streamable HTTP session: JSON and SSE replies, server requests, the GET stream and DELETE', async () => {
    proxy = await startHttpProxy({ upstream: fixture.url, store, name: 'remote', port: 0 });
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const session = init.headers.get('mcp-session-id')!;
    expect(session).toBe('S1');
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: 'fixture' } } });
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)).status).toBe(202);

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
    expect(list.headers.get('content-type')).toBe('text/event-stream');
    expect(JSON.parse((await events(list).next()).data!)).toMatchObject({ id: 2, result: { tools: [{ name: 'echo' }] } });

    // The server asks for roots in the middle of the call; the client answers with a POST.
    const call = events(await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'roots', arguments: {} } }, session));
    expect(JSON.parse((await call.next()).data!)).toMatchObject({ method: 'notifications/progress' });
    expect(JSON.parse((await call.next()).data!)).toMatchObject({ id: 'ask-1', method: 'roots/list' });
    expect((await post({ jsonrpc: '2.0', id: 'ask-1', result: { roots: [{ uri: 'file:///a' }, { uri: 'file:///b' }] } }, session)).status).toBe(202);
    expect(JSON.parse((await call.next()).data!)).toMatchObject({ id: 3, result: { content: [{ text: '2 roots' }] } });

    const stream = await fetch(proxy.url, { headers: { accept: 'text/event-stream', 'mcp-session-id': session } });
    expect(JSON.parse((await events(stream).next()).data!)).toMatchObject({ method: 'notifications/message' });

    const bad = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 1 } } }, 'nope');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe('Bad Request: no valid session ID');

    expect((await fetch(proxy.url, { method: 'DELETE', headers: { 'mcp-session-id': session } })).status).toBe(200);
    expect(fixture.deleted).toEqual(['S1']);

    const [first, second] = store.listSessions();
    // The unknown session id became its own session, holding the 400.
    expect(second).toMatchObject({ name: 'remote', transport: 'http', command: JSON.stringify([fixture.url]) });
    expect(second!.ended_at).not.toBeNull();
    expect(first!.transport).toBe('http');

    const messages = store.messagesAfter(0, { sessionId: second!.id });
    const summary = messages.map((m) => [m.direction, m.kind, m.method, m.rpc_id]);
    expect(summary).toEqual([
      ['client', 'request', 'initialize', '1'],
      ['server', 'response', 'initialize', '1'],
      ['client', 'notification', 'notifications/initialized', null],
      ['client', 'request', 'tools/list', '2'],
      ['server', 'response', 'tools/list', '2'],
      ['client', 'request', 'tools/call', '3'],
      ['server', 'notification', 'notifications/progress', null],
      ['server', 'request', 'roots/list', '"ask-1"'],
      ['client', 'response', 'roots/list', '"ask-1"'],
      ['server', 'response', 'tools/call', '3'],
      ['server', 'notification', 'notifications/message', null],
    ]);
    expect(messages.find((m) => m.method === 'tools/list' && m.direction === 'server')!.tokens).toBeGreaterThan(0);

    const orphan = store.messagesAfter(0, { sessionId: first!.id });
    expect(orphan.map((m) => [m.direction, m.kind])).toEqual([
      ['client', 'request'],
      ['stderr', 'log'],
    ]);
    expect(orphan[1]!.payload).toBe('[http] 400 Bad Request for POST /mcp: Bad Request: no valid session ID');
  });

  it('records the legacy HTTP+SSE transport and points its endpoint at the proxy', async () => {
    proxy = await startHttpProxy({ upstream: `${fixture.origin}/sse`, store, port: 0 });
    const stream = events(await fetch(proxy.url, { headers: { accept: 'text/event-stream' } }));
    const endpoint = await stream.next();
    expect(endpoint.event).toBe('endpoint');
    const postUrl = endpoint.data!;
    expect(postUrl).toBe(`http://127.0.0.1:${proxy.port}/messages?sessionId=L1`);

    expect((await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, undefined, postUrl)).status).toBe(202);
    expect(JSON.parse((await stream.next()).data!)).toMatchObject({ id: 1, result: { serverInfo: { name: 'legacy' } } });
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }, undefined, postUrl);
    expect(JSON.parse((await stream.next()).data!)).toMatchObject({ id: 2, result: { content: [{ text: 'hi' }] } });

    const [session] = store.listSessions();
    expect(session).toMatchObject({ transport: 'sse', name: new URL(fixture.origin).host });
    const messages = store.messagesAfter(0, { sessionId: session!.id });
    expect(messages.map((m) => [m.direction, m.method, m.latency_ms !== null])).toEqual([
      ['client', 'initialize', false],
      ['server', 'initialize', true],
      ['client', 'tools/call', false],
      ['server', 'tools/call', true],
    ]);
  });

  it('drops headers that the Connection header names as hop-by-hop', async () => {
    proxy = await startHttpProxy({ upstream: fixture.url, store, port: 0 });
    const { request } = await import('node:http');
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const req = request(proxy.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', connection: 'keep-alive, x-hop', 'x-hop': 'one hop only', 'x-end': 'kept' },
      });
      req.on('response', (res) => res.resume().on('end', resolve)).on('error', reject).end(body);
    });
    expect(fixture.received[0]).toMatchObject({ 'x-end': 'kept' });
    expect(fixture.received[0]).not.toHaveProperty('x-hop');
  });

  it('applies mock rules to HTTP traffic', async () => {
    const mocks = new MockEngine(null, null, () => {}, {
      tools: [{ name: 'weather', inputSchema: { type: 'object' } }],
      rules: [
        { name: 'weather', match: { tool: 'weather' }, text: 'Sunny' },
        { name: 'slow', match: { tool: 'echo', arguments: { text: 'slow' } }, passthrough: true, delayMs: 60 },
      ],
    });
    proxy = await startHttpProxy({ upstream: fixture.url, store, port: 0, mocks });
    const session = (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).headers.get('mcp-session-id')!;

    const list = JSON.parse((await events(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).next()).data!) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['echo', 'weather']);

    const mocked = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'weather', arguments: {} } }, session);
    expect(mocked.headers.get('mcp-session-id')).toBe(session);
    expect(await mocked.json()).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Sunny' }] } });

    const started = performance.now();
    const slow = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'slow' } } }, session);
    expect(await slow.json()).toMatchObject({ result: { content: [{ text: 'slow' }] } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);

    const responses = store.messagesAfter(0, {}).filter((m) => m.direction === 'server');
    expect(responses.map((m) => [m.rpc_id, m.mock])).toEqual([
      ['1', null],
      ['2', 'mock tools'],
      ['3', 'weather'],
      ['4', 'slow'],
    ]);
  });

  it('refuses requests a web page could send, and reports an unreachable server', async () => {
    proxy = await startHttpProxy({ upstream: fixture.url, store, port: 0 });
    const foreign = await fetch(proxy.url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(foreign.status).toBe(403);
    await fixture.close();
    const down = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(down.status).toBe(502);
    expect(await down.text()).toMatch(/could not reach .*ECONNREFUSED/);
    const [log] = store.messagesAfter(0, {}).filter((m) => m.kind === 'log');
    expect(log!.payload).toMatch(/^\[http\] POST .* failed: ECONNREFUSED$/);
    fixture = await startHttpFixture(); // so afterEach can close something
  });
});

describe('replaying HTTP sessions', () => {
  let store: Store;
  let fixture: Fixture;
  let proxy: HttpProxy;

  beforeEach(async () => {
    store = new Store(':memory:');
    fixture = await startHttpFixture();
  });
  afterEach(async () => {
    await proxy.close();
    await fixture.close();
    store.close();
  });

  const post = (url: string, body: unknown, session?: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(body),
    });

  it('replays Streamable HTTP calls in a new session, answering server requests from the recording', async () => {
    const { replay } = await import('../src/replay.js');
    proxy = await startHttpProxy({ upstream: fixture.url, store, port: 0 });
    const session = (await post(proxy.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 'agent', version: '1' } } })).headers.get('mcp-session-id')!;
    await post(proxy.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const call = events(await post(proxy.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'roots', arguments: {} } }, session));
    await call.next();
    await call.next();
    await post(proxy.url, { jsonrpc: '2.0', id: 'ask-1', result: { roots: [{ uri: 'file:///only' }] } }, session);
    await call.next();
    await post(proxy.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }, session);

    const [original] = store.listSessions();
    const requests = store.messagesAfter(0, { sessionId: original!.id }).filter((m) => m.method === 'tools/call' && m.direction === 'client');

    const roots = await replay({ store, messageId: requests[0]!.id });
    expect(roots.runs[0]!.response).toMatchObject({ result: { content: [{ text: '1 roots' }] } });
    const echo = await replay({ store, messageId: requests[1]!.id, params: { name: 'echo', arguments: { text: 'again' } }, repeat: 2 });
    expect(echo.runs.map((run) => (run.response.result as { content: { text: string }[] }).content[0]!.text)).toEqual(['again', 'again']);

    const replayed = store.getSession(echo.sessionId)!;
    expect(replayed).toMatchObject({ transport: 'replay', replay_of: original!.id, env_keys: null });
    expect(fixture.deleted).toEqual(['S2', 'S3']); // each replay ends its own server session

    // Suites keep the URL (never headers) and run over HTTP too.
    const { addCases, emptySuite, runSuite } = await import('../src/suite.js');
    const suite = emptySuite();
    addCases(suite, '/tmp/x/suite.json', store, [requests[0]!.id, requests[1]!.id]);
    expect(Object.values(suite.servers)).toEqual([
      { url: fixture.url, transport: 'http', initialize: expect.objectContaining({ clientInfo: { name: 'agent', version: '1' } }), clientReplies: { 'roots/list': { result: { roots: [{ uri: 'file:///only' }] } } } },
    ]);
    const results = await runSuite(suite, '/tmp/x/suite.json', { headers: { authorization: 'Bearer test' } });
    expect(results.map((result) => result.status)).toEqual(['pass', 'pass']);

    // A replay of a replay still goes over HTTP.
    const again = await replay({ store, messageId: echo.runs[0]!.requestId! });
    expect(again.runs[0]!.response).toMatchObject({ result: { content: [{ text: 'again' }] } });
  });

  it('replays legacy SSE sessions, and explains HTTP errors', async () => {
    const { replay, ReplayError } = await import('../src/replay.js');
    proxy = await startHttpProxy({ upstream: `${fixture.origin}/sse`, store, port: 0 });
    const stream = events(await fetch(proxy.url, { headers: { accept: 'text/event-stream' } }));
    const endpoint = (await stream.next()).data!;
    await post(endpoint, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await stream.next();
    await post(endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'legacy' } } });
    await stream.next();

    const call = store.messagesAfter(0, {}).find((m) => m.method === 'tools/call' && m.direction === 'client')!;
    const result = await replay({ store, messageId: call.id, timeoutMs: 2000 });
    expect(result.runs[0]!.response).toMatchObject({ result: { content: [{ text: 'legacy' }] } });

    // Point the recorded session at a URL that refuses requests.
    const sessionId = call.session_id;
    (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare("UPDATE sessions SET transport = 'http', command = ? WHERE id = ?")
      .run(JSON.stringify([`${fixture.origin}/missing`]), sessionId);
    const failed = replay({ store, messageId: call.id, timeoutMs: 2000 });
    await expect(failed).rejects.toBeInstanceOf(ReplayError);
    await expect(failed).rejects.toThrow(/initialize failed|HTTP 404/);
  });
});
