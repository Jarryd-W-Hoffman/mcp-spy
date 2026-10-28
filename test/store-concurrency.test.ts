import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const openStore = join(import.meta.dirname, 'fixtures', 'open-store.mjs');

/**
 * A log as mcpspy wrote it before schema validation: in WAL mode, with every table and
 * index, but without the columns added since (issues, checked, mock).
 */
function oldLog({ wal = true } = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mcpspy-store-')), 'old.db');
  const db = new DatabaseSync(path);
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, name TEXT, transport TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
      pid INTEGER, started_at REAL NOT NULL, ended_at REAL, exit_code INTEGER, exit_signal TEXT, replay_of INTEGER, env_keys TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ts REAL NOT NULL, direction TEXT NOT NULL, kind TEXT NOT NULL, method TEXT, rpc_id TEXT, payload TEXT NOT NULL,
      size INTEGER NOT NULL, problem TEXT, request_id INTEGER REFERENCES messages(id), latency_ms REAL, tokens INTEGER, token_detail TEXT);
    CREATE INDEX messages_session ON messages(session_id, id);
    CREATE INDEX messages_request ON messages(request_id);
    CREATE TABLE exact_counts (message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, model TEXT NOT NULL,
      tokens INTEGER NOT NULL, detail TEXT, counted_at REAL NOT NULL, PRIMARY KEY (message_id, model));
  `);
  db.close();
  return path;
}

function openInChild(path: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', openStore, path], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('opening a log from several processes', () => {
  // Agents start all their MCP servers at once, so after an upgrade several proxies open
  // (and migrate) the same old log together. None of them may fail to start.
  it.each([
    ['an old log', true],
    ['a log not yet in WAL mode', false],
  ])('waits for another process holding the lock on %s instead of failing', async (_label, wal) => {
    const path = oldLog({ wal });
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN IMMEDIATE');
    const child = openInChild(path);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    holder.exec('COMMIT');
    holder.close();

    const { code, stderr } = await child;
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('migrates an old log once when many processes open it together', async () => {
    const path = oldLog();
    // Hold the lock while they start, so every one finds the columns missing before any adds them.
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN IMMEDIATE');
    const children = Array.from({ length: 8 }, () => openInChild(path));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    holder.exec('COMMIT');
    holder.close();
    const results = await Promise.all(children);
    expect(results.filter((result) => result.code !== 0).map((result) => result.stderr.trim().split('\n').at(-1))).toEqual([]);

    const store = new Store(path);
    expect(store.listSessions(20)).toHaveLength(8);
    store.close();
  });
});
