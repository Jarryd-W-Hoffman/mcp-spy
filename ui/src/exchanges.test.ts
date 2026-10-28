import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../src/types.js';
import { buildExchanges, filterExchanges, type ExchangeFilter } from './exchanges';

let nextId = 1;
function message(overrides: Partial<MessageSummary>): MessageSummary {
  return {
    id: nextId++,
    session_id: 1,
    ts: 0,
    direction: 'client',
    kind: 'request',
    method: 'tools/call',
    rpc_id: '1',
    size: 10,
    problem: null,
    request_id: null,
    latency_ms: null,
    tokens: null,
    issues: [],
    subject: null,
    error: null,
    preview: null,
    ...overrides,
  };
}

const allVisible: ExchangeFilter = { sessionId: null, search: '', showNotifications: true, showLogs: true, errorsOnly: false, issuesOnly: false };

describe('buildExchanges', () => {
  it('folds responses into their request', () => {
    const request = message({ subject: 'search' });
    const response = message({ direction: 'server', kind: 'response', request_id: request.id, latency_ms: 12 });
    const [exchange, ...rest] = buildExchanges([request, response]);
    expect(rest).toEqual([]);
    expect(exchange).toMatchObject({ id: request.id, response, status: 'ok' });
  });

  it('marks unanswered requests pending and failed ones as errors', () => {
    const pending = message({});
    const failing = message({ rpc_id: '2' });
    const failure = message({ direction: 'server', kind: 'error', request_id: failing.id, error: '-1 boom' });
    expect(buildExchanges([pending, failing, failure]).map((e) => e.status)).toEqual(['pending', 'error']);
  });

  it('keeps notifications, logs and orphaned responses as their own rows', () => {
    const rows = buildExchanges([
      message({ kind: 'notification', rpc_id: null }),
      message({ direction: 'stderr', kind: 'log', method: null, rpc_id: null, preview: 'hi' }),
      message({ direction: 'server', kind: 'response', request_id: 999 }),
    ]);
    expect(rows.map((e) => [e.primary.kind, e.status])).toEqual([
      ['notification', 'none'],
      ['log', 'none'],
      ['response', 'ok'],
    ]);
  });
});

describe('exchange issues', () => {
  it('collects issues from the request and its response, and filters on them', () => {
    const issue = { severity: 'error' as const, path: 'params.arguments', message: 'x' };
    const request = message({ issues: [issue] });
    const response = message({ direction: 'server', kind: 'response', request_id: request.id, issues: [{ ...issue, path: 'result' }] });
    const clean = message({ rpc_id: '9' });
    const rows = buildExchanges([request, response, clean]);
    expect(rows[0]!.issues.map((i) => i.path)).toEqual(['params.arguments', 'result']);
    expect(filterExchanges(rows, { ...allVisible, issuesOnly: true }).map((e) => e.id)).toEqual([request.id]);
  });
});

describe('filterExchanges', () => {
  const rows = buildExchanges([
    message({ session_id: 1, subject: 'search_issues' }),
    message({ session_id: 2, kind: 'notification', method: 'notifications/initialized', rpc_id: null }),
    message({ session_id: 2, direction: 'stderr', kind: 'log', method: null, rpc_id: null, preview: 'Listening' }),
    message({ session_id: 2, direction: 'server', kind: 'error', request_id: null, error: 'bad' }),
  ]);

  it('filters by session, kind and errors', () => {
    expect(filterExchanges(rows, { ...allVisible, sessionId: 1 })).toHaveLength(1);
    expect(filterExchanges(rows, { ...allVisible, showNotifications: false, showLogs: false })).toHaveLength(2);
    expect(filterExchanges(rows, { ...allVisible, errorsOnly: true }).map((e) => e.primary.kind)).toEqual(['error']);
  });

  it('searches method, subject and log text', () => {
    expect(filterExchanges(rows, { ...allVisible, search: 'SEARCH' })).toHaveLength(1);
    expect(filterExchanges(rows, { ...allVisible, search: 'listening' })).toHaveLength(1);
  });
});
