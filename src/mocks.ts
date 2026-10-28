import { readFileSync, statSync } from 'node:fs';

/**
 * Mock rules: canned answers the proxy gives instead of (or before) the real
 * server, and tools it adds to the server's tool list. The same file drives
 * `mcpspy mock serve`, a stand-in server with no real one behind it.
 */
export interface MockFile {
  /** Shown as serverInfo by `mcpspy mock serve`. */
  server?: { name?: string; version?: string; instructions?: string };
  /** Tools to add to tools/list (replacing real ones with the same name). */
  tools?: MockTool[];
  rules?: MockRule[];
}

export interface MockTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface MockRule {
  name?: string;
  match: {
    /** JSON-RPC method; defaults to tools/call when `tool` is set. */
    method?: string;
    /** Tool name, with * wildcards. */
    tool?: string;
    /** Must be contained in the call's arguments (deep subset). */
    arguments?: Record<string, unknown>;
    /** Only for this server (the session's --name). */
    server?: string;
  };
  /** The JSON-RPC result to return. Strings may use {{params.x}} / {{arguments.x}}. */
  result?: unknown;
  /** A JSON-RPC error to return. */
  error?: { code: number; message: string; data?: unknown };
  /** Shorthand for a tool result with one text block. */
  text?: string;
  /** Shorthand for a tool result with isError: true and this text. */
  toolError?: string;
  /** Forward to the real server after delayMs instead of answering. */
  passthrough?: boolean;
  /** Never answer, to test client timeouts. */
  drop?: boolean;
  delayMs?: number;
  /** Stop matching after this many uses. */
  times?: number;
  /** Chance (0–1) the rule applies to a matching call, for flaky behaviour. */
  probability?: number;
}

export type MockDecision =
  | { action: 'respond'; rule: string; delayMs: number; reply: { result: unknown } | { error: { code: number; message: string; data?: unknown } } }
  | { action: 'passthrough'; rule: string; delayMs: number }
  | { action: 'drop'; rule: string };

const ACTIONS = ['result', 'error', 'text', 'toolError', 'passthrough', 'drop'] as const;

/** Parses and checks a mock file, with messages that point at the problem. */
export function parseMockFile(text: string): MockFile {
  const file = JSON.parse(text) as MockFile;
  if (typeof file !== 'object' || file === null || Array.isArray(file)) throw new Error('mock file must be a JSON object');
  if (file.rules !== undefined && !Array.isArray(file.rules)) throw new Error('"rules" must be an array');
  if (file.tools !== undefined && !Array.isArray(file.tools)) throw new Error('"tools" must be an array');

  (file.tools ?? []).forEach((tool, index) => {
    if (typeof tool?.name !== 'string') throw new Error(`tools[${index}] needs a name`);
    if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null) throw new Error(`tool "${tool.name}" needs an inputSchema`);
  });
  (file.rules ?? []).forEach((rule, index) => {
    const label = rule?.name ? `rule "${rule.name}"` : `rules[${index}]`;
    if (typeof rule?.match !== 'object' || rule.match === null) throw new Error(`${label} needs a "match" object`);
    const actions = ACTIONS.filter((action) => rule[action] !== undefined && rule[action] !== false);
    if (actions.length !== 1) {
      throw new Error(`${label} needs exactly one of ${ACTIONS.join(', ')} (has ${actions.length ? actions.join(', ') : 'none'})`);
    }
    if (rule.error && (typeof rule.error.code !== 'number' || typeof rule.error.message !== 'string')) {
      throw new Error(`${label}: error needs a numeric code and a message`);
    }
    if (rule.probability !== undefined && (rule.probability < 0 || rule.probability > 1)) {
      throw new Error(`${label}: probability must be between 0 and 1`);
    }
  });
  return file;
}

/**
 * Decides what to do with each request. Reloads the file when it changes on
 * disk, keeping the previous rules (and warning) if the new version is broken.
 */
export class MockEngine {
  private file: MockFile = {};
  private mtime = 0;
  private readonly uses = new Map<MockRule, number>();

  constructor(
    private readonly path: string | null,
    private readonly serverName: string | null,
    private readonly warn: (message: string) => void = () => {},
    initial?: MockFile,
    private readonly random: () => number = Math.random,
  ) {
    if (initial) this.file = initial;
    else this.load(true);
  }

  get tools(): MockTool[] {
    this.reload();
    return this.file.tools ?? [];
  }

  get server(): MockFile['server'] {
    return this.file.server;
  }

  /** The decision for a request, or null to forward it untouched. */
  decide(method: string, params: unknown): MockDecision | null {
    this.reload();
    const rules = this.file.rules ?? [];
    for (const [index, rule] of rules.entries()) {
      if (!this.matches(rule, method, params)) continue;
      const used = this.uses.get(rule) ?? 0;
      if (rule.times !== undefined && used >= rule.times) continue;
      if (rule.probability !== undefined && this.random() >= rule.probability) continue;
      this.uses.set(rule, used + 1);

      const name = rule.name ?? `rules[${index}]`;
      const delayMs = rule.delayMs ?? 0;
      if (rule.drop) return { action: 'drop', rule: name };
      if (rule.passthrough) return { action: 'passthrough', rule: name, delayMs };
      return { action: 'respond', rule: name, delayMs, reply: buildReply(rule, params) };
    }
    return null;
  }

  /** A tools/list result with the mock tools added (replacing same-named real ones). */
  patchToolList(result: unknown): unknown {
    const extra = this.tools;
    if (extra.length === 0 || typeof result !== 'object' || result === null) return result;
    const names = new Set(extra.map((tool) => tool.name));
    const real = Array.isArray((result as { tools?: unknown }).tools) ? (result as { tools: { name?: string }[] }).tools : [];
    return { ...result, tools: [...real.filter((tool) => !names.has(tool.name ?? '')), ...extra] };
  }

  private matches(rule: MockRule, method: string, params: unknown): boolean {
    const { match } = rule;
    const expectedMethod = match.method ?? (match.tool !== undefined || match.arguments !== undefined ? 'tools/call' : undefined);
    if (expectedMethod !== undefined && expectedMethod !== method) return false;
    if (match.server !== undefined && match.server !== this.serverName) return false;
    const call = (typeof params === 'object' && params !== null ? params : {}) as { name?: unknown; arguments?: unknown };
    if (match.tool !== undefined && !(typeof call.name === 'string' && glob(match.tool).test(call.name))) return false;
    if (match.arguments !== undefined && !containsSubset(call.arguments ?? {}, match.arguments)) return false;
    return true;
  }

  private load(initial: boolean): void {
    if (this.path === null) return;
    try {
      const mtime = statSync(this.path).mtimeMs;
      if (!initial && mtime === this.mtime) return;
      this.mtime = mtime;
      this.file = parseMockFile(readFileSync(this.path, 'utf8'));
      this.uses.clear();
      if (!initial) this.warn(`reloaded mock rules from ${this.path}`);
    } catch (error) {
      if (initial) throw new Error(`${this.path}: ${(error as Error).message}`);
      this.warn(`kept previous mock rules; ${this.path}: ${(error as Error).message}`);
    }
  }

  private reload(): void {
    this.load(false);
  }
}

function buildReply(rule: MockRule, params: unknown): { result: unknown } | { error: { code: number; message: string; data?: unknown } } {
  const context = { params, arguments: (params as { arguments?: unknown } | null)?.arguments ?? {} };
  if (rule.error) return { error: interpolate(rule.error, context) };
  if (rule.text !== undefined) return { result: { content: [{ type: 'text', text: interpolate(rule.text, context) }] } };
  if (rule.toolError !== undefined) {
    return { result: { content: [{ type: 'text', text: interpolate(rule.toolError, context) }], isError: true } };
  }
  return { result: interpolate(rule.result, context) };
}

/** Replaces {{path}} in strings with values from the request (stringified if not strings). */
export function interpolate<T>(value: T, context: Record<string, unknown>): T {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (whole, path: string) => {
      const found = lookup(context, path);
      return found === undefined ? whole : typeof found === 'string' ? found : JSON.stringify(found);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, context)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, context)])) as T;
  }
  return value;
}

function lookup(context: unknown, path: string): unknown {
  let current = context;
  for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/** True when every value in `subset` appears, recursively, in `value`. */
export function containsSubset(value: unknown, subset: unknown): boolean {
  if (typeof subset !== 'object' || subset === null) return Object.is(value, subset);
  if (Array.isArray(subset)) {
    return Array.isArray(value) && subset.length === value.length && subset.every((item, index) => containsSubset(value[index], item));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(subset).every(([key, item]) => containsSubset((value as Record<string, unknown>)[key], item));
}
