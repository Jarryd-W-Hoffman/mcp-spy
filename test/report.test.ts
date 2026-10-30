import { describe, expect, it } from 'vitest';
import { Recorder } from '../src/recorder.js';
import { stableStringify, toolListChanges, toolsReport } from '../src/report.js';
import { Store } from '../src/store.js';

const list = (tools: object[]) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } });

function session(store: Store, name: string, tools: object[], calls: [tool: string, result: string][] = []) {
  const sessionId = store.createSession({ name, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
  const recorder = new Recorder(store, sessionId);
  recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  recorder.frame('server', list(tools));
  calls.forEach(([tool, result], index) => {
    recorder.frame('client', JSON.stringify({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: tool } }));
    recorder.frame('server', `{"jsonrpc":"2.0","id":${index + 2},${result}}`);
  });
  return sessionId;
}

describe('toolsReport', () => {
  it('reports definition costs, call stats and changes since the previous session', () => {
    const store = new Store(':memory:');
    const search = { name: 'search', description: 'Find things', inputSchema: { type: 'object' } };
    session(store, 'docs', [search, { name: 'old', inputSchema: { type: 'object' } }]);
    const current = session(
      store,
      'docs',
      [{ ...search, description: 'Find things in the docs, with much more detail than before' }, { name: 'fetch', inputSchema: { type: 'object' } }],
      [
        ['search', `"result":{"content":[{"type":"text","text":"${'x'.repeat(70)}"}]}`],
        ['search', '"result":{"isError":true,"content":[{"type":"text","text":"nope"}]}'],
        ['fetch', '"error":{"code":-1,"message":"down"}'],
      ],
    );

    const report = toolsReport(store, current);
    expect(report.definitions?.tools.map((tool) => tool.name)).toEqual(['search', 'fetch']);
    expect(report.definitions?.total).toBe(report.definitions!.tools.reduce((sum, tool) => sum + tool.tokens, 0));

    expect(report.calls).toMatchObject([
      { name: 'search', calls: 2, errors: 1, totalTokens: 22, maxTokens: 20 },
      { name: 'fetch', calls: 1, errors: 1 },
    ]);

    expect(report.previousSessionId).toBe(current - 1);
    expect(report.changes).toEqual([
      { name: 'search', change: 'changed', fields: ['description'], tokenDelta: expect.any(Number) },
      { name: 'fetch', change: 'added', fields: [], tokenDelta: expect.any(Number) },
      { name: 'old', change: 'removed', fields: [], tokenDelta: expect.any(Number) },
    ]);
    expect(report.changes![0]!.tokenDelta).toBeGreaterThan(0);
    expect(report.changes![2]!.tokenDelta).toBeLessThan(0);
    store.close();
  });

  it('handles sessions without a tool list', () => {
    const store = new Store(':memory:');
    const id = store.createSession({ name: 'x', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    expect(toolsReport(store, id)).toEqual({ sessionId: id, definitions: null, calls: [], previousSessionId: null, previousListMessageId: null, changes: null });
    store.close();
  });
});

describe('toolListChanges', () => {
  it('ignores key order in schemas', () => {
    const a = list([{ name: 't', inputSchema: { type: 'object', properties: {} } }]);
    const b = list([{ inputSchema: { properties: {}, type: 'object' }, name: 't' }]);
    expect(toolListChanges(a, b, null, null)).toEqual([]);
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

describe('sparse tool lists', () => {
  it('copes with lists that have no tools or costs', () => {
    expect(toolListChanges('{"result":{}}', '{"result":{"tools":[{"name":"a"}]}}', null, null)).toEqual([{ name: 'a', change: 'added', fields: [], tokenDelta: 0 }]);
    expect(toolListChanges('{"result":{"tools":[{"name":"a"}]}}', '{}', null, null)).toEqual([{ name: 'a', change: 'removed', fields: [], tokenDelta: -0 }]);
  });

  it('stringifies undefined and arrays stably', () => {
    expect(stableStringify(undefined)).toBe('undefined');
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('reports a session whose tool list and replies have no token counts', () => {
    const store = new Store(':memory:');
    const session = store.createSession({ name: 'x', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 1 });
    const base = { session_id: session, ts: 1, size: 1, problem: null, latency_ms: null, issues: null, token_detail: null };
    const list = store.insertMessage({ ...base, direction: 'client', kind: 'request', method: 'tools/list', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', request_id: null, tokens: null });
    store.insertMessage({ ...base, direction: 'server', kind: 'response', method: 'tools/list', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', request_id: list, tokens: 0 });
    const call = store.insertMessage({ ...base, direction: 'client', kind: 'request', method: 'tools/call', rpc_id: '2', payload: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"t"}}', request_id: null, tokens: null });
    store.insertMessage({ ...base, direction: 'server', kind: 'response', method: 'tools/call', rpc_id: '2', payload: '{"jsonrpc":"2.0","id":2,"result":{}}', request_id: call, tokens: null });
    const report = toolsReport(store, session);
    expect(report.definitions!.tools).toEqual([]);
    expect(report.calls).toEqual([expect.objectContaining({ name: 't', totalTokens: 0, maxTokens: 0 })]);
    store.close();
  });
});
