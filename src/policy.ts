import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A policy decides which requests an agent may send a server. Rules are
 * checked in order and the first that matches decides; tool calls no rule
 * matches get the default, which is deny unless the file says otherwise.
 * Other methods (initialize, tools/list, …) pass unless a rule names them.
 */
export interface PolicyFile {
  default?: 'allow' | 'deny';
  rules?: PolicyRule[];
  results?: ResultLimits;
}

export interface PolicyRule {
  name?: string;
  /** Tool name, with * wildcards; implies method tools/call. */
  tool?: string;
  /** JSON-RPC method; defaults to tools/call. */
  method?: string;
  /** Only for this server (the session's --name), with * wildcards. */
  server?: string;
  /** Tests on the call's arguments (or a request's params), by dot path. All must pass for the rule to match. */
  where?: Record<string, ValueTest>;
  allow?: true;
  /** Denies with this reason, shown to the agent. */
  deny?: string;
  /** Holds the call and asks the agent's user, with this prompt, whether to let it through (stdio only). */
  ask?: string;
  /** On allow rules: at most this many matching calls per period, e.g. "10/minute". */
  rate?: string;
}

export interface ValueTest {
  /** A path inside one of these directories (relative to the policy file), after resolving symlinks. */
  under?: string | string[];
  /** One of these values. */
  in?: unknown[];
  /** A string matching this regular expression. */
  match?: string;
  /** A string not matching this regular expression. */
  notMatch?: string;
  /** A number no larger than this. */
  max?: number;
  /** A string no longer than this. */
  maxLength?: number;
}

export interface ResultLimits {
  /** Tool results larger than this (as JSON) are replaced with an error. */
  maxBytes?: number;
  /** Regular expressions whose matches are replaced in what the agent receives. */
  redact?: string[];
}

/**
 * An ask is a refusal that carries the prompt to ask with, so anything that
 * can't ask refuses the call.
 */
export type Verdict = { allow: true; rule: string | null } | { allow: false; rule: string; reason: string; ask?: string };

const PERIODS: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const TESTS = ['under', 'in', 'match', 'notMatch', 'max', 'maxLength'];
const RULE_KEYS = ['name', 'tool', 'method', 'server', 'where', 'allow', 'deny', 'ask', 'rate'];

interface CompiledRule {
  name: string;
  method: string;
  tool: RegExp | null;
  server: RegExp | null;
  where: [string[], CompiledTest][];
  deny: string | null;
  ask: string | null;
  rate: { limit: number; periodMs: number; label: string } | null;
}

/** Takes the value and the server's directory, which relative paths are resolved against. */
type CompiledTest = (value: unknown, cwd: string) => boolean;

export interface CompiledPolicy {
  defaultAllow: boolean;
  rules: CompiledRule[];
  maxBytes: number | null;
  redact: RegExp[];
}

/**
 * Parses a policy, rejecting anything it doesn't understand: a typo must
 * never quietly widen what an agent may do. `base` is the directory `under`
 * paths are relative to.
 */
export function parsePolicy(text: string, base: string): CompiledPolicy {
  let file: PolicyFile;
  try {
    file = JSON.parse(text) as PolicyFile;
  } catch (error) {
    throw new Error(`not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(file)) throw new Error('policy must be a JSON object');
  unknownKeys(file, ['default', 'rules', 'results'], 'policy');
  if (file.default !== undefined && file.default !== 'allow' && file.default !== 'deny') throw new Error('"default" must be "allow" or "deny"');
  if (file.rules !== undefined && !Array.isArray(file.rules)) throw new Error('"rules" must be an array');

  const rules = (file.rules ?? []).map((rule: unknown, index) => compileRule(rule, index, base));

  let maxBytes: number | null = null;
  let redact: RegExp[] = [];
  if (file.results !== undefined) {
    if (!isObject(file.results)) throw new Error('"results" must be an object');
    unknownKeys(file.results, ['maxBytes', 'redact'], '"results"');
    if (file.results.maxBytes !== undefined) {
      if (!isCount(file.results.maxBytes)) throw new Error('"results.maxBytes" must be a positive whole number');
      maxBytes = file.results.maxBytes;
    }
    if (file.results.redact !== undefined) {
      if (!Array.isArray(file.results.redact)) throw new Error('"results.redact" must be an array of regular expressions');
      redact = file.results.redact.map((pattern, index) => regex(pattern, `results.redact[${index}]`, 'g'));
    }
  }
  return { defaultAllow: file.default === 'allow', rules, maxBytes, redact };
}

function compileRule(raw: unknown, index: number, base: string): CompiledRule {
  if (!isObject(raw)) throw new Error(`rules[${index}] must be an object`);
  // Checked field by field below, before anything relies on the types.
  const rule = raw as PolicyRule;
  const label = typeof rule.name === 'string' ? `rule "${rule.name}"` : `rules[${index}]`;
  unknownKeys(rule, RULE_KEYS, label);
  if (rule.name !== undefined && typeof rule.name !== 'string') throw new Error(`${label}: "name" must be a string`);
  for (const key of ['tool', 'method', 'server'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`${label}: "${key}" must be a string`);
  }
  if (rule.tool !== undefined && rule.method !== undefined && rule.method !== 'tools/call') {
    throw new Error(`${label}: "tool" only applies to tools/call`);
  }
  if (rule.allow !== undefined && rule.allow !== true) throw new Error(`${label}: "allow" must be true`);
  if (rule.deny !== undefined && (typeof rule.deny !== 'string' || rule.deny === '')) throw new Error(`${label}: "deny" must be a reason`);
  if (rule.ask !== undefined && (typeof rule.ask !== 'string' || rule.ask === '')) throw new Error(`${label}: "ask" must be a prompt`);
  if ([rule.allow, rule.deny, rule.ask].filter((action) => action !== undefined).length !== 1) {
    throw new Error(`${label} needs exactly one of "allow": true, "deny": "<reason>" or "ask": "<prompt>"`);
  }
  if (rule.rate !== undefined && rule.allow === undefined) throw new Error(`${label}: "rate" only applies to allow rules`);

  const where: [string[], CompiledTest][] = [];
  if (rule.where !== undefined) {
    if (!isObject(raw.where)) throw new Error(`${label}: "where" must be an object`);
    for (const [path, test] of Object.entries(raw.where)) where.push([path.split('.'), compileTest(test, `${label}: where "${path}"`, base)]);
  }

  return {
    name: rule.name ?? `rules[${index}]`,
    method: rule.method ?? 'tools/call',
    tool: rule.tool !== undefined ? glob(rule.tool) : null,
    server: rule.server !== undefined ? glob(rule.server) : null,
    where,
    deny: rule.deny ?? null,
    ask: rule.ask ?? null,
    rate: rule.rate !== undefined ? parseRate(rule.rate, label) : null,
  };
}

function compileTest(raw: unknown, label: string, base: string): CompiledTest {
  if (!isObject(raw)) throw new Error(`${label} must be an object of tests`);
  const test = raw as ValueTest;
  unknownKeys(test, TESTS, label);
  const checks: CompiledTest[] = [];
  if (test.under !== undefined) {
    const roots = (Array.isArray(test.under) ? test.under : [test.under]).map((root) => {
      if (typeof root !== 'string') throw new Error(`${label}: "under" must be a path or a list of paths`);
      return realish(resolve(base, root));
    });
    checks.push((value, cwd) => typeof value === 'string' && isUnder(value, roots, cwd));
  }
  if (test.in !== undefined) {
    if (!Array.isArray(test.in)) throw new Error(`${label}: "in" must be a list of values`);
    const allowed = test.in;
    checks.push((value) => allowed.some((item) => Object.is(item, value)));
  }
  if (test.match !== undefined) {
    const pattern = regex(test.match, `${label}: "match"`);
    checks.push((value) => typeof value === 'string' && pattern.test(value));
  }
  if (test.notMatch !== undefined) {
    const pattern = regex(test.notMatch, `${label}: "notMatch"`);
    checks.push((value) => typeof value === 'string' && !pattern.test(value));
  }
  if (test.max !== undefined) {
    if (typeof test.max !== 'number') throw new Error(`${label}: "max" must be a number`);
    const max = test.max;
    checks.push((value) => typeof value === 'number' && value <= max);
  }
  if (test.maxLength !== undefined) {
    if (!isCount(test.maxLength)) throw new Error(`${label}: "maxLength" must be a positive whole number`);
    const max = test.maxLength;
    checks.push((value) => typeof value === 'string' && value.length <= max);
  }
  if (checks.length === 0) throw new Error(`${label} needs at least one of ${TESTS.join(', ')}`);
  return (value, cwd) => checks.every((check) => check(value, cwd));
}

function parseRate(rate: unknown, label: string): CompiledRule['rate'] {
  const match = typeof rate === 'string' ? /^(\d+)\s*\/\s*(second|minute|hour|day)$/.exec(rate.trim()) : null;
  if (!match || Number(match[1]) < 1) throw new Error(`${label}: "rate" must look like "10/minute" (per second, minute, hour or day)`);
  return { limit: Number(match[1]), periodMs: PERIODS[match[2]!]!, label: `${match[1]} per ${match[2]}` };
}

/**
 * Applies a policy file to one server's traffic. The file is reloaded when it
 * changes; a broken edit keeps the previous rules in force (and warns), so
 * editing never opens a gap.
 */
export class PolicyEngine {
  private policy: CompiledPolicy;
  private mtime = 0;
  /** When each rate-limited rule last let calls through, within its period. */
  private readonly calls = new Map<CompiledRule, number[]>();
  private missing = false;

  constructor(
    private readonly path: string | null,
    private readonly serverName: string | null,
    /** The server's working directory, which relative paths in arguments are resolved against. */
    private readonly cwd: string,
    private readonly warn: (message: string) => void = () => {},
    initial?: CompiledPolicy,
    private readonly now: () => number = Date.now,
  ) {
    if (initial) this.policy = initial;
    else this.policy = this.read();
  }

  /** Whether the agent may send this request. */
  check(method: string, params: unknown): Verdict {
    this.reload();
    const call = isObject(params) ? params : {};
    const tool = method === 'tools/call' && typeof call.name === 'string' ? call.name : null;
    if (method === 'tools/call' && tool === null) return { allow: false, rule: 'policy', reason: 'a tool call needs a tool name' };
    const subject = method === 'tools/call' ? (isObject(call.arguments) ? call.arguments : {}) : call;
    // The first argument that kept an allow rule from matching, to tell the agent what to change.
    let blocked: string | null = null;

    for (const rule of this.policy.rules) {
      if (!this.applies(rule, method, tool)) continue;
      const failed = rule.where.find(([path, test]) => !test(lookup(subject, path), this.cwd));
      if (failed) {
        if (rule.deny === null && rule.ask === null) blocked ??= failed[0].join('.');
        continue;
      }
      if (rule.deny !== null) return { allow: false, rule: rule.name, reason: rule.deny };
      if (rule.ask !== null) return { allow: false, rule: rule.name, reason: `needs approval (${rule.ask})`, ask: rule.ask };
      if (rule.rate && !this.withinRate(rule)) return { allow: false, rule: rule.name, reason: `rate limit of ${rule.rate.label} reached` };
      return { allow: true, rule: rule.name };
    }
    if (method !== 'tools/call' || this.policy.defaultAllow) return { allow: true, rule: null };
    return { allow: false, rule: 'default deny', reason: blocked !== null ? `"${blocked}" is not allowed for ${tool}` : `no rule allows ${tool}` };
  }

  /**
   * Removes tools no call could be allowed to use from a tools/list result,
   * so the agent doesn't plan around them. Tools some arguments could unlock
   * stay listed.
   */
  filterToolList(result: unknown): { result: unknown; hidden: string[] } {
    this.reload();
    if (!isObject(result) || !Array.isArray(result.tools)) return { result, hidden: [] };
    const hidden: string[] = [];
    const tools = result.tools.filter((tool: unknown) => {
      const name = isObject(tool) && typeof tool.name === 'string' ? tool.name : null;
      if (name !== null && this.mayAllow(name)) return true;
      hidden.push(name ?? '(unnamed)');
      return false;
    });
    return hidden.length === 0 ? { result, hidden } : { result: { ...result, tools }, hidden };
  }

  /** A tool result as the agent may receive it, and what was changed, if anything. */
  limitResult(result: unknown): { result: unknown; change: string | null } {
    this.reload();
    const { maxBytes, redact } = this.policy;
    let changed = false;
    let limited = result;
    if (redact.length > 0) {
      limited = this.redacted(result);
      changed = JSON.stringify(limited) !== JSON.stringify(result);
    }
    if (maxBytes !== null) {
      const size = Buffer.byteLength(JSON.stringify(limited));
      if (size > maxBytes) {
        const text = `Blocked by mcpspy policy: the result was ${size} bytes, over the limit of ${maxBytes}.`;
        return { result: { content: [{ type: 'text', text }], isError: true }, change: 'result too large' };
      }
    }
    return { result: limited, change: changed ? 'result redacted' : null };
  }

  /**
   * Applies `redact` to any other message from the server: results of other
   * methods (resources/read, prompts/get, …), its requests (sampling text goes
   * straight to a model) and notifications (log data). Only result, params and
   * error are touched, never the envelope, so a broad pattern can't break the
   * protocol. Null when nothing matched.
   */
  redactMessage(message: Record<string, unknown>): Record<string, unknown> | null {
    this.reload();
    if (this.policy.redact.length === 0) return null;
    let changed = false;
    const out = { ...message };
    for (const key of ['result', 'params', 'error']) {
      if (!(key in message)) continue;
      const mapped = this.redacted(message[key]);
      if (JSON.stringify(mapped) === JSON.stringify(message[key])) continue;
      out[key] = mapped;
      changed = true;
    }
    return changed ? out : null;
  }

  private redacted(value: unknown): unknown {
    return mapStrings(value, (text) => this.policy.redact.reduce((out, pattern) => out.replace(pattern, '[redacted by policy]'), text));
  }

  private mayAllow(tool: string): boolean {
    for (const rule of this.policy.rules) {
      if (!this.applies(rule, 'tools/call', tool)) continue;
      // Allowed outright, or perhaps once asked.
      if (rule.deny === null) return true;
      if (rule.where.length === 0) return false;
    }
    return this.policy.defaultAllow;
  }

  private applies(rule: CompiledRule, method: string, tool: string | null): boolean {
    if (rule.method !== method) return false;
    if (rule.server && !(this.serverName !== null && rule.server.test(this.serverName))) return false;
    return !rule.tool || (tool !== null && rule.tool.test(tool));
  }

  private withinRate(rule: CompiledRule): boolean {
    const { limit, periodMs } = rule.rate!;
    const now = this.now();
    const recent = (this.calls.get(rule) ?? []).filter((at) => at > now - periodMs);
    this.calls.set(rule, recent);
    if (recent.length >= limit) return false;
    recent.push(now);
    return true;
  }

  private read(): CompiledPolicy {
    const path = this.path!;
    try {
      this.mtime = statSync(path).mtimeMs;
      return parsePolicy(readFileSync(path, 'utf8'), dirname(path));
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`);
    }
  }

  private reload(): void {
    if (this.path === null) return;
    let mtime: number;
    try {
      mtime = statSync(this.path).mtimeMs;
      this.missing = false;
    } catch (error) {
      if (!this.missing) this.warn(`kept previous policy; ${this.path}: ${(error as Error).message}`);
      this.missing = true;
      return;
    }
    if (mtime === this.mtime) return;
    try {
      this.policy = this.read();
      this.calls.clear();
      this.warn(`reloaded policy from ${this.path}`);
    } catch (error) {
      this.mtime = mtime;
      this.warn(`kept previous policy; ${(error as Error).message}`);
    }
  }
}

/**
 * Whether `value`, a path or file: URI, is inside one of `roots` once
 * symlinks are followed, so a link inside an allowed directory can't reach
 * out of it. Relative paths are resolved against the server's directory.
 */
export function isUnder(value: string, roots: string[], cwd: string): boolean {
  let path: string;
  try {
    path = value.startsWith('file:') ? fileURLToPath(value) : resolve(cwd, value);
  } catch {
    return false;
  }
  const real = realish(path);
  return roots.some((root) => {
    const inside = relative(root, real);
    return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
  });
}

/** The real path of `path`, following symlinks as far as the path exists. */
function realish(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  // The root always exists, so this ends there at the latest.
  return join(realish(parent), basename(path));
}

function lookup(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    // Own keys only: "__proto__" or "constructor" must not reach into prototypes.
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
  return value;
}

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

function regex(pattern: unknown, label: string, flags = ''): RegExp {
  if (typeof pattern !== 'string') throw new Error(`${label} must be a regular expression string`);
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
}

function unknownKeys(object: object, known: string[], label: string): void {
  const unknown = Object.keys(object).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map((key) => `"${key}"`).join(', ')}`);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
