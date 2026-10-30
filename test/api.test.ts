import { describe, expect, it } from 'vitest';
import { toSummary } from '../src/api.js';
import type { MessageRow } from '../src/types.js';

const row = (overrides: Partial<MessageRow>): MessageRow => ({
  id: 1,
  session_id: 1,
  ts: 1,
  direction: 'server',
  kind: 'response',
  method: null,
  rpc_id: '1',
  payload: '{}',
  size: 2,
  problem: null,
  request_id: null,
  latency_ms: null,
  tokens: null,
  token_detail: null,
  issues: null,
  mock: null,
  ...overrides,
});

describe('toSummary', () => {
  it('parses issues and previews log lines', () => {
    const summary = toSummary(row({ kind: 'log', direction: 'stderr', payload: 'x'.repeat(600), issues: '[{"severity":"error","path":"","message":"m"}]' }));
    expect(summary.issues).toEqual([{ severity: 'error', path: '', message: 'm' }]);
    expect(summary.preview).toHaveLength(500);
    expect(summary).not.toHaveProperty('payload');
    expect(summary.error).toBeNull();
  });

  it('previews invalid lines and summarises errors', () => {
    expect(toSummary(row({ kind: 'invalid', payload: 'oops' })).preview).toBe('oops');
    expect(toSummary(row({ kind: 'error', payload: '{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"bad"}}' })).error).toContain('bad');
  });
});
