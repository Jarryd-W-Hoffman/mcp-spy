import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageDetail, MessageSummary, ServerEvent, SessionSummary, ToolsReport } from '../src/api.js';
import { Recorder } from '../src/recorder.js';
import { isLoopbackHost, startUiServer, type UiServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { recordSession } from './helpers.js';

describe('UI server', () => {
  let store: Store;
  let recorder: Recorder;
  let ui: UiServer;
  let staticDir: string;

  beforeEach(async () => {
    store = new Store(':memory:');
    const sessionId = store.createSession({ name: 'echo', transport: 'stdio', command: '["x"]', cwd: '/', pid: 1, started_at: 0 });
    recorder = new Recorder(store, sessionId);
    recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search"}}');
    recorder.frame('server', '{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"nope"}]}}');

    staticDir = mkdtempSync(join(tmpdir(), 'mcpspy-ui-'));
    mkdirSync(join(staticDir, 'assets'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>mcpspy</title>');
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');

    ui = await startUiServer({ store, port: 0, staticDir, pollInterval: 20 });
  });

  afterEach(async () => {
    await ui.close();
    store.close();
  });

  const get = async <T>(path: string): Promise<T> => (await fetch(ui.url + path)).json() as Promise<T>;

  it('lists sessions and message summaries without payloads', async () => {
    const sessions = await get<SessionSummary[]>('/api/sessions');
    expect(sessions).toMatchObject([{ name: 'echo', message_count: 2 }]);

    const messages = await get<MessageSummary[]>('/api/messages');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: 'request', subject: 'search' });
    expect(messages[1]).toMatchObject({ kind: 'response', error: 'tool error: nope', request_id: messages[0]!.id });
    expect(messages[0]).not.toHaveProperty('payload');
  });

  it('returns a message with its request and response', async () => {
    const [request] = await get<MessageSummary[]>('/api/messages');
    const detail = await get<MessageDetail>(`/api/messages/${request!.id}`);
    expect(detail.request?.id).toBe(request!.id);
    expect(JSON.parse(detail.response!.payload)).toMatchObject({ result: { isError: true } });
    expect((await fetch(`${ui.url}/api/messages/999`)).status).toBe(404);
  });

  it('streams new messages to connected clients', async () => {
    const response = await fetch(`${ui.url}/api/events?after=2`);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const events: ServerEvent[] = [];
    let buffer = '';

    const next = async (predicate: (event: ServerEvent) => boolean) => {
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += value;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop()!;
        for (const block of blocks) {
          if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)) as ServerEvent);
        }
      }
    };

    await next((event) => event.type === 'sessions');
    recorder.frame('client', '{"jsonrpc":"2.0","method":"notifications/initialized"}');
    const event = await next((event) => event.type === 'messages');
    expect(event).toMatchObject({ type: 'messages', messages: [{ kind: 'notification', method: 'notifications/initialized' }] });
    await reader.cancel();
  });

  it('serves the built UI with an SPA fallback', async () => {
    expect(await (await fetch(`${ui.url}/`)).text()).toContain('<title>mcpspy</title>');
    expect(await (await fetch(`${ui.url}/sessions/4`)).text()).toContain('<title>mcpspy</title>');
    const asset = await fetch(`${ui.url}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
  });

  it('refuses requests addressed to a non-loopback host', async () => {
    const { port } = new URL(ui.url);
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api/sessions', headers: { host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback names with or without a port', () => {
    expect(isLoopbackHost('localhost:7777')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]:7777')).toBe(true);
    expect(isLoopbackHost('localhost.evil.example')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('UI server tools report', () => {
  it('serves a session tools report', async () => {
    const store = new Store(':memory:');
    const sessionId = store.createSession({ name: 'echo', transport: 'stdio', command: '["x"]', cwd: '/', pid: 1, started_at: 0 });
    const recorder = new Recorder(store, sessionId);
    recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    recorder.frame('server', '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}}');
    const ui = await startUiServer({ store, port: 0, staticDir: null });

    const report = (await (await fetch(`${ui.url}/api/sessions/${sessionId}/tools`)).json()) as ToolsReport;
    expect(report.definitions).toMatchObject({ requestId: 1, tools: [{ name: 'echo' }] });
    expect((await fetch(`${ui.url}/api/sessions/99/tools`)).status).toBe(404);

    const [summary] = (await (await fetch(`${ui.url}/api/messages`)).json()) as MessageSummary[];
    expect(summary).not.toHaveProperty('token_detail');

    await ui.close();
    store.close();
  });
});

describe('UI server paging', () => {
  it('lists older sessions before a given id', async () => {
    const store = new Store(':memory:');
    for (let i = 1; i <= 205; i++) store.createSession({ name: `s${i}`, transport: 'stdio', command: '["x"]', cwd: '/', pid: null, started_at: 0 });
    const ui = await startUiServer({ store, port: 0, staticDir: null });

    const newest = (await (await fetch(`${ui.url}/api/sessions`)).json()) as SessionSummary[];
    expect(newest).toHaveLength(200);
    const older = (await (await fetch(`${ui.url}/api/sessions?before=${newest.at(-1)!.id}`)).json()) as SessionSummary[];
    expect(older.map((session) => session.name)).toEqual(['s5', 's4', 's3', 's2', 's1']);

    await ui.close();
    store.close();
  });

  it('joins a paged tool list for diffs, and only when asked', async () => {
    const store = new Store(':memory:');
    const sessionId = store.createSession({ name: 'paged', transport: 'stdio', command: '["x"]', cwd: '/', pid: 1, started_at: 0 });
    const recorder = new Recorder(store, sessionId);
    const [firstRequest] = recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    recorder.frame('server', '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","inputSchema":{"type":"object"}}],"nextCursor":"2"}}');
    const [secondRequest] = recorder.frame('client', '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"2"}}');
    recorder.frame('server', '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"b","inputSchema":{"type":"object"}}]}}');
    const ui = await startUiServer({ store, port: 0, staticDir: null });
    const tools = async (path: string) => {
      const detail = (await (await fetch(ui.url + path)).json()) as MessageDetail;
      return (JSON.parse(detail.response!.payload) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    };

    expect(await tools(`/api/messages/${firstRequest}`)).toEqual(['a']);
    expect(await tools(`/api/messages/${firstRequest}?listing`)).toEqual(['a', 'b']);
    expect(await tools(`/api/messages/${secondRequest}?listing`)).toEqual(['b']);

    await ui.close();
    store.close();
  });
});

describe('UI server replay', () => {
  it('replays from the UI and refuses anything that could be cross-site', async () => {
    const store = new Store(':memory:');
    const recorded = await recordSession(store);
    const ui = await startUiServer({ store, port: 0, staticDir: null });
    const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', 'x-mcpspy': '1' }) =>
      fetch(`${ui.url}/api/replay`, { method: 'POST', headers, body: JSON.stringify(body) });

    const ok = await post({ messageId: recorded.echo, params: { name: 'echo', arguments: { text: 'from ui' } } });
    expect(ok.status).toBe(200);
    const result = (await ok.json()) as { sessionId: number; runs: { response: unknown }[] };
    expect(result.runs[0]!.response).toMatchObject({ result: { content: [{ text: 'from ui' }] } });
    expect(store.getSession(result.sessionId)?.transport).toBe('replay');

    // A form post or a request without the header is refused.
    expect((await post({ messageId: recorded.echo }, { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await post({ messageId: recorded.echo }, { 'content-type': 'application/json' })).status).toBe(403);
    // So is one from another origin, even with the header.
    expect((await post({ messageId: recorded.echo }, { 'content-type': 'application/json', 'x-mcpspy': '1', origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ messageId: recorded.echo }, { 'content-type': 'application/json', 'x-mcpspy': '1', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // Bad input gets a clear error.
    expect((await post({})).status).toBe(400);
    const notRequest = await post({ messageId: store.responseTo(recorded.echo)!.id });
    expect(notRequest.status).toBe(422);
    expect(await notRequest.json()).toMatchObject({ error: expect.stringMatching(/not a request/) });

    await ui.close();
    const readOnly = await startUiServer({ store, port: 0, staticDir: null, readOnly: true });
    const refused = await fetch(`${readOnly.url}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcpspy': '1' },
      body: JSON.stringify({ messageId: recorded.echo }),
    });
    expect(refused.status).toBe(403);
    await readOnly.close();
    store.close();
  });
});
