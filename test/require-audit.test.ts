import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_STOPPED, type AuditType } from '../src/audit.js';
import { MockEngine } from '../src/mocks.js';
import { parsePolicy, PolicyEngine } from '../src/policy.js';
import { startHttpProxy, type HttpProxy } from '../src/proxy/http.js';
import { POLICY_ERROR } from '../src/proxy/interceptor.js';
import { runStdioProxy } from '../src/proxy/stdio.js';
import { SseParser } from '../src/sse.js';
import { Store } from '../src/store.js';
import { wrapConfig } from '../src/wrap.js';
import { cli } from './cli-harness.js';

type Line = { id?: unknown; method?: string; result?: { echoed?: unknown }; error?: { code: number; message: string } };
const call = (id: number, name = 'read') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { secret: 'data' } } });

/** Makes writes of these event types fail, as a full disk or a locked log would. */
function failOn(store: Store, ...types: AuditType[]): void {
  const append = store.appendAudit.bind(store);
  store.appendAudit = (event) => {
    if (types.includes(event.type)) throw new Error('disk full');
    return append(event);
  };
}

/** A server that says it got each line, then runs `extra` (given as code) on the first. */
const server = (extra = '') => `
  let first = true;
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    if (first) { first = false; ${extra} }
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echoed: m.params?.arguments?.secret ?? null } }));
  });
`;

async function stdio(store: Store, lines: string[], options: { requireAudit?: boolean; audit?: boolean; code?: string } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let out = '';
  let errors = '';
  output.on('data', (chunk: Buffer) => (out += chunk.toString()));
  errorOutput.on('data', (chunk: Buffer) => (errors += chunk.toString()));
  const running = runStdioProxy({
    command: process.execPath,
    args: ['-e', options.code ?? server()],
    store,
    input,
    output,
    errorOutput,
    forwardSignals: [],
    requireAudit: options.requireAudit ?? true,
    audit: options.audit,
  });
  for (const line of lines) input.write(`${line}\n`);
  const { exitCode } = await Promise.race([
    running,
    new Promise<{ exitCode: number }>((resolve) => {
      // A server still running once its input ends has nothing more to say.
      setTimeout(() => void input.end(), 150);
      void running.then(resolve);
    }),
  ]);
  return { exitCode, errors, lines: out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line) };
}

describe('--require-audit over stdio', () => {
  it('passes traffic through and writes the trail when nothing is wrong', async () => {
    const store = new Store(':memory:');
    const { exitCode, lines } = await stdio(store, [JSON.stringify(call(1))]);
    expect(exitCode).toBe(0);
    expect(lines).toEqual([{ jsonrpc: '2.0', id: 1, result: { echoed: 'data' } }]);
    expect([...store.auditEvents()].map((event) => event.type)).toEqual(['session_start', 'call', 'outcome', 'session_end']);
    store.close();
  });

  it("doesn't start the server when the session can't be recorded", async () => {
    const store = new Store(':memory:');
    store.createSession = () => {
      throw new Error('disk full');
    };
    const { exitCode, errors, lines } = await stdio(store, [], { code: 'console.log("started")' });
    expect(exitCode).toBe(1);
    expect(errors).toContain(`not starting ${process.execPath}: ${AUDIT_STOPPED} (disk full)`);
    expect(lines).toEqual([]);
    store.close();
  });

  it("doesn't start the server when the trail can't be started", async () => {
    const store = new Store(':memory:');
    failOn(store, 'session_start');
    const { exitCode, errors, lines } = await stdio(store, [], { code: 'console.log("started")' });
    expect(exitCode).toBe(1);
    expect(errors).toContain(AUDIT_STOPPED);
    expect(lines).toEqual([]);
    store.close();
  });

  it('never forwards a call it could not record, and tells the agent why', async () => {
    const store = new Store(':memory:');
    failOn(store, 'call');
    const { exitCode, errors, lines } = await stdio(store, [JSON.stringify(call(1))]);
    expect(lines).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: POLICY_ERROR, message: `mcpspy stopped this session: ${AUDIT_STOPPED}` } }]);
    expect(exitCode).toBe(1);
    expect(errors).toContain('stopping the session');
    expect(errors).toContain('disk full');
    store.close();
  });

  it('holds back a reply it could not record', async () => {
    const store = new Store(':memory:');
    failOn(store, 'outcome');
    const { exitCode, lines } = await stdio(store, [JSON.stringify(call(1))]);
    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.error?.message).toContain(AUDIT_STOPPED);
    expect(JSON.stringify(lines)).not.toContain('"data"');
    store.close();
  });

  it('passes nothing else on once stopped, whatever the server or agent sends', async () => {
    const store = new Store(':memory:');
    failOn(store, 'call');
    const noisy = server(`
      console.log('not json');
      console.log('null');
      console.log(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} }));
      console.log(JSON.stringify({ jsonrpc: '2.0', id: 'server-request', method: 'roots/list' }));
    `);
    const { lines } = await stdio(store, [
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      JSON.stringify(call(1)),
      'not json',
      'null',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ], { code: noisy });
    expect(lines.every((line) => line.error?.code === POLICY_ERROR)).toBe(true);
    expect(lines.some((line) => line.id === 1)).toBe(true);
    store.close();
  });

  it('keeps proxying through the same failure without the flag', async () => {
    const store = new Store(':memory:');
    failOn(store, 'call');
    const { exitCode, errors, lines } = await stdio(store, [JSON.stringify(call(1))], { requireAudit: false, audit: true });
    expect(exitCode).toBe(0);
    expect(lines[0]!.result).toEqual({ echoed: 'data' });
    expect(errors).toContain('recording stopped, still proxying');
    store.close();
  });
});

describe('--require-audit over HTTP', () => {
  type Handler = (req: IncomingMessage, res: ServerResponse, message: Line) => void;
  const json: Handler = (_req, res, message) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: 'data' } }));
  const sse: Handler = (_req, res, message) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: 'data' } })}\n\n`);
  };

  let up: Server | null = null;
  let proxy: HttpProxy | null = null;
  let store: Store;
  afterEach(async () => {
    await proxy?.close();
    up?.closeAllConnections();
    await new Promise<void>((resolve) => (up ? up.close(() => resolve()) : resolve()));
    store.close();
    up = proxy = null;
  });

  async function start(reply: Handler, options: { policy?: object; mocks?: MockEngine; requireAudit?: boolean } = {}) {
    const received: Line[] = [];
    up = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const message = (body ? JSON.parse(body) : {}) as Line;
        received.push(message);
        reply(req, res, message);
      });
    });
    await new Promise<void>((resolve) => up!.listen(0, '127.0.0.1', resolve));
    store = new Store(':memory:');
    const warnings: string[] = [];
    proxy = await startHttpProxy({
      upstream: `http://127.0.0.1:${(up.address() as AddressInfo).port}/mcp`,
      store,
      port: 0,
      requireAudit: options.requireAudit ?? true,
      mocks: options.mocks,
      askTimeoutMs: 2000,
      policy: options.policy ? new PolicyEngine(null, 'remote', '/', () => {}, parsePolicy(JSON.stringify(options.policy), '/')) : undefined,
      warn: (message) => warnings.push(message),
    });
    const post = (body: object, accept = 'application/json, text/event-stream') =>
      fetch(proxy!.url, { method: 'POST', headers: { 'content-type': 'application/json', accept }, body: JSON.stringify(body) });
    return { received, warnings, post };
  }

  it('passes traffic through and writes the trail when nothing is wrong', async () => {
    const { post } = await start(json);
    expect(await (await post(call(1))).json()).toMatchObject({ result: { echoed: 'data' } });
    expect([...store.auditEvents()].map((event) => event.type)).toEqual(['session_start', 'call', 'outcome']);
  });

  it('never forwards a call it could not record, and refuses everything after it', async () => {
    const { post, received, warnings } = await start(json);
    failOn(store, 'call');
    const refused = await post(call(1));
    expect([refused.status, await refused.text()]).toEqual([503, `mcpspy stopped: ${AUDIT_STOPPED}`]);
    expect(received).toEqual([]);
    expect(warnings[0]).toContain('refusing all traffic until restarted');
    const later = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(later.status).toBe(503);
    expect((await fetch(proxy!.url)).status).toBe(503);
    expect(received).toEqual([]);
  });

  it('holds back a reply it could not record', async () => {
    const { post, received } = await start(json);
    failOn(store, 'outcome');
    const refused = await post(call(1));
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain('data');
    expect(received).toHaveLength(1);
  });

  it('holds back a mocked reply it could not record', async () => {
    const mocks = new MockEngine(null, null, () => {}, { rules: [{ match: { tool: 'read' }, text: 'mocked' }] });
    const { post } = await start(json, { mocks });
    failOn(store, 'outcome');
    const refused = await post(call(1));
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain('mocked');
  });

  it('ends an event stream rather than pass on what it could not record', async () => {
    const { post } = await start(sse);
    failOn(store, 'outcome');
    const stream = await post(call(1));
    await expect(stream.text()).rejects.toThrow();
  });

  it('refuses what it would have to pass on unread', async () => {
    const compressed: Handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'zstd' }).end('xx');
    const { post } = await start(compressed);
    const unreadable = await post(call(1));
    expect([unreadable.status, await unreadable.text()]).toEqual([502, "mcpspy's audit trail can't check a reply compressed with zstd"]);
    const put = await fetch(proxy!.url, { method: 'PUT', body: JSON.stringify(call(2)) });
    expect([put.status, await put.text()]).toEqual([405, "mcpspy's audit trail only checks POST bodies, so it refuses a PUT with one"]);
  });

  it('keeps proxying through the same failure without the flag', async () => {
    const { post, warnings } = await start(json, { policy: { default: 'allow' }, requireAudit: false });
    failOn(store, 'call');
    expect(await (await post(call(1))).json()).toMatchObject({ result: { echoed: 'data' } });
    expect(warnings[0]).toContain('recording stopped, still proxying');
  });

  describe('when a held call is approved', () => {
    const policy = { default: 'allow', rules: [{ name: 'reads', tool: 'read', ask: 'Read?' }] };
    const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: { elicitation: {} } } };

    /** Sends a call, approves the ask it raises, and returns the rest of its stream. */
    async function approve(post: (body: object) => Promise<Response>) {
      await post(initialize);
      const held = await post(call(1));
      const reader = held.body!.getReader();
      const events: string[] = [];
      const parser = new SseParser((event) => event.data !== null && events.push(event.data));
      const { value } = await reader.read();
      parser.push(Buffer.from(value!));
      const ask = JSON.parse(events[0]!) as { id: string };
      events.length = 0;
      await post({ jsonrpc: '2.0', id: ask.id, result: { action: 'accept', content: {} } });
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          parser.push(Buffer.from(chunk));
        }
      } catch {
        return { events, broken: true };
      }
      return { events, broken: false };
    }

    it("doesn't forward it if the approval can't be recorded", async () => {
      const { post, received } = await start(json, { policy });
      failOn(store, 'approval');
      const { events } = await approve(post);
      expect(events.join()).toContain(AUDIT_STOPPED);
      expect(received.some((message) => message.method === 'tools/call')).toBe(false);
    });

    it("holds back a JSON reply it can't record", async () => {
      const { post, received } = await start(json, { policy });
      failOn(store, 'outcome');
      const { events } = await approve(post);
      expect(received.some((message) => message.method === 'tools/call')).toBe(true);
      expect(events.join()).toContain(AUDIT_STOPPED);
      expect(events.join()).not.toContain('"data"');
    });

    it("ends the stream on an event it can't record", async () => {
      const reply: Handler = (req, res, message) => (message.method === 'initialize' ? json(req, res, message) : sse(req, res, message));
      const { post } = await start(reply, { policy });
      failOn(store, 'outcome');
      const { events, broken } = await approve(post);
      expect(broken).toBe(true);
      expect(events.join()).not.toContain('"data"');
    });
  });
});

describe('the flag', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('wrap passes it on', () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpspy-require-'));
    const wrapped = wrapConfig({ mcpServers: { a: { command: 'x' } } }, { requireAudit: true }).config as { mcpServers: { a: { args: string[] } } };
    expect(wrapped.mcpServers.a.args).toEqual(['run', '--name', 'a', '--require-audit', '--', 'x']);
  });

  it("run refuses to start when the log can't be opened, where it would otherwise carry on", async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpspy-require-'));
    // A directory can't be opened as a database.
    const required = await cli(['run', '--db', dir, '--require-audit', '--', process.execPath, '-e', 'console.log("started")']);
    expect(required.code).not.toBe(0);
    expect(required.stderr).toContain('--require-audit forbids running without it');
    expect(required.stdout).not.toContain('started');

    process.env.MCPSPY_DB = dir;
    try {
      const byDefault = await cli(['run', '--require-audit', '--', process.execPath, '-e', '']);
      expect(byDefault.stderr).toContain(`can't open the log at ${dir}`);
    } finally {
      delete process.env.MCPSPY_DB;
    }
  });
});
