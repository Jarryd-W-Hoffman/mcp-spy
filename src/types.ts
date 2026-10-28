/**
 * Types shared by the CLI, the UI server and the web UI. Keep this file free
 * of runtime imports so the browser bundle can use it.
 */

export type MessageKind = 'request' | 'notification' | 'response' | 'error' | 'invalid';

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

export type SessionSummary = SessionRow & { message_count: number };

/** A message without its payload, plus the bits the list view needs. */
export interface MessageSummary extends Omit<MessageRow, 'payload'> {
  /** Tool, prompt or resource a request is about. */
  subject: string | null;
  /** Error text for JSON-RPC errors and tool results flagged isError. */
  error: string | null;
  /** Start of the payload, for stderr and invalid lines. */
  preview: string | null;
}

export interface MessageDetail {
  message: MessageRow;
  request: MessageRow | null;
  response: MessageRow | null;
}

export type ServerEvent =
  | { type: 'messages'; messages: MessageSummary[] }
  | { type: 'sessions'; sessions: SessionSummary[] };
