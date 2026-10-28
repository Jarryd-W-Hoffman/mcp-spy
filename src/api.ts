import { errorSummary, requestSubject } from './format.js';
import type { Issue, MessageRow, MessageSummary } from './types.js';

export type { MessageDetail, MessageSummary, ServerEvent, SessionSummary, ToolsReport } from './types.js';

/** The list-view form of a message: payload dropped, display fields added. */
export function toSummary(message: MessageRow): MessageSummary {
  const { payload, token_detail: _detail, issues, ...rest } = message;
  const isReply = message.kind === 'response' || message.kind === 'error';
  return {
    ...rest,
    issues: issues ? (JSON.parse(issues) as Issue[]) : [],
    subject: message.kind === 'request' || message.kind === 'notification' ? requestSubject(message.method, payload) : null,
    error: isReply ? errorSummary(message) : null,
    preview: message.kind === 'log' || message.kind === 'invalid' ? payload.slice(0, 500) : null,
  };
}
