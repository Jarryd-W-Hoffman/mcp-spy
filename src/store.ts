import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { requestsLaterPage } from './jsonrpc.js';
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
  checked INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0
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
  ['sessions', 'message_count', 'INTEGER NOT NULL DEFAULT 0'],
];

/**
 * Created after migrations, since they use columns that older logs gain there.
 * The triggers keep sessions.message_count current for every writer, including
 * older mcpspy versions sharing the log; the partial indexes hold only the rows
 * that validate and the UI's startup backfill look for.
 */
const DERIVED = `
CREATE TRIGGER IF NOT EXISTS messages_count_insert AFTER INSERT ON messages BEGIN
  UPDATE sessions SET message_count = message_count + 1 WHERE id = NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS messages_count_delete AFTER DELETE ON messages BEGIN
  UPDATE sessions SET message_count = message_count - 1 WHERE id = OLD.session_id;
END;
CREATE INDEX IF NOT EXISTS messages_issues ON messages(id) WHERE issues IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_missing_tokens ON messages(id)
  WHERE tokens IS NULL AND kind IN ('response', 'error') AND method IN ('tools/list', 'tools/call', 'resources/read', 'prompts/get');
`;

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
        // Extended codes (busy recovery, busy snapshot…) keep SQLITE_BUSY in their low byte.
        if (((error as { errcode?: number }).errcode ?? 0) % 256 !== SQLITE_BUSY || Date.now() > deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  private migrate(): void {
    const columns = (table: string) =>
      new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));
    for (const [table, column, definition] of MIGRATIONS) {
      if (columns(table).has(column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      if (column === 'message_count') {
        this.db.exec('UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id)');
      }
    }
    this.db.exec(DERIVED);
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

  /** The newest sessions, or with `beforeId` the newest of those older than it. */
  listSessions(limit = 20, beforeId?: number): (SessionRow & { message_count: number })[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id < ? ORDER BY id DESC LIMIT ?')
      .all(beforeId ?? Number.MAX_SAFE_INTEGER, limit) as unknown as (SessionRow & { message_count: number })[];
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

  /**
   * The session's latest tool listing, with its pages (tools/list requests sent
   * with a cursor) joined into one tools/list response.
   */
  latestToolList(sessionId: number): ToolListing | undefined {
    const pages: MessageRow[] = [];
    const replies = this.db
      .prepare(
        `SELECT r.*, q.payload AS request_payload FROM messages r
         LEFT JOIN messages q ON q.id = r.request_id
         WHERE r.session_id = ? AND r.method = 'tools/list' AND r.kind = 'response'
         ORDER BY r.id DESC`,
      )
      .iterate(sessionId) as Iterable<MessageRow & { request_payload: string | null }>;
    for (const { request_payload, ...reply } of replies) {
      pages.unshift(reply);
      if (!requestsLaterPage(request_payload)) break;
    }
    return joinToolListPages(pages);
  }

  /**
   * The tool listing whose first page is the tools/list response `responseId`,
   * with the pages that followed it joined in. Undefined when that response is
   * a later page itself, or not a tools/list response.
   */
  toolListFrom(responseId: number): ToolListing | undefined {
    const first = this.getMessage(responseId);
    if (!first || first.method !== 'tools/list' || first.kind !== 'response') return undefined;
    const pages: MessageRow[] = [];
    const replies = this.db
      .prepare(
        `SELECT r.*, q.payload AS request_payload FROM messages r
         LEFT JOIN messages q ON q.id = r.request_id
         WHERE r.session_id = ? AND r.id >= ? AND r.method = 'tools/list' AND r.kind = 'response'
         ORDER BY r.id`,
      )
      .iterate(first.session_id, first.id) as Iterable<MessageRow & { request_payload: string | null }>;
    for (const { request_payload, ...reply } of replies) {
      const laterPage = requestsLaterPage(request_payload);
      if (pages.length === 0 ? laterPage : !laterPage) break;
      pages.push(reply);
    }
    return joinToolListPages(pages);
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

  /**
   * Every session with when it was last active (its last message, else its end
   * or start) and the payload bytes it holds, most recently active first.
   */
  sessionFootprints(): SessionFootprint[] {
    return this.db
      .prepare(
        `SELECT s.id, s.name, s.started_at, s.ended_at, s.message_count,
                max(coalesce((SELECT ts FROM messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1), 0),
                    coalesce(s.ended_at, 0), s.started_at) AS last_active,
                coalesce(b.bytes, 0) AS bytes
         FROM sessions s
         LEFT JOIN (SELECT session_id, sum(size) AS bytes FROM messages GROUP BY session_id) b ON b.session_id = s.id
         ORDER BY last_active DESC, s.id DESC`,
      )
      .all() as unknown as SessionFootprint[];
  }

  /**
   * Deletes a batch of a session's messages, newest first (a response refers to
   * the request before it), and the session itself once they're gone. Returns
   * true when the session is gone. One short transaction per batch, so other
   * processes recording to the log wait only briefly.
   */
  deleteSessionBatch(id: number, batch = 500): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { changes } = this.db
        .prepare('DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?)')
        .run(id, batch);
      if (changes === 0) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return changes === 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Runs `work` in one write transaction: all of it lands, or none. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The log's size on disk, and how much of it is free pages that new recordings reuse. */
  size(): { fileBytes: number; freeBytes: number } {
    const pragma = (name: string) => (this.db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]!;
    const pageSize = pragma('page_size');
    return { fileBytes: pragma('page_count') * pageSize, freeBytes: pragma('freelist_count') * pageSize };
  }

  /** Rewrites the log without its free pages, shrinking the file. Locks it while it runs. */
  vacuum(): void {
    this.db.exec('VACUUM');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }
}

export interface SessionFootprint {
  id: number;
  name: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
  /** When the session last recorded anything (ms since the epoch). */
  last_active: number;
  /** Payload bytes of its messages. */
  bytes: number;
}

/** A session's tool list, joined from however many pages the server sent it in. */
export interface ToolListing {
  /** The first page's response; its id keys exact token counts. */
  messageId: number;
  requestId: number | null;
  pages: number;
  /** A tools/list response holding every page's tools. */
  payload: string;
  tokens: number;
  tokenDetail: string | null;
}

/** One tools/list response holding the tools of every page, in order. */
function joinToolListPages(pages: MessageRow[]): ToolListing | undefined {
  const first = pages[0];
  if (!first) return undefined;

  const tools: unknown[] = [];
  const costs: unknown[] = [];
  for (const page of pages) {
    try {
      const listed = (JSON.parse(page.payload) as { result?: { tools?: unknown } }).result?.tools;
      if (Array.isArray(listed)) tools.push(...listed);
    } catch {
      // A malformed page was flagged when recorded; list what the others hold.
    }
    if (page.token_detail) costs.push(...(JSON.parse(page.token_detail) as unknown[]));
  }
  const rpcId = first.rpc_id === null ? null : (JSON.parse(first.rpc_id) as unknown);
  return {
    messageId: first.id,
    requestId: first.request_id,
    pages: pages.length,
    payload: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: { tools } }),
    tokens: pages.reduce((sum, page) => sum + (page.tokens ?? 0), 0),
    tokenDetail: costs.length > 0 ? JSON.stringify(costs) : null,
  };
}
