import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillTokens, backfillValidation, Recorder } from '../src/recorder.js';
import { Store } from '../src/store.js';

describe('Recorder', () => {
  let store: Store;
  let clock: number;
  let recorder: Recorder;

  beforeEach(() => {
    store = new Store(':memory:');
    const sessionId = store.createSession({
      name: 'test',
      transport: 'stdio',
      command: '["server"]',
      cwd: '/',
      pid: null,
      started_at: 0,
    });
    clock = 1000;
    recorder = new Recorder(store, sessionId, () => clock);
  });

  afterEach(() => store.close());

  it('pairs a server response with the client request and measures latency', () => {
    const [requestId] = recorder.frame('client', '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{}}');
    clock += 42;
    const [responseId] = recorder.frame('server', '{"jsonrpc":"2.0","id":7,"result":{"content":[]}}');

    expect(store.getMessage(responseId!)).toMatchObject({
      kind: 'response',
      method: 'tools/call',
      request_id: requestId,
      latency_ms: 42,
    });
    expect(recorder.unanswered()).toBe(0);
  });

  it('pairs server-initiated requests separately from client ones with the same id', () => {
    const [clientRequest] = recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
    const [serverRequest] = recorder.frame('server', '{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage"}');
    const [clientReply] = recorder.frame('client', '{"jsonrpc":"2.0","id":1,"result":{}}');
    const [serverReply] = recorder.frame('server', '{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"x"}}');

    expect(store.getMessage(clientReply!)).toMatchObject({ request_id: serverRequest, method: 'sampling/createMessage' });
    expect(store.getMessage(serverReply!)).toMatchObject({ request_id: clientRequest, method: 'tools/call', kind: 'error' });
  });

  it('records unmatched responses, invalid frames and stderr', () => {
    const [orphan] = recorder.frame('server', '{"jsonrpc":"2.0","id":99,"result":{}}');
    const [junk] = recorder.frame('server', 'listening...');
    const log = recorder.stderr('debug: ready');

    expect(store.getMessage(orphan!)).toMatchObject({ request_id: null, latency_ms: null });
    expect(store.getMessage(junk!)).toMatchObject({ kind: 'invalid', problem: expect.stringMatching(/not JSON/) });
    expect(store.getMessage(log)).toMatchObject({ direction: 'stderr', kind: 'log', payload: 'debug: ready' });
  });

  it('counts requests still awaiting a response', () => {
    recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
    recorder.frame('client', '{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(recorder.unanswered()).toBe(1);
  });
});

describe('Recorder token estimates', () => {
  it('estimates context cost for tool results and tool lists', () => {
    const store = new Store(':memory:');
    const sessionId = store.createSession({ name: 's', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const recorder = new Recorder(store, sessionId);

    recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    const [list] = recorder.frame('server', '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","inputSchema":{"type":"object"}}]}}');
    recorder.frame('client', '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"a"}}');
    const [call] = recorder.frame('server', `{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"${'x'.repeat(35)}"}]}}`);
    recorder.frame('client', '{"jsonrpc":"2.0","id":3,"method":"ping"}');
    const [ping] = recorder.frame('server', '{"jsonrpc":"2.0","id":3,"result":{}}');

    expect(store.getMessage(list!)).toMatchObject({ tokens: expect.any(Number), token_detail: expect.stringContaining('"name":"a"') });
    expect(store.getMessage(call!)).toMatchObject({ tokens: 10, token_detail: null });
    expect(store.getMessage(ping!)).toMatchObject({ tokens: null });
    store.close();
  });

  it('backfills estimates for rows recorded without them', () => {
    const store = new Store(':memory:');
    const sessionId = store.createSession({ name: 's', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const id = store.insertMessage({
      session_id: sessionId, ts: 0, direction: 'server', kind: 'response', method: 'tools/call', rpc_id: '1',
      payload: `{"result":{"content":[{"type":"text","text":"${'x'.repeat(70)}"}]}}`, size: 0, problem: null,
      request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null,
    });
    expect(backfillTokens(store)).toBe(1);
    expect(store.getMessage(id)?.tokens).toBe(20);
    expect(backfillTokens(store)).toBe(0);
    store.close();
  });
});

describe('Store', () => {
  it('finds the previous session of the same server', () => {
    const store = new Store(':memory:');
    const make = (name: string | null, command: string) =>
      store.createSession({ name, transport: 'stdio', command, cwd: '/', pid: null, started_at: 0 });
    const a1 = make('a', '["x"]');
    make('b', '["x"]');
    const a2 = make('a', '["y"]');
    const n1 = make(null, '["z"]');
    const n2 = make(null, '["z"]');
    expect(store.previousSession(a2)?.id).toBe(a1);
    expect(store.previousSession(a1)).toBeUndefined();
    expect(store.previousSession(n2)?.id).toBe(n1);
    store.close();
  });

  it('adds new columns to databases created by older versions', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const path = join(mkdtempSync(join(tmpdir(), 'mcpspy-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, ts REAL NOT NULL, direction TEXT NOT NULL,
      kind TEXT NOT NULL, method TEXT, rpc_id TEXT, payload TEXT NOT NULL, size INTEGER NOT NULL, problem TEXT,
      request_id INTEGER, latency_ms REAL)`);
    old.close();
    const store = new Store(path);
    expect(store.messagesAfter(0)).toEqual([]);
    expect(store.messagesMissingTokens()).toEqual([]);
    store.close();
  });
});

describe('Recorder validation', () => {
  const list = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [
        {
          name: 'weather',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          outputSchema: { type: 'object', properties: { temperature: { type: 'number' } }, required: ['temperature'] },
        },
      ],
    },
  });

  function record(store: Store, sessionId: number) {
    const recorder = new Recorder(store, sessionId);
    recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    recorder.frame('server', list);
    const [badCall] = recorder.frame('client', '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weather","arguments":{"city":3}}}');
    const [badResult] = recorder.frame('server', '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"x"}],"structuredContent":{"temperature":"hot"}}}');
    const [goodCall] = recorder.frame('client', '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"weather","arguments":{"city":"Perth"}}}');
    const [goodResult] = recorder.frame('server', '{"jsonrpc":"2.0","id":3,"result":{"content":[],"structuredContent":{"temperature":31}}}');
    return { badCall: badCall!, badResult: badResult!, goodCall: goodCall!, goodResult: goodResult! };
  }

  it('stores issues for arguments and results that break the declared schemas', () => {
    const store = new Store(':memory:');
    const sessionId = store.createSession({ name: 's', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const ids = record(store, sessionId);

    expect(JSON.parse(store.getMessage(ids.badCall)!.issues!)).toEqual([
      { severity: 'error', path: 'params.arguments.city', message: 'must be string' },
    ]);
    expect(JSON.parse(store.getMessage(ids.badResult)!.issues!)).toEqual([
      { severity: 'error', path: 'result.structuredContent.temperature', message: 'must be number' },
    ]);
    expect(store.getMessage(ids.goodCall)!.issues).toBeNull();
    expect(store.getMessage(ids.goodResult)!.issues).toBeNull();
    expect(store.messagesWithIssues(sessionId).map((m) => m.id)).toEqual([ids.badResult, ids.badCall]);
    store.close();
  });

  it('backfills sessions recorded before validation', () => {
    const store = new Store(':memory:');
    const sessionId = store.createSession({ name: 's', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const ids = record(store, sessionId);
    // Simulate an old database: no issues stored, session unchecked.
    store.setIssues(ids.badCall, null);
    store.setIssues(ids.badResult, null);
    (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare('UPDATE sessions SET checked = 0 WHERE id = ?')
      .run(sessionId);

    expect(backfillValidation(store)).toBe(1);
    expect(store.getMessage(ids.badCall)!.issues).toContain('params.arguments.city');
    expect(store.getMessage(ids.badResult)!.issues).toContain('result.structuredContent.temperature');
    expect(backfillValidation(store)).toBe(0);
    store.close();
  });
});

describe('backfillTokens on old logs', () => {
  it('estimates tool lists with per-tool detail, and costs nothing for unreadable replies', () => {
    const store = new Store(':memory:');
    const session = store.createSession({ name: 'x', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 1 });
    const base = { session_id: session, ts: 1, size: 1, problem: null, latency_ms: null, issues: null, token_detail: null, tokens: null, request_id: null, direction: 'server' as const, kind: 'response' as const };
    const list = store.insertMessage({ ...base, method: 'tools/list', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","inputSchema":{"type":"object"}}]}}' });
    const broken = store.insertMessage({ ...base, method: 'tools/call', rpc_id: '2', payload: 'not json' });
    expect(backfillTokens(store)).toBe(2);
    expect(JSON.parse(store.getMessage(list)!.token_detail!)).toEqual([{ name: 'a', tokens: expect.any(Number) }]);
    expect(store.getMessage(broken)).toMatchObject({ tokens: 0, token_detail: null });
    store.close();
  });
});
