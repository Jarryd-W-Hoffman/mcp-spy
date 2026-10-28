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
  exit_signal TEXT,
  replay_of INTEGER,
  env_keys TEXT,
  checked INTEGER NOT NULL DEFAULT 0
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
  token_detail TEXT,
  issues TEXT,
  mock TEXT
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
const MIGRATIONS: [table: string, column: string, definition: string][] = [
  ['messages', 'tokens', 'INTEGER'],
  ['messages', 'token_detail', 'TEXT'],
  ['sessions', 'replay_of', 'INTEGER'],
  ['sessions', 'env_keys', 'TEXT'],
  ['messages', 'issues', 'TEXT'],
  ['sessions', 'checked', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'mock', 'TEXT'],
];

const SQLITE_BUSY = 5;

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
    // The timeout first: switching to WAL needs a lock, and an agent starting several
    // proxies at once means another process may hold it.
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.enableWal();
    // Under the write lock, so concurrent processes check for and add columns one at a time.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(SCHEMA);
      this.migrate();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.insertMessageStmt = this.db.prepare(`
      INSERT INTO messages (session_id, ts, direction, kind, method, rpc_id, payload, size, problem, request_id, latency_ms, tokens, token_detail, issues, mock)
      VALUES (:session_id, :ts, :direction, :kind, :method, :rpc_id, :payload, :size, :problem, :request_id, :latency_ms, :tokens, :token_detail, :issues, :mock)
    `);
  }

  /**
   * Switches to WAL, retrying while another process holds a write lock: SQLite
   * doesn't apply the busy timeout to this switch, since waiting could deadlock.
   */
  private enableWal(): void {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL');
        return;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== SQLITE_BUSY || Date.now() > deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  private migrate(): void {
    const columns = (table: string) =>
      new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
    for (const [table, column, definition] of MIGRATIONS) {
      if (!columns(table).has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createSession(
    session: Pick<SessionRow, 'name' | 'transport' | 'command' | 'cwd' | 'pid' | 'started_at'> &
      Partial<Pick<SessionRow, 'replay_of' | 'env_keys'>>,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO sessions (name, transport, command, cwd, pid, started_at, replay_of, env_keys, checked)
         VALUES (:name, :transport, :command, :cwd, :pid, :started_at, :replay_of, :env_keys, 1)`,
      )
      .run({ replay_of: null, env_keys: null, ...session });
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

  insertMessage(message: Omit<NewMessage, 'mock'> & { mock?: string | null }): number {
    return Number(this.insertMessageStmt.run({ mock: null, ...message }).lastInsertRowid);
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

  /** Sessions recorded before messages were validated as they arrived. */
  uncheckedSessions(): number[] {
    return (this.db.prepare('SELECT id FROM sessions WHERE checked = 0 ORDER BY id').all() as { id: number }[]).map((row) => row.id);
  }

  markChecked(sessionId: number): void {
    this.db.prepare('UPDATE sessions SET checked = 1 WHERE id = ?').run(sessionId);
  }

  setIssues(id: number, issues: string | null): void {
    this.db.prepare('UPDATE messages SET issues = ? WHERE id = ?').run(issues, id);
  }

  /** Messages with issues, newest first, optionally for one session. */
  messagesWithIssues(sessionId?: number, limit = 500): MessageRow[] {
    return (
      sessionId !== undefined
        ? this.db.prepare('SELECT * FROM messages WHERE issues IS NOT NULL AND session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit)
        : this.db.prepare('SELECT * FROM messages WHERE issues IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit)
    ) as unknown as MessageRow[];
  }

  setTokens(id: number, tokens: number, detail: string | null): void {
    this.db.prepare('UPDATE messages SET tokens = ?, token_detail = ? WHERE id = ?').run(tokens, detail, id);
  }

  /** The first request of a method a client sent in a session (e.g. its initialize). */
  firstRequest(sessionId: number, method: string): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? AND method = ? AND kind = 'request' AND direction = 'client' ORDER BY id LIMIT 1`,
      )
      .get(sessionId, method) as MessageRow | undefined;
  }

  /** The client's most recent reply to a server-initiated request method (e.g. roots/list). */
  clientReplyTo(sessionId: number, method: string): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? AND method = ? AND direction = 'client' AND kind IN ('response', 'error')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, method) as MessageRow | undefined;
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
        `SELECT p.* FROM sessions s JOIN sessions p ON p.id < s.id AND p.replay_of IS NULL
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
