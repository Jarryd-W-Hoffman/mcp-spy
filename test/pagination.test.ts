import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockEngine } from '../src/mocks.js';
import { backfillValidation, Recorder } from '../src/recorder.js';
import { toolsReport } from '../src/report.js';
import { Store } from '../src/store.js';

// Servers may split tools/list into pages (nextCursor); the agent asks for each in turn.
const tool = (name: string) => ({ name, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } });
const listing = [
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [tool('search'), tool('fetch')], nextCursor: 'page2' } }),
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"page2"}}',
  JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [tool('summarise')] } }),
];
const callSearch = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"q":"x"}}}';

describe('paginated tool lists', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  function record(lines: string[], name = 'paged'): number {
    const sessionId = store.createSession({ name, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const recorder = new Recorder(store, sessionId);
    lines.forEach((line, index) => recorder.frame(index % 2 === 0 ? 'client' : 'server', line));
    return sessionId;
  }

  it('validates calls against every page', () => {
    const sessionId = record([...listing, callSearch]);
    const call = store.messagesAfter(0, { sessionId }).find((m) => m.method === 'tools/call')!;
    expect(call.issues).toBeNull();
  });

  it('starts over when the agent lists the tools again', () => {
    const relist = ['{"jsonrpc":"2.0","id":4,"method":"tools/list"}', JSON.stringify({ jsonrpc: '2.0', id: 4, result: { tools: [tool('summarise')] } })];
    const sessionId = record([...listing, ...relist, callSearch.replace('"id":3', '"id":5')]);
    const call = store.messagesAfter(0, { sessionId }).find((m) => m.method === 'tools/call')!;
    expect(JSON.parse(call.issues!)).toEqual([expect.objectContaining({ message: '"search" is not in the server\'s tool list' })]);
  });

  it('flags a tool repeated on a later page', () => {
    const repeat = [listing[0]!, listing[1]!, listing[2]!, JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [tool('fetch')] } })];
    const sessionId = record(repeat);
    const lastPage = store.messagesAfter(0, { sessionId }).at(-1)!;
    expect(JSON.parse(lastPage.issues!)).toEqual([expect.objectContaining({ message: 'duplicate tool name "fetch"' })]);
  });

  it('backfills validation across pages', () => {
    const sessionId = record([...listing, callSearch]);
    const db = store['db'];
    db.prepare('UPDATE messages SET issues = NULL').run();
    db.prepare('UPDATE sessions SET checked = 0').run();
    backfillValidation(store);
    expect(store.messagesAfter(0, { sessionId }).find((m) => m.method === 'tools/call')!.issues).toBeNull();
  });

  it('reports every page in the Tools report', () => {
    const sessionId = record(listing);
    const report = toolsReport(store, sessionId);
    expect(report.definitions?.tools.map((t) => t.name)).toEqual(['search', 'fetch', 'summarise']);
    expect(report.definitions?.total).toBe(report.definitions!.tools.reduce((sum, t) => sum + t.tokens, 0));
    expect(store.latestToolList(sessionId)!.pages).toBe(2);
  });

  it('compares whole listings with the previous session', () => {
    record(listing);
    // The change is on the first page, which a comparison of last pages would miss.
    const changed = [listing[0]!, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [tool('search')], nextCursor: 'page2' } }), ...listing.slice(2)];
    const report = toolsReport(store, record(changed));
    expect(report.changes?.map((c) => `${c.change} ${c.name}`)).toEqual(['removed fetch']);
  });

  it('adds mock tools to the last page only, and drops the real tools they replace from every page', () => {
    const engine = new MockEngine(null, null, () => {}, { rules: [], tools: [{ name: 'fetch', inputSchema: { type: 'object' } }, { name: 'fake', inputSchema: { type: 'object' } }] });
    const page1 = engine.patchToolList({ tools: [tool('search'), tool('fetch')], nextCursor: 'page2' }) as { tools: { name: string }[]; nextCursor: string };
    const page2 = engine.patchToolList({ tools: [tool('summarise')] }) as { tools: { name: string }[] };
    expect(page1.tools.map((t) => t.name)).toEqual(['search']);
    expect(page1.nextCursor).toBe('page2');
    expect(page2.tools.map((t) => t.name)).toEqual(['summarise', 'fetch', 'fake']);
  });
});
