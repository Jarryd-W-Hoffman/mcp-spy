/**
 * JSON diffing for comparing two messages: a structural list of changed
 * paths, and a line diff of the pretty-printed JSON. No runtime imports, so
 * the web UI can use it too.
 */

export type JsonChange =
  | { path: string; type: 'added'; after: unknown }
  | { path: string; type: 'removed'; before: unknown }
  | { path: string; type: 'changed'; before: unknown; after: unknown };

/** Leaf-level differences between two JSON values, in document order. */
export function diffJson(before: unknown, after: unknown, path = ''): JsonChange[] {
  if (Object.is(before, after)) return [];

  const beforeIsArray = Array.isArray(before);
  const afterIsArray = Array.isArray(after);
  if (beforeIsArray && afterIsArray) {
    const key = identityKey(before, after);
    if (key) return diffKeyedArrays(before as Record<string, unknown>[], after as Record<string, unknown>[], key, path);

    const changes: JsonChange[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index++) {
      const childPath = `${path}[${index}]`;
      if (index >= before.length) changes.push({ path: childPath, type: 'added', after: after[index] });
      else if (index >= after.length) changes.push({ path: childPath, type: 'removed', before: before[index] });
      else changes.push(...diffJson(before[index], after[index], childPath));
    }
    return changes;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const changes: JsonChange[] = [];
    for (const key of Object.keys(before)) {
      const childPath = joinPath(path, key);
      if (!(key in after)) changes.push({ path: childPath, type: 'removed', before: before[key] });
      else changes.push(...diffJson(before[key], after[key], childPath));
    }
    for (const key of Object.keys(after)) {
      if (!(key in before)) changes.push({ path: joinPath(path, key), type: 'added', after: after[key] });
    }
    return changes;
  }

  return [{ path: path || '(root)', type: 'changed', before, after }];
}

/**
 * Lists of tools, prompts or resources are compared by name (or uri), so a
 * removed entry doesn't show up as every later entry having changed.
 */
function identityKey(before: unknown[], after: unknown[]): 'name' | 'uri' | null {
  for (const key of ['name', 'uri'] as const) {
    const unique = (items: unknown[]) => {
      const values = items.map((item) => (isPlainObject(item) && typeof item[key] === 'string' ? item[key] : null));
      return values.every((value) => value !== null) && new Set(values).size === values.length;
    };
    if (before.length + after.length > 0 && unique(before) && unique(after)) return key;
  }
  return null;
}

function diffKeyedArrays(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  key: 'name' | 'uri',
  path: string,
): JsonChange[] {
  const label = (item: Record<string, unknown>) => `${path}[${key}=${JSON.stringify(item[key])}]`;
  const afterByKey = new Map(after.map((item) => [item[key], item]));
  const beforeKeys = new Set(before.map((item) => item[key]));
  const changes: JsonChange[] = [];
  for (const item of before) {
    const match = afterByKey.get(item[key]);
    if (match) changes.push(...diffJson(item, match, label(item)));
    else changes.push({ path: label(item), type: 'removed', before: item });
  }
  for (const item of after) {
    if (!beforeKeys.has(item[key])) changes.push({ path: label(item), type: 'added', after: item });
  }
  return changes;
}

function joinPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pretty-printed JSON with object keys sorted, split into lines. */
export function jsonLines(value: unknown): string[] {
  const sorted = JSON.stringify(
    value,
    (_key, item: unknown) =>
      isPlainObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item,
    2,
  );
  return (sorted ?? 'undefined').split('\n');
}

export interface LineOp {
  type: 'equal' | 'delete' | 'insert';
  text: string;
  /** 1-based line numbers in the before / after text. */
  beforeLine: number | null;
  afterLine: number | null;
}

/** Shortest edit script between two lists of lines (Myers, O((N+M)·D)). */
export function diffLines(before: string[], after: string[]): LineOp[] {
  // Trim the common prefix and suffix; most JSON diffs are small edits.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const middle = myers(a, b);

  const ops: LineOp[] = [];
  for (let index = 0; index < start; index++) {
    ops.push({ type: 'equal', text: before[index]!, beforeLine: index + 1, afterLine: index + 1 });
  }
  let beforeLine = start;
  let afterLine = start;
  for (const type of middle) {
    if (type === 'equal') ops.push({ type, text: a[beforeLine - start]!, beforeLine: ++beforeLine, afterLine: ++afterLine });
    else if (type === 'delete') ops.push({ type, text: a[beforeLine - start]!, beforeLine: ++beforeLine, afterLine: null });
    else ops.push({ type, text: b[afterLine - start]!, beforeLine: null, afterLine: ++afterLine });
  }
  for (let index = endBefore; index < before.length; index++) {
    ops.push({ type: 'equal', text: before[index]!, beforeLine: index + 1, afterLine: endAfter + (index - endBefore) + 1 });
  }
  return ops;
}

function myers(a: string[], b: string[]): LineOp['type'][] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Walk the trace backwards to recover the path.
  const ops: LineOp['type'][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const previous = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && previous[offset + k - 1]! < previous[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = previous[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('equal');
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? 'insert' : 'delete');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface Hunk {
  ops: LineOp[];
  beforeStart: number;
  afterStart: number;
}

/** Groups a line diff into hunks with `context` unchanged lines around each change. */
export function hunks(ops: LineOp[], context = 3): Hunk[] {
  const changed = ops.map((op, index) => (op.type === 'equal' ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return [];

  const ranges: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  return ranges.map(([from, to]) => {
    const slice = ops.slice(from, to + 1);
    const firstBefore = slice.find((op) => op.beforeLine !== null)?.beforeLine ?? 0;
    const firstAfter = slice.find((op) => op.afterLine !== null)?.afterLine ?? 0;
    return { ops: slice, beforeStart: firstBefore, afterStart: firstAfter };
  });
}

/** The part of a JSON-RPC message worth comparing: params, result or error. */
export function comparableBody(payload: string): unknown {
  try {
    const message = JSON.parse(payload) as Record<string, unknown>;
    if ('method' in message) return message.params ?? null;
    if ('result' in message) return message.result;
    if ('error' in message) return { error: message.error };
    return message;
  } catch {
    return payload;
  }
}
