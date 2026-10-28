import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MessageKind } from './jsonrpc.js';

/** Who put the bytes on the wire. "stderr" is the server's log output. */
export type Direction = 'client' | 'server' | 'stderr';

export interface SessionRow {
  id: number;
  name: string | null;
  transport: string;
  command: string;
  cwd: string;
  pid: number | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  exit_signal: string | null;
}

export interface MessageRow {
  id: number;
  session_id: number;
  ts: number;
  direction: Direction;
  kind: MessageKind | 'log';
  method: string | null;
  rpc_id: string | null;
  payload: string;
  size: number;
  problem: string | null;
  request_id: number | null;
  latency_ms: number | null;
}

export type NewMessage = Omit<MessageRow, 'id'>;

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
  latency_ms REAL
);

CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS messages_request ON messages(request_id);
`;

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
    this.insertMessageStmt = this.db.prepare(`
      INSERT INTO messages (session_id, ts, direction, kind, method, rpc_id, payload, size, problem, request_id, latency_ms)
      VALUES (:session_id, :ts, :direction, :kind, :method, :rpc_id, :payload, :size, :problem, :request_id, :latency_ms)
    `);
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
