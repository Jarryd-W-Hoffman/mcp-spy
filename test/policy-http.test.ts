import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockEngine } from '../src/mocks.js';
import { parsePolicy, PolicyEngine, type PolicyFile } from '../src/policy.js';
import { startHttpProxy, type HttpProxy } from '../src/proxy/http.js';
import { POLICY_ERROR } from '../src/proxy/interceptor.js';
import { Store } from '../src/store.js';

type Reply = { id?: unknown; result?: Record<string, unknown>; error?: Record<string, unknown> };

const tools = ['read_file', 'write_file', 'search'].map((name) => ({ name, inputSchema: { type: 'object' } }));

/** An MCP server over HTTP that answers in JSON, or in SSE when the agent sends x-sse. It records what it was sent. */
async function upstream() {
  const received: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push(body);
      const message = JSON.parse(body) as { id?: unknown; method?: string; params?: { name?: string; arguments?: { text?: string } } };
      if (message.id === undefined || message.method === undefined) return void res.writeHead(202).end();
      const result =
        message.method === 'tools/list'
          ? { tools }
          : message.method === 'tools/call'
            ? { content: [{ type: 'text', text: message.params?.arguments?.text ?? 'done' }] }
            : {};
      const reply = JSON.stringify(message.method === 'boom' || message.params?.name === 'fail' ? { jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'boom' } } : { jsonrpc: '2.0', id: message.id, result });
      if (req.headers['x-sse']) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'S' });
        res.end(`event: message\ndata: ${reply}\n\n`);
      } else res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'S' }).end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('HTTP proxy with a policy', () => {
  let store: Store;
  let up: Awaited<ReturnType<typeof upstream>>;
  let proxy: HttpProxy;
  const warnings: string[] = [];

  beforeEach(async () => {
    store = new Store(':memory:');
    up = await upstream();
    warnings.length = 0;
  });
  afterEach(async () => {
    await proxy.close();
    await up.close();
    store.close();
  });

  const start = async (file: PolicyFile, mocks?: MockEngine) => {
    const policy = new PolicyEngine(null, 'remote', '/', () => {}, parsePolicy(JSON.stringify(file), '/'));
    proxy = await startHttpProxy({ upstream: up.url, store, name: 'remote', port: 0, policy, mocks, warn: (message) => warnings.push(message) });
  };
  const post = async (body: unknown, sse = false) => {
    const response = await fetch(proxy.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'S', ...(sse ? { 'x-sse': '1' } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    if (!sse) return { status: response.status, reply: text ? (JSON.parse(text) as Reply | Reply[]) : null, session: response.headers.get('mcp-session-id') };
    const data = /data: (.*)/.exec(text)![1]!;
    return { status: response.status, reply: JSON.parse(data) as Reply, session: response.headers.get('mcp-session-id') };
  };
  const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const text = (reply: Reply | Reply[] | null) => ((reply as Reply).result!.content as { text: string }[])[0]!.text;

  it('refuses calls itself, forwards the checked message and shapes replies, in JSON and SSE', async () => {
    await start({
      rules: [
        { tool: 'write_file', deny: 'read only' },
        { tool: 'read_file', where: { path: { match: '^/srv/' } }, allow: true },
        { tool: 'search', allow: true },
        { method: 'resources/read', deny: 'no resources' },
      ],
      results: { redact: ['secret-\\d+'] },
    });
    await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });

    for (const sse of [false, true]) {
      const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, sse);
      expect(((list.reply as Reply).result!.tools as { name: string }[]).map((tool) => tool.name)).toEqual(['read_file', 'search']);
      expect(text((await post(call(2, 'search', { text: 'key secret-42' }), sse)).reply)).toBe('key [redacted by policy]');
    }

    const refused = await post(call(3, 'write_file'));
    expect(refused).toMatchObject({ status: 200, session: 'S' });
    expect(text(refused.reply)).toBe('Blocked by mcpspy policy: read only');
    expect(text((await post(call(4, 'read_file', { path: '/etc/passwd' }))).reply)).toBe('Blocked by mcpspy policy: "path" is not allowed for read_file');
    expect((await post({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'x' } })).reply).toMatchObject({ error: { code: POLICY_ERROR } });
    expect(text((await post(call(6, 'read_file', { path: '/srv/a', text: 'plain' }))).reply)).toBe('plain');
    expect((await post({ jsonrpc: '2.0', id: 7, method: 'boom' })).reply).toMatchObject({ error: { message: 'boom' } });

    // The server never saw a refused call, and got JSON.parse's reading of duplicate keys.
    await post('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"write_file","name":"search","arguments":{"text":"dup"}}}');
    expect(up.received.some((body) => body.includes('write_file'))).toBe(false);
    expect(up.received.at(-1)).toBe('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"search","arguments":{"text":"dup"}}}');

    const rules = store.messagesAfter(0).filter((message) => message.direction === 'server' && message.mock !== null).map((message) => [message.rpc_id, message.mock]);
    expect(rules).toEqual([
      ['1', 'policy: hid write_file'],
      ['2', 'policy: result redacted'],
      ['1', 'policy: hid write_file'],
      ['2', 'policy: result redacted'],
      ['3', 'policy: rules[0]'],
      ['4', 'policy: default deny'],
      ['5', 'policy: rules[3]'],
    ]);
    expect(warnings).toContain('policy denied tools/call write_file (rules[0]): read only');
  });

  it('refuses batches, bodies that are not JSON and refused notifications', async () => {
    await start({ default: 'allow', rules: [{ method: 'notifications/secret', deny: 'hush' }] });
    const batch = await post([call(1, 'search'), { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect((batch.reply as Reply[]).map((reply) => [reply.id, reply.error!.code])).toEqual([[1, POLICY_ERROR]]);
    expect(await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).toMatchObject({ status: 202, reply: null });
    expect(await post('not json')).toMatchObject({ status: 202, reply: null });
    expect(await post({ jsonrpc: '2.0', method: 'notifications/secret' })).toMatchObject({ status: 202, reply: null });
    expect(await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).toMatchObject({ status: 202 });
    expect(await post({ jsonrpc: '2.0', id: 9, result: {} })).toMatchObject({ status: 202 });
    expect(up.received).toEqual(['{"jsonrpc":"2.0","method":"notifications/initialized"}', '{"jsonrpc":"2.0","id":9,"result":{}}']);
    expect(warnings).toEqual([
      'policy: refused a batch of messages',
      'policy: refused a batch of messages',
      'policy: refused a request body that is not JSON',
      'policy denied notifications/secret (rules[0]): hush',
    ]);
  });

  it('passes tool errors and full tool lists through unchanged', async () => {
    await start({ default: 'allow', results: { maxBytes: 1000 } });
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).reply).toMatchObject({ result: { tools } });
    expect((await post(call(2, 'fail'))).reply).toMatchObject({ error: { message: 'boom' } });
    expect(store.messagesAfter(0).filter((message) => message.mock !== null)).toEqual([]);
  });

  it('refuses ask rules, which need mcpspy run', async () => {
    await start({ rules: [{ tool: 'search', ask: 'Search?' }] });
    expect(text((await post(call(1, 'search'))).reply)).toBe('Blocked by mcpspy policy: needs approval (Search?), but asking only works with mcpspy run');
  });

  it('answers refusals without a session header when the agent sent none', async () => {
    await start({});
    const response = await fetch(proxy.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call(1, 'search')) });
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(text((await response.json()) as Reply)).toBe('Blocked by mcpspy policy: no rule allows search');
  });

  it('applies the policy after mock tools are added, and leaves mocked results alone', async () => {
    const mocks = new MockEngine(null, 'remote', () => {}, {
      tools: [{ name: 'weather', inputSchema: { type: 'object' } }],
      rules: [{ name: 'sunny', match: { tool: 'weather' }, text: 'sunny secret-1' }],
    });
    await start({ rules: [{ tool: 'weather', allow: true }, { tool: 'search', allow: true }], results: { redact: ['secret-\\d+'] } }, mocks);
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(((list.reply as Reply).result!.tools as { name: string }[]).map((tool) => tool.name)).toEqual(['search', 'weather']);
    expect(text((await post(call(2, 'weather'))).reply)).toBe('sunny secret-1');
    const plain = await startHttpProxy({ upstream: up.url, store, port: 0, mocks });
    try {
      const response = await fetch(plain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
      expect(((await response.json()) as Reply).result!.tools).toHaveLength(4);
    } finally {
      await plain.close();
    }
  });
});
