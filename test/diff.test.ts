import { describe, expect, it } from 'vitest';
import { comparableBody, diffJson, diffLines, hunks, jsonLines } from '../src/diff.js';

describe('diffJson', () => {
  it('reports leaf changes with paths', () => {
    const before = { name: 'a', schema: { required: ['q'], props: { q: 1 } }, list: [1, 2, 3] };
    const after = { name: 'a', schema: { required: ['q', 'r'], props: { q: 2 } }, list: [1, 2], 'odd key': true };
    expect(diffJson(before, after)).toEqual([
      { path: 'schema.required[1]', type: 'added', after: 'r' },
      { path: 'schema.props.q', type: 'changed', before: 1, after: 2 },
      { path: 'list[2]', type: 'removed', before: 3 },
      { path: '["odd key"]', type: 'added', after: true },
    ]);
  });

  it('treats a type change as a single change', () => {
    expect(diffJson({ a: [1] }, { a: { 0: 1 } })).toEqual([{ path: 'a', type: 'changed', before: [1], after: { 0: 1 } }]);
    expect(diffJson(1, 1)).toEqual([]);
    expect(diffJson('x', 'y')).toEqual([{ path: '(root)', type: 'changed', before: 'x', after: 'y' }]);
  });
});

describe('diffLines', () => {
  const apply = (ops: ReturnType<typeof diffLines>) => ({
    before: ops.filter((op) => op.type !== 'insert').map((op) => op.text),
    after: ops.filter((op) => op.type !== 'delete').map((op) => op.text),
  });

  it('produces a minimal edit script that reconstructs both sides', () => {
    const before = ['a', 'b', 'c', 'a', 'b', 'b', 'a'];
    const after = ['c', 'b', 'a', 'b', 'a', 'c'];
    const ops = diffLines(before, after);
    expect(apply(ops)).toEqual({ before, after });
    expect(ops.filter((op) => op.type !== 'equal')).toHaveLength(5); // the classic Myers example: D = 5
  });

  it('numbers lines on both sides', () => {
    const ops = diffLines(['x', 'y', 'z'], ['x', 'Y', 'z', 'w']);
    expect(ops).toEqual([
      { type: 'equal', text: 'x', beforeLine: 1, afterLine: 1 },
      { type: 'delete', text: 'y', beforeLine: 2, afterLine: null },
      { type: 'insert', text: 'Y', beforeLine: null, afterLine: 2 },
      { type: 'equal', text: 'z', beforeLine: 3, afterLine: 3 },
      { type: 'insert', text: 'w', beforeLine: null, afterLine: 4 },
    ]);
  });

  it('handles empty and identical inputs', () => {
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines([], ['a'])).toEqual([{ type: 'insert', text: 'a', beforeLine: null, afterLine: 1 }]);
    expect(diffLines(['a'], ['a']).every((op) => op.type === 'equal')).toBe(true);
  });

  it('is fast enough for large payloads with small edits', () => {
    const before = Array.from({ length: 20_000 }, (_, index) => `line ${index}`);
    const after = [...before];
    after[10_000] = 'changed';
    const started = performance.now();
    expect(diffLines(before, after).filter((op) => op.type !== 'equal')).toHaveLength(2);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('hunks', () => {
  it('groups changes with context and merges nearby ones', () => {
    const before = Array.from({ length: 20 }, (_, index) => String(index));
    const after = [...before];
    after[2] = 'two';
    after[5] = 'five';
    after[17] = 'seventeen';
    const groups = hunks(diffLines(before, after), 2);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ beforeStart: 1, afterStart: 1 });
    expect(groups[1]!.ops.map((op) => op.text)).toEqual(['15', '16', '17', 'seventeen', '18', '19']);
  });
});

describe('helpers', () => {
  it('sorts keys when pretty-printing', () => {
    expect(jsonLines({ b: 1, a: { d: 1, c: 2 } })).toEqual(['{', '  "a": {', '    "c": 2,', '    "d": 1', '  },', '  "b": 1', '}']);
  });

  it('compares params, results or errors rather than whole envelopes', () => {
    expect(comparableBody('{"jsonrpc":"2.0","id":1,"method":"x","params":{"a":1}}')).toEqual({ a: 1 });
    expect(comparableBody('{"jsonrpc":"2.0","id":1,"result":{"b":2}}')).toEqual({ b: 2 });
    expect(comparableBody('{"jsonrpc":"2.0","id":1,"error":{"code":1}}')).toEqual({ error: { code: 1 } });
    expect(comparableBody('nope')).toBe('nope');
  });
});
