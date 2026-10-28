import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageDetail, MessageSummary, ServerEvent, SessionSummary } from '../src/api.js';
import { Recorder } from '../src/recorder.js';
import { isLoopbackHost, startUiServer, type UiServer } from '../src/server.js';
import { Store } from '../src/store.js';

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
