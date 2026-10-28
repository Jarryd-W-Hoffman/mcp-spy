import { errorSummary, requestSubject } from './format.js';
import type { MessageRow, MessageSummary } from './types.js';

export type { MessageDetail, MessageSummary, ServerEvent, SessionSummary } from './types.js';

/** The list-view form of a message: payload dropped, display fields added. */
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
