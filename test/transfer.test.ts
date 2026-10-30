import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { replay, ReplayError } from '../src/replay.js';
import { addCases, emptySuite } from '../src/suite.js';
import { exportSessions, importSessions } from '../src/transfer.js';
import type { NewMessage } from '../src/types.js';

const message = (session_id: number, fields: Partial<NewMessage> = {}): NewMessage => ({
  session_id,
  ts: 1,
  direction: 'client',
  kind: 'request',
  method: 'tools/call',
  rpc_id: '1',
  payload: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
  size: 46,
  problem: null,
  request_id: null,
  latency_ms: null,
  tokens: null,
  token_detail: null,
  issues: null,
  mock: null,
  ...fields,
});

const exported = (store: Store, ids: number[]) => {
  const lines: string[] = [];
  exportSessions(store, ids, (line) => lines.push(line));
  return lines;
};

describe('export and import', () => {
  let from: Store;
  let to: Store;
  beforeEach(() => {
    from = new Store(':memory:');
    to = new Store(':memory:');
  });
  afterEach(() => {
    from.close();
    to.close();
  });

  const session = (store: Store, name: string, replay_of: number | null = null) =>
    store.createSession({ name, transport: 'stdio', command: '["srv"]', cwd: '/w', pid: 7, started_at: 10, replay_of, env_keys: '["HOME"]' });

  it('carries sessions and messages over with new ids, keeping the links between them', async () => {
    to.insertMessage(message(session(to, 'already here')));
    const original = session(from, 'original');
    from.endSession(original, { ended_at: 20, exit_code: 1, exit_signal: null });
    const request = from.insertMessage(message(original));
    from.insertMessage(message(original, { direction: 'server', kind: 'response', request_id: request, latency_ms: 3, tokens: 9, token_detail: '{}', issues: '[]', mock: 'policy: x' }));
    from.insertMessage(message(original, { direction: 'stderr', kind: 'log', method: null, rpc_id: null, payload: 'hello' }));
    const replay = session(from, 'replay', original);

    const lines = exported(from, [original, replay]);
    expect(JSON.parse(lines[0]!)).toEqual({ mcpspy: 'log', version: 1 });
    expect(lines).toHaveLength(6);

    const result = await importSessions(to, ['', ...lines, '']);
    expect(result).toEqual({ sessions: [2, 3], messages: 3 });
    const [copy, copiedReplay] = [to.getSession(2)!, to.getSession(3)!];
    expect(copy).toMatchObject({ name: 'original', ended_at: 20, exit_code: 1, pid: 7, env_keys: '["HOME"]', replay_of: null });
    expect(copiedReplay).toMatchObject({ name: 'replay', ended_at: null, replay_of: 2 });
    const messages = to.messagesAfter(0, { sessionId: 2 });
    expect(messages[1]).toMatchObject({ request_id: messages[0]!.id, latency_ms: 3, mock: 'policy: x', issues: '[]' });
    // Exporting the copy gives the same file, ids aside.
    const withoutIds = (rows: string[]) => rows.map((row) => row.replace(/"(id|session_id|request_id|replay_of)":\d+/g, ''));
    expect(withoutIds(exported(to, [2, 3]))).toEqual(withoutIds(lines));
  });

  it("marks imported sessions, and won't start the servers they name", async () => {
    const stdio = session(from, 'stdio');
    const call = from.insertMessage(message(stdio));
    from.insertMessage(message(stdio, { direction: 'server', kind: 'response', request_id: call, payload: '{"jsonrpc":"2.0","id":1,"result":{}}' }));
    const http = from.createSession({ name: 'remote', transport: 'http', command: '["https://evil.example/mcp"]', cwd: '/', pid: null, started_at: 1 });
    from.insertMessage(message(http));
    const lines = exported(from, [stdio, http]);
    expect(lines.join('\n')).not.toContain('imported');
    await importSessions(to, lines);
    expect([to.getSession(1)!.imported, to.getSession(2)!.imported, from.getSession(stdio)!.imported]).toEqual([1, 1, 0]);

    await expect(replay({ store: to, messageId: 1 })).rejects.toThrow(
      new ReplayError('session #1 was imported from a file, so mcpspy won\'t run ["srv"] to replay it. Record the server yourself (mcpspy run or mcpspy proxy) and use that session.'),
    );
    await expect(replay({ store: to, messageId: 3 })).rejects.toThrow("so mcpspy won't connect to https://evil.example/mcp to replay it");
    expect(() => addCases(emptySuite(), '/w/suite.json', to, [1])).toThrow("so mcpspy won't run [\"srv\"] to add it to a suite");
    // Nothing was started or recorded.
    expect(to.listSessions().map((row) => row.id)).toEqual([2, 1]);
  });

  it('drops links to rows that are not in the file', async () => {
    const lines = [
      '{"mcpspy":"log","version":1}',
      JSON.stringify({ session: { id: 5, transport: 'http', command: 'x', cwd: '/', started_at: 1, replay_of: 4, extra: true } }),
      JSON.stringify({ message: { ...message(5, { request_id: 99, direction: 'server', kind: 'response' }), id: 6 } }),
    ];
    await importSessions(to, (async function* () {
      yield* lines;
    })());
    expect(to.getSession(1)).toMatchObject({ name: null, pid: null, replay_of: null, transport: 'http' });
    expect(to.messagesAfter(0)[0]).toMatchObject({ request_id: null, session_id: 1 });
  });

  it.each([
    [[], 'the file is empty'],
    [['', '   '], 'the file is empty'],
    [['nope'], 'line 1 is not JSON'],
    [['[]'], 'not an mcpspy export'],
    [['{"mcpspy":"other"}'], 'not an mcpspy export'],
    [['{"mcpspy":"log","version":2}'], "export version 2 isn't supported (this mcpspy reads version 1)"],
    [['{"mcpspy":"log","version":1}', '{"other":{}}'], 'line 2 is neither a session nor a message'],
    [['{"mcpspy":"log","version":1}', '{"session":[]}'], 'line 2 is neither a session nor a message'],
    [['{"mcpspy":"log","version":1}', '{"session":{"id":1}}'], 'line 2 (session): "transport" should be a string'],
    [['{"mcpspy":"log","version":1}', '{"session":{"id":1,"transport":"stdio","command":"c","cwd":"/","started_at":1,"pid":"7"}}'], 'line 2 (session): "pid" should be a number or null'],
    [['{"mcpspy":"log","version":1}', JSON.stringify({ message: { ...message(1), id: 1, direction: 'sideways' } })], 'line 2 (message): unknown direction "sideways"'],
    [['{"mcpspy":"log","version":1}', JSON.stringify({ message: { ...message(1), id: 1, kind: 'gossip' } })], 'line 2 (message): unknown kind "gossip"'],
    [['{"mcpspy":"log","version":1}', JSON.stringify({ message: { ...message(1), id: 1 } })], 'message 1 belongs to session 1, which comes later in the file or not at all'],
  ])('refuses %j', async (lines, error) => {
    await expect(importSessions(to, lines)).rejects.toThrow(error);
  });

  it('imports nothing when a later line is bad', async () => {
    const lines = exported(from, [session(from, 'good')]);
    await expect(importSessions(to, [...lines, JSON.stringify({ message: { ...message(42), id: 1 } })])).rejects.toThrow('belongs to session 42');
    expect(to.listSessions()).toEqual([]);
  });

});
