import { describe, expect, it } from 'vitest';
import { errorSummary, formatBytes, formatDuration, formatMessageLine, plain, requestSubject } from '../src/format.js';
import type { MessageRow } from '../src/store.js';

function row(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 5,
    session_id: 1,
    ts: new Date(2026, 9, 28, 9, 5, 7, 42).getTime(),
    direction: 'client',
    kind: 'request',
    method: 'tools/call',
    rpc_id: '3',
    payload: '{}',
    size: 120,
    problem: null,
    request_id: null,
    latency_ms: null,
    tokens: null,
    token_detail: null,
    issues: null,
    mock: null,
    ...overrides,
  };
}

describe('format helpers', () => {
  it('formats sizes and durations', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatDuration(0.2)).toBe('<1ms');
    expect(formatDuration(41.6)).toBe('42ms');
    expect(formatDuration(1500)).toBe('1.50s');
  });

  it('extracts the subject of tool, prompt and resource requests', () => {
    expect(requestSubject('tools/call', '{"params":{"name":"search"}}')).toBe('search');
    expect(requestSubject('resources/read', '{"params":{"uri":"file:///a"}}')).toBe('file:///a');
    expect(requestSubject('tools/list', '{"params":{}}')).toBeNull();
    expect(requestSubject('tools/call', 'nope')).toBeNull();
  });

  it('summarises JSON-RPC errors and tool errors', () => {
    expect(errorSummary(row({ payload: '{"error":{"code":-32601,"message":"Method not found"}}' }))).toBe(
      '-32601 Method not found',
    );
    expect(errorSummary(row({ payload: '{"result":{"isError":true,"content":[{"type":"text","text":"boom"}]}}' }))).toBe(
      'tool error: boom',
    );
    expect(errorSummary(row({ payload: '{"result":{}}' }))).toBeNull();
  });
});

describe('formatMessageLine', () => {
  const session = { id: 1, name: 'github' };

  it('formats requests', () => {
    expect(formatMessageLine(row({}), session, 'search', plain)).toBe(
      '09:05:07.042 github     #5 → tools/call search id=3 120B',
    );
  });

  it('formats successful and failed responses with latency', () => {
    const ok = row({ direction: 'server', kind: 'response', latency_ms: 31, tokens: 1520, payload: '{"result":{}}' });
    expect(formatMessageLine(ok, session, 'search', plain)).toBe(
      '09:05:07.042 github     #5 ← tools/call search ✓ 31ms ≈1.5k tok id=3 120B',
    );

    const failed = row({ direction: 'server', kind: 'error', payload: '{"error":{"code":1,"message":"bad"}}' });
    expect(formatMessageLine(failed, undefined, null, plain)).toBe(
      '09:05:07.042 #1         #5 ← tools/call ✗ 1 bad unmatched id=3 120B',
    );
  });

  it('counts schema issues', () => {
    const bad = row({ issues: JSON.stringify([{ severity: 'error', path: 'params.arguments', message: 'x' }]) });
    expect(formatMessageLine(bad, session, 'search', plain)).toBe('09:05:07.042 github     #5 → tools/call search ⚠ 1 issue id=3 120B');
  });

  it('labels mocked responses', () => {
    const mocked = row({ direction: 'server', kind: 'response', request_id: 1, latency_ms: 2, mock: 'rate limit' });
    expect(formatMessageLine(mocked, session, 'search', plain)).toContain('[mock: rate limit]');
  });

  it('formats stderr lines', () => {
    const log = row({ direction: 'stderr', kind: 'log', method: null, rpc_id: null, payload: 'listening' });
    expect(formatMessageLine(log, session, null, plain)).toBe('09:05:07.042 github     #5 stderr listening');
  });
});

describe('more formatting', () => {
  it('colours only terminals without NO_COLOR', async () => {
    const { colors, styleFor } = await import('../src/format.js');
    const previous = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      expect(styleFor({ isTTY: true })).toBe(colors);
      expect(styleFor({})).toBe(plain);
      process.env.NO_COLOR = '1';
      expect(styleFor({ isTTY: true })).toBe(plain);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
    expect(colors.red('x')).toBe('\x1b[31mx\x1b[0m');
  });

  it('formats every size', () => {
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0MB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.00GB');
  });

  it('has no subject without a name or uri', () => {
    expect(requestSubject('tools/call', '{"params":{"name":1}}')).toBeNull();
    expect(requestSubject('resources/read', '{"params":{"uri":"file:///a"}}')).toBe('file:///a');
    expect(requestSubject('resources/read', '{"params":{}}')).toBeNull();
  });

  it('summarises bare errors and tool errors without text', () => {
    expect(errorSummary(row({ payload: '{"error":{}}' }))).toBe('?');
    expect(errorSummary(row({ payload: '{"result":{"isError":true,"content":[]}}' }))).toBe('tool error');
  });

  it('formats invalid lines, long errors and several issues', () => {
    const invalid = row({ kind: 'invalid', direction: 'server', method: null, rpc_id: null, problem: null, payload: 'x'.repeat(100) });
    expect(formatMessageLine(invalid, undefined, null, plain)).toMatch(/← invalid {2}x{79}…$/);
    const flagged = row({ kind: 'invalid', direction: 'client', method: null, rpc_id: null, problem: 'not json', payload: 'oops' });
    expect(formatMessageLine(flagged, undefined, null, plain)).toMatch(/→ invalid not json oops$/);
    const issues = row({ issues: JSON.stringify([{}, {}]) });
    expect(formatMessageLine(issues, undefined, null, plain)).toContain('⚠ 2 issues');
  });
});
