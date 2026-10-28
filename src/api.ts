import { errorSummary, requestSubject } from './format.js';
import type { MessageRow, SessionRow } from './store.js';

/** Shapes served by the UI server's JSON API. Shared with the web UI. */

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

export function toSummary(message: MessageRow): MessageSummary {
  const { payload, ...rest } = message;
  const isReply = message.kind === 'response' || message.kind === 'error';
  return {
    ...rest,
    subject: message.kind === 'request' || message.kind === 'notification' ? requestSubject(message.method, payload) : null,
    error: isReply ? errorSummary(message) : null,
    preview: message.kind === 'log' || message.kind === 'invalid' ? payload.slice(0, 500) : null,
  };
}
