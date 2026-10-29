import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPrune, parseAge, parseRetention, parseSize, planPrune } from '../src/prune.js';
import { Recorder } from '../src/recorder.js';
import { Store } from '../src/store.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 29);

describe('pruning the log', () => {
  let store: Store;
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), 'mcpspy-prune-')), 'log.db');
    store = new Store(path);
  });
  afterEach(() => store.close());

  /** A finished session `daysAgo` old, with `calls` request/response pairs of `size` bytes each. */
  function session(name: string, daysAgo: number, { calls = 3, size = 100, running = false } = {}): number {
    const start = NOW - daysAgo * DAY;
    const id = store.createSession({ name, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: start });
    const recorder = new Recorder(store, id, () => start);
    for (let i = 1; i <= calls; i++) {
      recorder.frame('client', JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'x', arguments: { pad: 'p'.repeat(size) } } }));
      recorder.frame('server', JSON.stringify({ jsonrpc: '2.0', id: i, result: { content: [{ type: 'text', text: 'r'.repeat(size) }] } }));
    }
    if (!running) store.endSession(id, { ended_at: start + 1000, exit_code: 0, exit_signal: null });
    return id;
  }
  const names = (plan: ReturnType<typeof planPrune>) => plan.sessions.map((s) => s.name);

  it('picks sessions by age, oldest first', () => {
    session('old', 40);
    session('older', 60);
    session('recent', 2);
    const plan = planPrune(store, { olderThanMs: 30 * DAY }, NOW);
    expect(names(plan)).toEqual(['older', 'old']);
    expect(plan).toMatchObject({ messages: 12, total: 3, running: 0 });
  });

  it('keeps the most recently active sessions', () => {
    session('a', 3);
    session('b', 2);
    session('c', 1);
    expect(names(planPrune(store, { keep: 1 }, NOW))).toEqual(['a', 'b']);
  });

  it('frees enough space to fit a size limit, oldest sessions first', () => {
    session('big-old', 9, { calls: 50, size: 4000 });
    session('big-new', 1, { calls: 50, size: 4000 });
    const { fileBytes, freeBytes } = store.size();
    const plan = planPrune(store, { maxBytes: Math.round((fileBytes - freeBytes) * 0.7) }, NOW);
    expect(names(plan)).toEqual(['big-old']);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(planPrune(store, { maxBytes: fileBytes * 2 }, NOW).sessions).toEqual([]);
  });

  it('never deletes a session that may still be running', () => {
    session('stalled', 30, { running: true }); // no activity for a month: crashed, not running
    const live = store.createSession({ name: 'live', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: NOW - 40 * DAY });
    new Recorder(store, live, () => NOW - 60_000).frame('client', '{"jsonrpc":"2.0","method":"notifications/initialized"}');
    const plan = planPrune(store, { keep: 0 }, NOW);
    expect(names(plan)).toEqual(['stalled']);
    expect(plan.running).toBe(1);
  });

  it('deletes a session with everything recorded in it, and nothing else', async () => {
    const doomed = session('doomed', 50, { calls: 2500 }); // more than one delete batch
    const kept = session('kept', 1);
    const [response] = store.messagesAfter(0, { sessionId: doomed }).filter((m) => m.kind === 'response');
    store.saveExactCount({ message_id: response!.id, model: 'm', tokens: 1, detail: null });

    await applyPrune(store, planPrune(store, { olderThanMs: 30 * DAY }, NOW), 0);
    expect(store.getSession(doomed)).toBeUndefined();
    expect(store.messagesAfter(0, { sessionId: doomed })).toEqual([]);
    expect(store.exactCount(response!.id, 'm')).toBeUndefined();
    expect(store.listSessions().map((s) => [s.id, s.message_count])).toEqual([[kept, 6]]);
  });

  it('shrinks the file when vacuumed', async () => {
    session('bulk', 50, { calls: 300, size: 2000 });
    session('small', 1);
    await applyPrune(store, planPrune(store, { olderThanMs: 30 * DAY }, NOW), 0);
    const before = statSync(path).size;
    expect(store.size().freeBytes).toBeGreaterThan(0);
    store.vacuum();
    expect(statSync(path).size).toBeLessThan(before / 2);
    expect(store.size().freeBytes).toBe(0);
  });
});

describe('prune settings', () => {
  it('parses ages, sizes and MCPSPY_RETENTION', () => {
    expect(parseAge('12h')).toBe(12 * 60 * 60 * 1000);
    expect(parseAge('30d')).toBe(30 * DAY);
    expect(parseAge('2w')).toBe(14 * DAY);
    expect(parseSize('500MB')).toBe(500 * 1024 * 1024);
    expect(parseSize('1.5 GB')).toBe(1.5 * 1024 ** 3);
    expect(parseRetention('30d, 1GB')).toEqual({ olderThanMs: 30 * DAY, maxBytes: 1024 ** 3 });
    expect(parseRetention('2GB')).toEqual({ maxBytes: 2 * 1024 ** 3 });
    expect(() => parseAge('30 days')).toThrow('use hours, days or weeks');
    expect(() => parseSize('1TB')).toThrow('use KB, MB or GB');
    expect(() => parseRetention(' , ')).toThrow('empty');
    expect(() => parseRetention('forever')).toThrow('"forever" is neither an age (12h, 30d, 8w) nor a size (500MB, 2GB)');
  });
});
