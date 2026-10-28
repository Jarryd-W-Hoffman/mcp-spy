import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MessageRow, NewMessage, SessionRow } from './types.js';

export type { Direction, MessageRow, NewMessage, SessionRow } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  name TEXT,
  transport TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pid INTEGER,
  started_at REAL NOT NULL,
  ended_at REAL,
  exit_code INTEGER,
  exit_signal TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts REAL NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  method TEXT,
  rpc_id TEXT,
  payload TEXT NOT NULL,
  size INTEGER NOT NULL,
  problem TEXT,
  request_id INTEGER REFERENCES messages(id),
  latency_ms REAL,
  tokens INTEGER,
  token_detail TEXT
);

CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS messages_request ON messages(request_id);

CREATE TABLE IF NOT EXISTS exact_counts (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  detail TEXT,
  counted_at REAL NOT NULL,
  PRIMARY KEY (message_id, model)
);
`;

/** Columns added after the first release, applied to older databases on open. */
const MIGRATIONS: [column: string, definition: string][] = [
  ['tokens', 'INTEGER'],
  ['token_detail', 'TEXT'],
];

export function defaultDbPath(): string {
  return process.env.MCPSPY_DB ?? join(homedir(), '.mcpspy', 'mcpspy.db');
}

/**
 * SQLite-backed log of sessions and messages. Several proxies (one per MCP
 * server the agent launches) may write to the same file concurrently, so the
 * database runs in WAL mode with a busy timeout.
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly insertMessageStmt: StatementSync;

  constructor(path: string = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.insertMessageStmt = this.db.prepare(`
      INSERT INTO messages (session_id, ts, direction, kind, method, rpc_id, payload, size, problem, request_id, latency_ms, tokens, token_detail)
      VALUES (:session_id, :ts, :direction, :kind, :method, :rpc_id, :payload, :size, :problem, :request_id, :latency_ms, :tokens, :token_detail)
    `);
  }

  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((column) => column.name),
    );
    for (const [column, definition] of MIGRATIONS) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
    }
  }

  createSession(session: Pick<SessionRow, 'name' | 'transport' | 'command' | 'cwd' | 'pid' | 'started_at'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO sessions (name, transport, command, cwd, pid, started_at)
         VALUES (:name, :transport, :command, :cwd, :pid, :started_at)`,
      )
      .run(session);
    return Number(result.lastInsertRowid);
  }

  setSessionPid(id: number, pid: number): void {
    this.db.prepare('UPDATE sessions SET pid = ? WHERE id = ?').run(pid, id);
  }

  endSession(id: number, end: { ended_at: number; exit_code: number | null; exit_signal: string | null }): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = :ended_at, exit_code = :exit_code, exit_signal = :exit_signal WHERE id = :id')
      .run({ id, ...end });
  }

  insertMessage(message: NewMessage): number {
    return Number(this.insertMessageStmt.run({ ...message }).lastInsertRowid);
  }

  getSession(id: number): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  listSessions(limit = 20): (SessionRow & { message_count: number })[] {
    return this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s ORDER BY s.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as (SessionRow & { message_count: number })[];
  }

  getMessage(id: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  /** Replies that carry context (tool results etc.) but have no estimate yet. */
  messagesMissingTokens(limit = 1000): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE tokens IS NULL AND kind IN ('response', 'error') AND method IN ('tools/list', 'tools/call', 'resources/read', 'prompts/get')
         ORDER BY id LIMIT ?`,
      )
      .all(limit) as unknown as MessageRow[];
  }

  setTokens(id: number, tokens: number, detail: string | null): void {
    this.db.prepare('UPDATE messages SET tokens = ?, token_detail = ? WHERE id = ?').run(tokens, detail, id);
  }

  /** The newest successful reply to `method` in a session. */
  latestReply(sessionId: number, method: string): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? AND method = ? AND kind = 'response' ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, method) as MessageRow | undefined;
  }

  /** All replies to tools/call in a session, oldest first, joined to their request. */
  toolCalls(sessionId: number): (MessageRow & { request_payload: string | null })[] {
    return this.db
      .prepare(
        `SELECT r.*, q.payload AS request_payload FROM messages r
         LEFT JOIN messages q ON q.id = r.request_id
         WHERE r.session_id = ? AND r.method = 'tools/call' AND r.kind IN ('response', 'error')
         ORDER BY r.id`,
      )
      .all(sessionId) as unknown as (MessageRow & { request_payload: string | null })[];
  }

  /** The closest earlier session with the same name, for "what changed" comparisons. */
  previousSession(sessionId: number): SessionRow | undefined {
    return this.db
      .prepare(
        `SELECT p.* FROM sessions s JOIN sessions p ON p.id < s.id
         WHERE s.id = ?
           AND ((s.name IS NOT NULL AND p.name = s.name) OR (s.name IS NULL AND p.name IS NULL AND p.command = s.command))
         ORDER BY p.id DESC LIMIT 1`,
      )
      .get(sessionId) as SessionRow | undefined;
  }

  saveExactCount(count: { message_id: number; model: string; tokens: number; detail: string | null }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO exact_counts (message_id, model, tokens, detail, counted_at)
         VALUES (:message_id, :model, :tokens, :detail, :counted_at)`,
      )
      .run({ ...count, counted_at: Date.now() });
  }

  exactCount(messageId: number, model: string): { tokens: number; detail: string | null } | undefined {
    return this.db
      .prepare('SELECT tokens, detail FROM exact_counts WHERE message_id = ? AND model = ?')
      .get(messageId, model) as { tokens: number; detail: string | null } | undefined;
  }

  /** The response (or error) recorded for a request, if any. */
  responseTo(requestId: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE request_id = ? LIMIT 1').get(requestId) as MessageRow | undefined;
  }

  /** Messages with id greater than afterId, oldest first, optionally for one session. */
  messagesAfter(afterId: number, options: { sessionId?: number; limit?: number } = {}): MessageRow[] {
    const limit = options.limit ?? 500;
    if (options.sessionId !== undefined) {
      return this.db
        .prepare('SELECT * FROM messages WHERE id > ? AND session_id = ? ORDER BY id LIMIT ?')
        .all(afterId, options.sessionId, limit) as unknown as MessageRow[];
    }
    return this.db
      .prepare('SELECT * FROM messages WHERE id > ? ORDER BY id LIMIT ?')
      .all(afterId, limit) as unknown as MessageRow[];
  }

  /** The id of the message `count` back from the newest, for "tail -n" style starts. */
  idBeforeLast(count: number, sessionId?: number): number {
    const row = (
      sessionId !== undefined
        ? this.db
            .prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?')
            .get(sessionId, count)
        : this.db.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?').get(count)
    ) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
