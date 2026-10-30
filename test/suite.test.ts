import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { addCases, emptySuite, ignoreMatcher, parseSuite, runSuite, updateExpectations, type Suite } from '../src/suite.js';
import { echoServer, recordSession } from './helpers.js';

describe('replay suites', () => {
  let store: Store;
  let suitePath: string;
  beforeEach(() => {
    store = new Store(':memory:');
    suitePath = join(mkdtempSync(join(tmpdir(), 'mcpspy-suite-')), 'mcp.suite.json');
  });
  afterEach(() => store.close());

  it('adds recorded calls with their server, initialize and client replies', async () => {
    const recorded = await recordSession(store);
    const suite = emptySuite();
    const added = addCases(suite, suitePath, store, [recorded.echo, recorded.roots]);

    expect(added.map((testCase) => testCase.name)).toEqual(['tools/call echo', 'tools/call roots']);
    expect(Object.keys(suite.servers)).toEqual(['echo']);
    expect(suite.servers.echo).toMatchObject({
      command: [process.execPath, echoServer],
      initialize: { clientInfo: { name: 'agent', version: '9' } },
      clientReplies: { 'roots/list': { result: { roots: [{ uri: 'file:///work', name: 'work' }] } } },
    });
    expect(suite.cases[0]).toMatchObject({ method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } }, expect: { content: [{ type: 'text', text: 'hello' }] } });

    // Adding the same call again reuses the server and gets a unique name.
    addCases(suite, suitePath, store, [recorded.echo]);
    expect(Object.keys(suite.servers)).toHaveLength(1);
    expect(suite.cases[2]!.name).toBe('tools/call echo (2)');
    expect(() => addCases(suite, suitePath, store, [recorded.initialize])).toThrow(/initialize/);
  });

  it('stores the working directory relative to the suite when it is below it', async () => {
    const recorded = await recordSession(store);
    const session = store.getSession(store.getMessage(recorded.echo)!.session_id)!;
    const suite = emptySuite();
    addCases(suite, join(session.cwd, 'suites', 'a.json'), store, [recorded.echo]);
    expect(suite.servers.echo!.cwd).toBe(session.cwd);
    const nested = emptySuite();
    addCases(nested, join(dirname(session.cwd), 'a.json'), store, [recorded.echo]);
    expect(nested.servers.echo!.cwd).toBe(basename(session.cwd));
    const deeper = emptySuite();
    addCases(deeper, join(dirname(dirname(session.cwd)), 'a.json'), store, [recorded.echo]);
    expect(deeper.servers.echo!.cwd).toBe(`${basename(dirname(session.cwd))}/${basename(session.cwd)}`);
  });

  it('passes when responses match, fails with changes when they do not, and can update', async () => {
    const recorded = await recordSession(store);
    const suite = emptySuite();
    addCases(suite, suitePath, store, [recorded.echo, recorded.roots, recorded.time]);

    // time returns a timestamp, so it differs until ignored.
    let results = await runSuite(suite, suitePath);
    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['tools/call echo', 'pass'],
      ['tools/call roots', 'pass'],
      ['tools/call time', 'fail'],
    ]);
    expect(results[2]!.changes).toMatchObject([{ path: 'structuredContent.now', type: 'changed' }]);

    suite.cases[2]!.ignore = ['structuredContent.now'];
    results = await runSuite(suite, suitePath);
    expect(results.every((result) => result.status === 'pass')).toBe(true);

    // A changed expectation fails, and --update accepts what the server returns now.
    (suite.cases[0]!.expect as { content: { text: string }[] }).content[0]!.text = 'goodbye';
    results = await runSuite(suite, suitePath, { filter: 'echo' });
    expect(results).toHaveLength(1);
    expect(results[0]!.changes).toEqual([{ path: 'content[0].text', type: 'changed', before: 'goodbye', after: 'hello' }]);
    expect(updateExpectations(suite, results)).toBe(1);
    expect((await runSuite(suite, suitePath, { filter: 'echo' }))[0]!.status).toBe('pass');
  });

  it('reports every case of a server that cannot start as an error', async () => {
    const suite: Suite = {
      version: 1,
      servers: { broken: { command: ['/no/such/binary'], cwd: '.', initialize: {} } },
      cases: [
        { name: 'a', server: 'broken', method: 'tools/call', expect: {} },
        { name: 'b', server: 'broken', method: 'tools/call', expect: {} },
      ],
    };
    const results = await runSuite(suite, suitePath);
    expect(results.map((result) => result.status)).toEqual(['error', 'error']);
    expect(results[0]!.error).toMatch(/failed to start/);
  });
});

describe('ignoreMatcher', () => {
  it('matches paths at or below a pattern, with wildcards', () => {
    const ignored = ignoreMatcher(['structuredContent.now', 'content[*].text', 'meta.*.id']);
    expect(ignored('structuredContent.now')).toBe(true);
    expect(ignored('structuredContent.nowish')).toBe(false);
    expect(ignored('structuredContent.now.ms')).toBe(true);
    expect(ignored('content[3].text')).toBe(true);
    expect(ignored('content[3].type')).toBe(false);
    expect(ignored('meta.request.id')).toBe(true);
    expect(ignored('tools[name="x"]')).toBe(false);
    expect(ignoreMatcher(['tools[*]'])('tools[name="x"].description')).toBe(true);
  });
});

describe('parseSuite', () => {
  it('validates the file', () => {
    expect(() => parseSuite('{"version":2}')).toThrow(/not an mcpspy suite/);
    expect(() => parseSuite(JSON.stringify({ version: 1, servers: {}, cases: [{ name: 'x', server: 'nope' }] }))).toThrow(/unknown server/);
    expect(parseSuite(JSON.stringify(emptySuite()))).toEqual(emptySuite());
  });
});

describe('suite edge cases', () => {
  const asking = join(import.meta.dirname, 'fixtures', 'asking-server.mjs');
  const row = (store: Store, session: number, fields: Record<string, unknown>) =>
    store.insertMessage({ session_id: session, ts: 1, size: 1, problem: null, latency_ms: null, tokens: null, token_detail: null, issues: null, request_id: null, rpc_id: '1', method: null, payload: '{}', direction: 'client', kind: 'request', ...fields } as never);
  const call = (store: Store, session: number, rpc: string, extra: Record<string, unknown> = {}) => {
    const request = row(store, session, { method: 'tools/call', rpc_id: rpc, payload: JSON.stringify({ jsonrpc: '2.0', id: Number(rpc), method: 'tools/call', params: { name: 'ask' } }), ...extra });
    row(store, session, { direction: 'server', kind: 'response', method: 'tools/call', rpc_id: rpc, request_id: request, payload: JSON.stringify({ jsonrpc: '2.0', id: Number(rpc), result: { content: [] } }) });
    return request;
  };

  it('names servers by session, command or neither, and reuses matching ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpspy-suite-'));
    const store = new Store(':memory:');
    const session = (name: string | null, command: string[], cwd = dir) => store.createSession({ name, transport: 'stdio', command: JSON.stringify(command), cwd, pid: null, started_at: 1 });
    const unnamed = session(null, ['node', 'a.js'], join(dir, 'sub', 'dir'));
    const empty = session(null, []);
    const again = session(null, []);
    const other = session(null, ['node', 'b.js']);
    const suite = emptySuite();
    const path = join(dir, 'suite.json');
    addCases(suite, path, store, [call(store, unnamed, '1'), call(store, empty, '2'), call(store, again, '3'), call(store, other, '4')]);
    expect(Object.keys(suite.servers)).toEqual(['node', 'server', 'node (2)']);
    expect(suite.servers.node).toMatchObject({ cwd: 'sub/dir', initialize: {} });
    expect(suite.servers.server).toMatchObject({ cwd: '.' });
    expect(suite.cases.map((testCase) => testCase.name)).toEqual(['tools/call ask', 'tools/call ask (2)', 'tools/call ask (3)', 'tools/call ask (4)']);
    expect(suite.servers.node).not.toHaveProperty('clientReplies');
    store.close();
  });

  it('keeps a recorded error reply to roots/list, and follows replays to their origin', () => {
    const store = new Store(':memory:');
    const origin = store.createSession({ name: 'srv', transport: 'stdio', command: '["node"]', cwd: '/', pid: null, started_at: 1 });
    const ask = row(store, origin, { direction: 'server', method: 'roots/list', rpc_id: '"r"' });
    row(store, origin, { direction: 'client', kind: 'error', method: 'roots/list', rpc_id: '"r"', request_id: ask, payload: '{"jsonrpc":"2.0","id":"r","error":{"code":1,"message":"no"}}' });
    const replayed = store.createSession({ name: 'srv', transport: 'replay', command: '["node"]', cwd: '/', pid: null, started_at: 2, replay_of: origin });
    const suite = emptySuite();
    addCases(suite, '/tmp/suite.json', store, [call(store, replayed, '5')]);
    expect(suite.servers.srv!.clientReplies).toEqual({ 'roots/list': { error: { code: 1, message: 'no' } } });
    store.close();
  });

  it('refuses requests without a response', () => {
    const store = new Store(':memory:');
    const session = store.createSession({ name: 's', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 1 });
    const lonely = row(store, session, { method: 'ping', payload: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    expect(() => addCases(emptySuite(), '/tmp/s.json', store, [lonely])).toThrow(`message ${lonely} has no recorded response to expect`);
    store.close();
  });

  it('answers server requests, skips servers without cases and reports failures', async () => {
    const suite: Suite = {
      version: 1,
      servers: {
        asking: { command: [process.execPath, asking], cwd: import.meta.dirname, initialize: {} },
        withRoots: { command: [process.execPath, asking], initialize: {}, clientReplies: { 'roots/list': { result: { roots: [] } } } },
        broken: { command: [process.execPath, asking, '--fail-initialize'], initialize: {} },
        idle: { command: [process.execPath, asking], initialize: {} },
      },
      cases: [
        { name: 'ask', server: 'asking', method: 'tools/call', params: { name: 'ask' }, expect: {} },
        { name: 'ask with roots', server: 'withRoots', method: 'tools/call', params: { name: 'ask' }, expect: {} },
        { name: 'never x', server: 'broken', method: 'tools/call', params: {}, expect: {} },
        { name: 'slow x', server: 'idle', method: 'hang', params: {}, expect: {} },
      ],
    };
    const results = await runSuite(suite, join(import.meta.dirname, 'suite.json'), { timeoutMs: 1000, filter: 'a' });
    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['ask', 'fail'],
      ['ask with roots', 'fail'],
    ]);
    const text = (index: number) => JSON.parse(((results[index]!.actual as { content: { text: string }[] }).content[0]!.text)) as { ping: unknown; roots: unknown };
    expect(text(0)).toMatchObject({ ping: { result: {} }, roots: { error: { code: -32601, message: 'no reply to roots/list' } } });
    expect(text(1)).toMatchObject({ roots: { result: { roots: [] } } });

    const failures = await runSuite(suite, join(import.meta.dirname, 'suite.json'), { timeoutMs: 300, filter: 'x' });
    expect(failures.map((result) => [result.name, result.status, result.error])).toEqual([
      ['never x', 'error', 'initialize failed: {"code":-1,"message":"not today"}'],
      ['slow x', 'error', 'hang timed out after 300ms'],
    ]);
  });

  it('runs cases against a server over HTTP, using Streamable HTTP by default', async () => {
    const { startHttpFixture } = await import('./fixtures/http-server.js');
    const fixture = await startHttpFixture();
    try {
      const suite: Suite = {
        version: 1,
        servers: { web: { url: fixture.url, initialize: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } } },
        cases: [{ name: 'echo', server: 'web', method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } }, expect: { content: [{ type: 'text', text: 'hi' }] } }],
      };
      expect((await runSuite(suite, '/tmp/suite.json'))[0]).toMatchObject({ status: 'pass' });
    } finally {
      await fixture.close();
    }
  });

  it('skips updates for cases that are gone, and needs a command or url', () => {
    expect(updateExpectations(emptySuite(), [{ name: 'gone', server: 's', status: 'fail', latencyMs: 1, changes: [], actual: {} }])).toBe(0);
    expect(() => parseSuite('{"version":1,"servers":{"s":{}},"cases":[]}')).toThrow('server "s" needs a command or a url');
  });
});
