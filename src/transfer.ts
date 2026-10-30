import type { Store } from './store.js';
import type { Direction, MessageRow, SessionRow } from './types.js';

/** First line of an export, so import can tell a log file from anything else. */
const HEADER = { mcpspy: 'log', version: 1 };

export type ExportedSession = Omit<SessionRow, 'checked' | 'imported'>;
type Line = { session: ExportedSession } | { message: MessageRow };

/**
 * Writes sessions as JSON Lines: a header, then each session followed by its
 * messages, with the ids they have in this log. Payloads are as recorded, so
 * secrets mcpspy redacted stay redacted, and everything else is included.
 */
export function exportSessions(store: Store, sessionIds: number[], write: (line: string) => void): { sessions: number; messages: number } {
  write(JSON.stringify(HEADER));
  let messages = 0;
  for (const id of sessionIds) {
    const { checked: _checked, imported: _imported, message_count: _count, ...session } = store.getSession(id) as SessionRow & { message_count?: number };
    write(JSON.stringify({ session } satisfies Line));
    for (let after = 0, page: MessageRow[]; (page = store.messagesAfter(after, { sessionId: id })).length > 0; after = page.at(-1)!.id) {
      for (const message of page) write(JSON.stringify({ message } satisfies Line));
      messages += page.length;
    }
  }
  return { sessions: sessionIds.length, messages };
}

type Field = 'string' | 'number' | 'string?' | 'number?';

const SESSION_FIELDS: Record<keyof Omit<ExportedSession, 'id'>, Field> = {
  name: 'string?',
  transport: 'string',
  command: 'string',
  cwd: 'string',
  pid: 'number?',
  started_at: 'number',
  ended_at: 'number?',
  exit_code: 'number?',
  exit_signal: 'string?',
  replay_of: 'number?',
  env_keys: 'string?',
};

const MESSAGE_FIELDS: Record<keyof Omit<MessageRow, 'id' | 'session_id' | 'request_id'>, Field> = {
  ts: 'number',
  direction: 'string',
  kind: 'string',
  method: 'string?',
  rpc_id: 'string?',
  payload: 'string',
  size: 'number',
  problem: 'string?',
  latency_ms: 'number?',
  tokens: 'number?',
  token_detail: 'string?',
  issues: 'string?',
  mock: 'string?',
};

const DIRECTIONS = new Set<string>(['client', 'server', 'stderr'] satisfies Direction[]);
const KINDS = new Set<string>(['request', 'response', 'error', 'notification', 'invalid', 'log'] satisfies MessageRow['kind'][]);

/**
 * Reads an export into the log as new sessions, with new ids, marked as
 * imported so nothing starts the servers they name (see assertRecordedHere). References
 * between the imported rows (a message's session and request, a replay's
 * original session) are carried over; references to rows outside the file are
 * dropped. One transaction: a bad line imports nothing.
 */
export async function importSessions(store: Store, lines: AsyncIterable<string> | Iterable<string>): Promise<{ sessions: number[]; messages: number }> {
  const rows: Line[] = [];
  let number = 0;
  let header = false;
  for await (const text of lines) {
    number++;
    if (text.trim() === '') continue;
    const at = `line ${number}`;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${at} is not JSON`);
    }
    if (!header) {
      if (!isObject(value) || value.mcpspy !== HEADER.mcpspy) throw new Error('not an mcpspy export (it should start with {"mcpspy":"log",…})');
      if (value.version !== HEADER.version) throw new Error(`export version ${String(value.version)} isn't supported (this mcpspy reads version ${HEADER.version})`);
      header = true;
      continue;
    }
    rows.push(parseLine(value, at));
  }
  if (!header) throw new Error('the file is empty');

  return store.transaction(() => {
    const sessionIds = new Map<number, number>();
    const messageIds = new Map<number, number>();
    const created: number[] = [];
    let messages = 0;
    for (const row of rows) {
      if ('session' in row) {
        const { id, ended_at, exit_code, exit_signal, replay_of, ...session } = row.session;
        const newId = store.createSession({ ...session, imported: 1, replay_of: replay_of === null ? null : (sessionIds.get(replay_of) ?? null) });
        if (ended_at !== null) store.endSession(newId, { ended_at, exit_code, exit_signal });
        sessionIds.set(id, newId);
        created.push(newId);
        continue;
      }
      const { id, session_id, request_id, ...message } = row.message;
      const sessionId = sessionIds.get(session_id);
      if (sessionId === undefined) throw new Error(`message ${id} belongs to session ${session_id}, which comes later in the file or not at all`);
      const newId = store.insertMessage({ ...message, session_id: sessionId, request_id: request_id === null ? null : (messageIds.get(request_id) ?? null) } as MessageRow);
      messageIds.set(id, newId);
      messages++;
    }
    return { sessions: created, messages };
  });
}

function parseLine(value: unknown, at: string): Line {
  if (isObject(value) && isObject(value.session)) {
    return { session: checkFields(value.session, { id: 'number', ...SESSION_FIELDS }, `${at} (session)`) as unknown as ExportedSession };
  }
  if (isObject(value) && isObject(value.message)) {
    const message = checkFields(value.message, { id: 'number', session_id: 'number', request_id: 'number?', ...MESSAGE_FIELDS }, `${at} (message)`) as unknown as MessageRow;
    if (!DIRECTIONS.has(message.direction)) throw new Error(`${at} (message): unknown direction "${message.direction}"`);
    if (!KINDS.has(message.kind)) throw new Error(`${at} (message): unknown kind "${message.kind}"`);
    return { message };
  }
  throw new Error(`${at} is neither a session nor a message`);
}

/** The fields named, type-checked; anything else in the row is ignored. */
function checkFields(row: Record<string, unknown>, fields: Record<string, Field>, at: string): Record<string, unknown> {
  const checked: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const value = row[name];
    const optional = field.endsWith('?');
    const type = optional ? field.slice(0, -1) : field;
    if ((optional && (value === null || value === undefined)) || typeof value === type) {
      checked[name] = value ?? null;
      continue;
    }
    throw new Error(`${at}: "${name}" should be a ${type}${optional ? ' or null' : ''}`);
  }
  return checked;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
