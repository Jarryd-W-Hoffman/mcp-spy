import type { Issue, MessageSummary } from '../../src/types.js';

export type ExchangeStatus = 'pending' | 'ok' | 'error' | 'none';

/**
 * One row in the list: a request together with its response, or a message
 * that stands alone (notification, stderr line, invalid frame, or a response
 * whose request was never seen).
 */
export interface Exchange {
  id: number;
  primary: MessageSummary;
  response: MessageSummary | null;
  status: ExchangeStatus;
  /** Schema and protocol issues in the request and its response. */
  issues: Issue[];
}

export function buildExchanges(messages: Iterable<MessageSummary>): Exchange[] {
  const exchanges: Exchange[] = [];
  const byRequest = new Map<number, Exchange>();

  for (const message of messages) {
    if (message.request_id !== null) {
      const exchange = byRequest.get(message.request_id);
      if (exchange) {
        exchange.response = message;
        exchange.status = message.error ? 'error' : 'ok';
        exchange.issues = [...exchange.issues, ...message.issues];
        continue;
      }
    }

    const exchange: Exchange = {
      id: message.id,
      primary: message,
      response: null,
      status: statusOf(message),
      issues: message.issues,
    };
    exchanges.push(exchange);
    if (message.kind === 'request') byRequest.set(message.id, exchange);
  }

  return exchanges;
}

function statusOf(message: MessageSummary): ExchangeStatus {
  switch (message.kind) {
    case 'request':
      return 'pending';
    case 'response':
      return message.error ? 'error' : 'ok';
    case 'error':
    case 'invalid':
      return 'error';
    default:
      return 'none';
  }
}

export interface ExchangeFilter {
  sessionId: number | null;
  search: string;
  showNotifications: boolean;
  showLogs: boolean;
  errorsOnly: boolean;
  issuesOnly: boolean;
}

export function filterExchanges(exchanges: Exchange[], filter: ExchangeFilter): Exchange[] {
  const needle = filter.search.trim().toLowerCase();
  return exchanges.filter(({ primary, status, issues }) => {
    if (filter.sessionId !== null && primary.session_id !== filter.sessionId) return false;
    if (!filter.showNotifications && primary.kind === 'notification') return false;
    if (!filter.showLogs && primary.kind === 'log') return false;
    if (filter.errorsOnly && status !== 'error') return false;
    if (filter.issuesOnly && issues.length === 0) return false;
    if (needle === '') return true;
    return [primary.method, primary.subject, primary.preview, primary.rpc_id]
      .some((field) => field?.toLowerCase().includes(needle));
  });
}
