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

describe('Store failure handling', () => {
  it('waits for a busy lock when switching to WAL, and gives up on other errors', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { vi } = await import('vitest');
    const exec = DatabaseSync.prototype.exec;
    let busy = 2;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      if (sql === 'PRAGMA journal_mode = WAL' && busy-- > 0) throw Object.assign(new Error('database is locked'), { errcode: 5 });
      return exec.call(this, sql);
    });
    try {
      new Store(':memory:').close();
      expect(busy).toBe(-1);

      spy.mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
        if (sql === 'PRAGMA journal_mode = WAL') throw new Error('disk I/O error');
        return exec.call(this, sql);
      });
      expect(() => new Store(':memory:')).toThrow('disk I/O error');

      const now = vi.spyOn(Date, 'now');
      now.mockReturnValueOnce(0).mockReturnValue(10_000);
      spy.mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
        if (sql === 'PRAGMA journal_mode = WAL') throw Object.assign(new Error('database is locked'), { errcode: 517 });
        return exec.call(this, sql);
      });
      expect(() => new Store(':memory:')).toThrow('database is locked');
      now.mockRestore();
    } finally {
      spy.mockRestore();
    }
  });

  it('rolls back a failed schema setup or batch delete', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { vi } = await import('vitest');
    const exec = DatabaseSync.prototype.exec;
    const executed: string[] = [];
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      executed.push(sql);
      if (sql.includes('CREATE TABLE')) throw new Error('schema broke');
      return exec.call(this, sql);
    });
    try {
      expect(() => new Store(':memory:')).toThrow('schema broke');
      expect(executed.at(-1)).toBe('ROLLBACK');
    } finally {
      spy.mockRestore();
    }

    const store = new Store(':memory:');
    const session = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(() => {
      throw new Error('delete broke');
    });
    try {
      expect(() => store.deleteSessionBatch(session)).toThrow('delete broke');
    } finally {
      prepare.mockRestore();
    }
    expect(store.getSession(session)).toBeDefined();
    store.close();
  });

  it('finds tool lists only from tools/list responses', () => {
    const store = new Store(':memory:');
    const session = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const ping = store.insertMessage(message(session, { kind: 'request', method: 'ping', rpc_id: '1' }));
    expect(store.toolListFrom(ping)).toBeUndefined();
    expect(store.toolListFrom(9999)).toBeUndefined();
    const list = store.insertMessage(message(session, { direction: 'server', kind: 'response', method: 'tools/list', rpc_id: null, payload: '{"result":{"tools":[{"name":"a"}]}}' }));
    expect(store.toolListFrom(list)).toMatchObject({ payload: '{"jsonrpc":"2.0","id":null,"result":{"tools":[{"name":"a"}]}}' });
    store.close();
  });
});
