import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePolicy, PolicyEngine, type PolicyFile } from '../src/policy.js';
import { POLICY_ERROR } from '../src/proxy/interceptor.js';
import { startHttpProxy, type HttpProxy } from '../src/proxy/http.js';
import { Store } from '../src/store.js';

/** A server whose replies each test writes; it keeps every POST it receives, with its headers. */
async function upstream(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const posts: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'POST') posts.push({ url: req.url!, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, origin: `http://127.0.0.1:${port}`, posts, close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

const event = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;
const sample = (id: string, maxTokens: number) => ({ jsonrpc: '2.0', id, method: 'sampling/createMessage', params: { messages: [], maxTokens } });
const refused = (id: string) => ({ jsonrpc: '2.0', id, error: { code: POLICY_ERROR, message: 'Blocked by mcpspy policy: too many tokens' } });
/** Lets the proxy's answer reach the server, which happens after the agent's stream is written. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('HTTP proxy: what the server sends the agent, under a policy', () => {
  let store: Store;
  let proxy: HttpProxy | undefined;
  let up: Awaited<ReturnType<typeof upstream>> | undefined;
  const warnings: string[] = [];
  const policy: PolicyFile = {
    default: 'allow',
    rules: [
      { name: 'small samples', method: 'sampling/createMessage', where: { maxTokens: { max: 1000 } }, allow: true },
      { name: 'no sampling', method: 'sampling/createMessage', deny: 'too many tokens' },
      { name: 'quiet', method: 'notifications/message', deny: 'no logs' },
    ],
  };

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

  const start = async (handler: Parameters<typeof upstream>[0], configured = true) => {
    up = await upstream(handler);
    proxy = await startHttpProxy({
      upstream: up.url,
      store,
      port: 0,
      headers: configured ? { Authorization: 'Bearer configured' } : undefined,
      policy: new PolicyEngine(null, 'remote', '/', () => {}, parsePolicy(JSON.stringify(policy), '/')),
      warn: (message) => warnings.push(message),
    });
  };
  const logs = () => store.messagesAfter(0).filter((message) => message.direction === 'stderr').map((message) => message.payload);

  it('keeps refused requests and notifications from the agent, and answers the server itself', async () => {
    await start((_req, res, body) => {
      const message = JSON.parse(body) as { id?: unknown; method?: string };
      if (message.method !== 'tools/call') return void res.writeHead(202).end();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'S' });
      res.write(event(sample('big', 5000)));
      res.write(event({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } }));
      res.write(event([sample('batched', 9000), sample('small', 10)]));
      res.write(event(sample('fine', 20)));
      res.end(event({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));
    });
    const response = await fetch(proxy!.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'S', 'mcp-protocol-version': '2025-06-18', authorization: 'Bearer agent' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'think', arguments: {} } }),
    });
    const agentSaw = [...(await response.text()).matchAll(/data: (.*)/g)].map((match) => JSON.parse(match[1]!) as unknown);
    expect(agentSaw).toEqual([[sample('small', 10)], sample('fine', 20), { jsonrpc: '2.0', id: 1, result: { content: [] } }]);
    await settle();

    // The answers went where the agent's would, as the agent would send them, with the configured credentials.
    const answers = up!.posts.slice(1);
    expect(answers.map((post) => [post.url, JSON.parse(post.body)])).toEqual([
      ['/mcp', refused('big')],
      ['/mcp', refused('batched')],
    ]);
    expect(answers[0]!.headers).toMatchObject({
      'mcp-session-id': 'S',
      'mcp-protocol-version': '2025-06-18',
      authorization: 'Bearer configured',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });

    const recorded = store.messagesAfter(0).filter((message) => message.mock !== null).map((message) => [message.direction, message.rpc_id, message.mock]);
    expect(recorded).toEqual([
      ['server', '"big"', 'policy: no sampling'],
      ['client', '"big"', 'policy: no sampling'],
      ['server', null, 'policy: quiet'],
      ['server', '"small"', 'policy: no sampling'],
      ['client', '"batched"', 'policy: no sampling'],
    ]);
    expect(warnings).toEqual([
      'policy denied sampling/createMessage from the server (no sampling): too many tokens',
      'policy denied notifications/message from the server (quiet): no logs',
      'policy denied sampling/createMessage from the server (no sampling): too many tokens',
    ]);
  });

  it('answers on the legacy transport at the endpoint the stream named, and never another origin', async () => {
    let foreign = false;
    await start((req, res) => {
      if (req.method === 'POST') return void res.writeHead(202).end();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: endpoint\ndata: ${foreign ? 'http://elsewhere.example/messages' : '/messages?sessionId=1'}\n\n`);
      res.end(event(sample('legacy', 5000)));
    }, false);
    await (await fetch(`${proxy!.url.replace('/mcp', '')}/sse`)).text();
    await settle();
    expect(up!.posts.map((post) => [post.url, JSON.parse(post.body)])).toEqual([['/messages?sessionId=1', refused('legacy')]]);

    foreign = true;
    await (await fetch(`${proxy!.url.replace('/mcp', '')}/sse`)).text();
    await settle();
    expect(up!.posts).toHaveLength(1);
    expect(warnings).toContain("policy: can't answer the server at http://elsewhere.example; its request will go unanswered");
  });

  it('logs an answer the server refuses, or that never arrives', async () => {
    let answers = 0;
    await start((req, res, body) => {
      const message = JSON.parse(body) as { id?: unknown; method?: string };
      if (message.method === undefined) {
        // The first answer is refused; the second never gets a reply.
        if (++answers === 1) return void res.writeHead(400, 'Bad Request').end();
        return void req.socket.destroy();
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(event(sample(`ask-${answers}`, 5000)) + event({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
    for (const id of [1, 2]) {
      await (await fetch(proxy!.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) })).text();
      await settle();
    }
    expect(logs()).toEqual([
      "[http] the server refused mcpspy's answer to its request: 400 Bad Request",
      expect.stringMatching(/^\[http\] could not answer the server's request: /),
    ]);
  });
});
