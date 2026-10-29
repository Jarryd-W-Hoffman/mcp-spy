import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import type { NewMessage } from '../src/types.js';

const message = (session_id: number, fields: Partial<NewMessage> = {}): NewMessage => ({
  session_id,
  ts: 0,
  direction: 'client',
  kind: 'notification',
  method: 'notifications/message',
  rpc_id: null,
  payload: '{}',
  size: 2,
  problem: null,
  request_id: null,
  latency_ms: null,
  tokens: null,
  token_detail: null,
  issues: null,
  mock: null,
  ...fields,
});

describe('Store on a large log', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  const session = (name: string) => store.createSession({ name, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });

  // The UI lists sessions every 250 ms, so the counts are kept up to date rather than counted.
  it('keeps each session’s message count as messages arrive and go', () => {
    const a = session('a');
    const b = session('b');
    for (let i = 0; i < 3; i++) store.insertMessage(message(a));
    store.insertMessage(message(b));
    expect(store.listSessions().map((s) => [s.name, s.message_count])).toEqual([['b', 1], ['a', 3]]);

    store['db'].prepare('DELETE FROM sessions WHERE id = ?').run(a);
    expect(store.listSessions().map((s) => [s.name, s.message_count])).toEqual([['b', 1]]);
    store['db'].prepare('DELETE FROM messages WHERE session_id = ?').run(b);
    expect(store.listSessions()[0]!.message_count).toBe(0);
  });

  it.each([
    ['validate', 'SELECT * FROM messages WHERE issues IS NOT NULL ORDER BY id DESC LIMIT 500', 'messages_issues'],
    [
      'the token backfill',
      `SELECT * FROM messages WHERE tokens IS NULL AND kind IN ('response', 'error') AND method IN ('tools/list', 'tools/call', 'resources/read', 'prompts/get') ORDER BY id LIMIT 1000`,
      'messages_missing_tokens',
    ],
  ])('finds what %s looks for without scanning every message', (_label, query, index) => {
    const plan = (store['db'].prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]).map((row) => row.detail).join('\n');
    expect(plan).toContain(index);
  });
});
