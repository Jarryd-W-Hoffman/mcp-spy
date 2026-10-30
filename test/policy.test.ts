import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isUnder, parsePolicy, PolicyEngine, type PolicyFile } from '../src/policy.js';

const engine = (file: PolicyFile, options: { server?: string | null; cwd?: string; base?: string; now?: () => number } = {}) =>
  new PolicyEngine(null, options.server ?? null, options.cwd ?? '/', () => {}, parsePolicy(JSON.stringify(file), options.base ?? '/'), options.now);
const call = (name: string, args?: unknown) => ({ name, ...(args === undefined ? {} : { arguments: args }) });

describe('parsePolicy', () => {
  it.each([
    ['{', /^not valid JSON: /],
    ['[]', 'policy must be a JSON object'],
    ['{"rule": []}', 'policy has unknown key "rule"'],
    ['{"a": 1, "b": 2}', 'policy has unknown keys "a", "b"'],
    ['{"default": "maybe"}', '"default" must be "allow" or "deny"'],
    ['{"rules": {}}', '"rules" must be an array'],
    ['{"rules": [1]}', 'rules[0] must be an object'],
    ['{"rules": [{"allow": true, "tools": "x"}]}', 'rules[0] has unknown key "tools"'],
    ['{"rules": [{"name": 5, "allow": true}]}', 'rules[0]: "name" must be a string'],
    ['{"rules": [{"name": "r", "tool": 5, "allow": true}]}', 'rule "r": "tool" must be a string'],
    ['{"rules": [{"tool": "x", "method": "resources/read", "allow": true}]}', 'rules[0]: "tool" only applies to tools/call'],
    ['{"rules": [{"allow": false}]}', 'rules[0]: "allow" must be true'],
    ['{"rules": [{"deny": ""}]}', 'rules[0]: "deny" must be a reason'],
    ['{"rules": [{"deny": 5}]}', 'rules[0]: "deny" must be a reason'],
    ['{"rules": [{}]}', 'rules[0] needs exactly one of "allow": true, "deny": "<reason>" or "ask": "<prompt>"'],
    ['{"rules": [{"allow": true, "deny": "no"}]}', 'rules[0] needs exactly one of "allow": true, "deny": "<reason>" or "ask": "<prompt>"'],
    ['{"rules": [{"deny": "no", "rate": "1/day"}]}', 'rules[0]: "rate" only applies to allow rules'],
    ['{"rules": [{"ask": "ok?", "rate": "1/day"}]}', 'rules[0]: "rate" only applies to allow rules'],
    ['{"rules": [{"ask": ""}]}', 'rules[0]: "ask" must be a prompt'],
    ['{"rules": [{"ask": 1}]}', 'rules[0]: "ask" must be a prompt'],
    ['{"rules": [{"ask": "ok?", "deny": "no"}]}', 'rules[0] needs exactly one of'],
    ['{"rules": [{"allow": true, "rate": "often"}]}', 'rules[0]: "rate" must look like "10/minute" (per second, minute, hour or day)'],
    ['{"rules": [{"allow": true, "rate": "0/minute"}]}', 'rules[0]: "rate" must look like'],
    ['{"rules": [{"allow": true, "rate": 5}]}', 'rules[0]: "rate" must look like'],
    ['{"rules": [{"allow": true, "where": []}]}', 'rules[0]: "where" must be an object'],
    ['{"rules": [{"allow": true, "where": {"p": 1}}]}', 'rules[0]: where "p" must be an object of tests'],
    ['{"rules": [{"allow": true, "where": {"p": {}}}]}', 'rules[0]: where "p" needs at least one of under, in, match, notMatch, max, maxLength'],
    ['{"rules": [{"allow": true, "where": {"p": {"inside": "."}}}]}', 'rules[0]: where "p" has unknown key "inside"'],
    ['{"rules": [{"allow": true, "where": {"p": {"under": [1]}}}]}', 'rules[0]: where "p": "under" must be a path or a list of paths'],
    ['{"rules": [{"allow": true, "where": {"p": {"in": "a"}}}]}', 'rules[0]: where "p": "in" must be a list of values'],
    ['{"rules": [{"allow": true, "where": {"p": {"match": "("}}}]}', /^rules\[0\]: where "p": "match": Invalid regular expression/],
    ['{"rules": [{"allow": true, "where": {"p": {"notMatch": 1}}}]}', 'rules[0]: where "p": "notMatch" must be a regular expression string'],
    ['{"rules": [{"allow": true, "where": {"p": {"max": "9"}}}]}', 'rules[0]: where "p": "max" must be a number'],
    ['{"rules": [{"allow": true, "where": {"p": {"maxLength": 1.5}}}]}', 'rules[0]: where "p": "maxLength" must be a positive whole number'],
    ['{"results": []}', '"results" must be an object'],
    ['{"results": {"max": 1}}', '"results" has unknown key "max"'],
    ['{"results": {"maxBytes": 0}}', '"results.maxBytes" must be a positive whole number'],
    ['{"results": {"redact": "x"}}', '"results.redact" must be an array of regular expressions'],
    ['{"results": {"redact": ["["]}}', /^results\.redact\[0\]: Invalid regular expression/],
  ])('rejects %s', (text, message) => {
    expect(() => parsePolicy(text, '/')).toThrow(message);
  });

  it('defaults to deny, with no rules or result limits', () => {
    expect(parsePolicy('{}', '/')).toEqual({ defaultAllow: false, rules: [], maxBytes: null, redact: [] });
  });
});

describe('PolicyEngine.check', () => {
  it('lets the first matching rule decide, falling back to the default for tool calls only', () => {
    const policy = engine({
      rules: [
        { name: 'no writes', tool: 'write_*', deny: 'writes need review' },
        { tool: '*_file', allow: true },
      ],
    });
    expect(policy.check('tools/call', call('write_file'))).toEqual({ allow: false, rule: 'no writes', reason: 'writes need review' });
    expect(policy.check('tools/call', call('read_file'))).toEqual({ allow: true, rule: 'rules[1]' });
    expect(policy.check('tools/call', call('search'))).toEqual({ allow: false, rule: 'default deny', reason: 'no rule allows search' });
    expect(policy.check('tools/list', {})).toEqual({ allow: true, rule: null });
    expect(policy.check('tools/call', {})).toEqual({ allow: false, rule: 'policy', reason: 'a tool call needs a tool name' });
    expect(policy.check('tools/call', null)).toMatchObject({ allow: false, rule: 'policy' });
    expect(engine({ default: 'allow' }).check('tools/call', call('anything'))).toEqual({ allow: true, rule: null });
  });

  it('applies rules to other methods by name, testing their params', () => {
    const policy = engine({ rules: [{ method: 'resources/read', where: { uri: { match: '^secret:' } }, deny: 'secret resource' }] });
    expect(policy.check('resources/read', { uri: 'secret://keys' })).toMatchObject({ allow: false, reason: 'secret resource' });
    expect(policy.check('resources/read', { uri: 'file:///a' })).toEqual({ allow: true, rule: null });
    expect(policy.check('resources/read', undefined)).toEqual({ allow: true, rule: null });
  });

  it('matches servers by name', () => {
    const file: PolicyFile = { rules: [{ server: 'git*', tool: '*', allow: true }] };
    expect(engine(file, { server: 'github' }).check('tools/call', call('x')).allow).toBe(true);
    expect(engine(file, { server: 'slack' }).check('tools/call', call('x')).allow).toBe(false);
    expect(engine(file).check('tools/call', call('x')).allow).toBe(false);
  });

  it('tests argument values: in, match, notMatch, max and maxLength, all needing to pass', () => {
    const policy = engine({
      rules: [
        {
          tool: 'query',
          where: {
            'options.mode': { in: ['read', 1] },
            sql: { match: '^select ', notMatch: ';', maxLength: 30 },
            limit: { max: 100 },
          },
          allow: true,
        },
      ],
    });
    const ok = { options: { mode: 'read' }, sql: 'select * from t', limit: 10 };
    expect(policy.check('tools/call', call('query', ok)).allow).toBe(true);
    expect(policy.check('tools/call', call('query', { ...ok, options: { mode: 1 } })).allow).toBe(true);
    for (const bad of [
      { ...ok, options: { mode: 'write' } },
      { ...ok, options: 'read' },
      { ...ok, sql: 'delete from t' },
      { ...ok, sql: 'select 1; drop table t' },
      { ...ok, sql: `select ${'x'.repeat(30)}` },
      { ...ok, sql: 5 },
      { ...ok, limit: 101 },
      { ...ok, limit: '5' },
      { sql: ok.sql, limit: 1 },
    ]) {
      expect(policy.check('tools/call', call('query', bad)).allow).toBe(false);
    }
    expect(policy.check('tools/call', call('query')).allow).toBe(false);
    expect(engine({ rules: [{ tool: 'q', where: { s: { notMatch: 'x' } }, allow: true }] }).check('tools/call', call('q', { s: 1 })).allow).toBe(false);
    expect(engine({ rules: [{ tool: 'q', where: { s: { maxLength: 3 } }, allow: true }] }).check('tools/call', call('q', { s: 1 })).allow).toBe(false);
  });

  it('names the first argument that kept an allow rule from matching', () => {
    const policy = engine({
      rules: [
        { tool: 'read', where: { 'opts.mode': { in: ['r'] } }, deny: 'not this one' },
        { tool: 'read', where: { path: { match: '^/srv/' } }, allow: true },
        { tool: 'read', where: { other: { in: [1] } }, allow: true },
      ],
    });
    expect(policy.check('tools/call', call('read', { path: '/etc/passwd', opts: { mode: 'w' } }))).toEqual({
      allow: false,
      rule: 'default deny',
      reason: '"path" is not allowed for read',
    });
    expect(policy.check('tools/call', call('read', { path: '/srv/a', opts: { mode: 'r' } })).allow).toBe(false);
  });

  it('turns ask rules into refusals that carry the prompt, keeping those tools listed', () => {
    const policy = engine({
      rules: [
        { tool: 'deploy', where: { env: { in: ['staging'] } }, allow: true },
        { name: 'prod deploys', tool: 'deploy', ask: 'Deploy to production?' },
        { tool: 'push', where: { force: { in: [true] } }, ask: 'Force-push?' },
      ],
    });
    expect(policy.check('tools/call', { name: 'deploy', arguments: { env: 'staging' } }).allow).toBe(true);
    expect(policy.check('tools/call', { name: 'deploy', arguments: { env: 'prod' } })).toEqual({
      allow: false,
      rule: 'prod deploys',
      reason: 'needs approval (Deploy to production?)',
      ask: 'Deploy to production?',
    });
    // A failed test on an ask rule isn't what blocked the call, so it isn't named.
    expect(policy.check('tools/call', { name: 'push', arguments: { force: false } })).toMatchObject({ reason: 'no rule allows push' });
    expect(policy.filterToolList({ tools: [{ name: 'deploy' }, { name: 'push' }, { name: 'other' }] }).hidden).toEqual(['other']);
  });

  it('reads only own properties, so prototypes are out of reach', () => {
    const policy = engine({ rules: [{ tool: 'x', where: { '__proto__.polluted': { in: [undefined] } }, deny: 'probe' }], default: 'allow' });
    expect(policy.check('tools/call', JSON.parse('{"name":"x","arguments":{"__proto__":{"polluted":1}}}')).allow).toBe(true);
    const lists = engine({ rules: [{ tool: 'x', where: { 'items.0': { in: ['a'] }, 'items.length': { max: 0 } }, allow: true }] });
    expect(lists.check('tools/call', call('x', { items: ['a'] })).allow).toBe(false);
    expect(engine({ rules: [{ tool: 'x', where: { 'items.0': { in: ['a'] } }, allow: true }] }).check('tools/call', call('x', { items: ['a'] })).allow).toBe(true);
  });

  it('limits rates per rule, in a sliding window', () => {
    let now = 0;
    const policy = engine(
      {
        rules: [
          { tool: 'search', rate: '2/minute', allow: true },
          { tool: 'fetch', rate: '1/second', allow: true },
        ],
      },
      { now: () => now },
    );
    const search = () => policy.check('tools/call', call('search'));
    expect([search().allow, search().allow]).toEqual([true, true]);
    expect(search()).toEqual({ allow: false, rule: 'rules[0]', reason: 'rate limit of 2 per minute reached' });
    expect(policy.check('tools/call', call('fetch')).allow).toBe(true);
    now = 30_000;
    expect(search().allow).toBe(false);
    now = 60_001;
    expect([search().allow, search().allow, search().allow]).toEqual([true, true, false]);
    expect(policy.check('tools/call', call('fetch')).allow).toBe(true);
    for (const rate of ['3/hour', '1 / day']) expect(engine({ rules: [{ tool: 'x', rate, allow: true }] }).check('tools/call', call('x')).allow).toBe(true);
  });
});

describe('paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcpspy-policy-'));
  mkdirSync(join(root, 'project', 'src'), { recursive: true });
  mkdirSync(join(root, 'secrets'));
  symlinkSync(join(root, 'secrets'), join(root, 'project', 'src', 'escape'));
  symlinkSync(join(root, 'project', 'src'), join(root, 'alias'));

  it('keeps paths under the allowed directories, following symlinks and resolving relative paths', () => {
    const policy = engine({ rules: [{ tool: 'read', where: { path: { under: ['project/src', 'missing/dir'] } }, allow: true }] }, { base: root, cwd: join(root, 'project') });
    const allowed = (path: unknown) => policy.check('tools/call', call('read', { path })).allow;
    expect(allowed(join(root, 'project', 'src', 'a.ts'))).toBe(true);
    expect(allowed('src/new/file.ts')).toBe(true);
    expect(allowed(join(root, 'project', 'src'))).toBe(true);
    expect(allowed(join(root, 'alias', 'a.ts'))).toBe(true);
    expect(allowed(pathToFileURL(join(root, 'project', 'src', 'a.ts')).href)).toBe(true);
    expect(allowed(join(root, 'missing', 'dir', 'x'))).toBe(true);
    expect(allowed('src/../../secrets/key')).toBe(false);
    expect(allowed(join(root, 'project', 'src', 'escape', 'key'))).toBe(false);
    expect(allowed(join(root, 'project', 'srcfoo'))).toBe(false);
    expect(allowed('file://elsewhere/etc/passwd')).toBe(false);
    expect(allowed(5)).toBe(false);
  });

  it('reads a leading ~ as the home directory, as servers do, and refuses ~user', () => {
    // A server that expands ~ would read the home directory, not a "~" folder inside the root.
    expect(isUnder('~/.ssh/id_rsa', ['/work'], '/work')).toBe(false);
    expect(isUnder('~', ['/work'], '/work')).toBe(false);
    expect(isUnder('~/notes.md', [homedir()], '/work')).toBe(true);
    expect(isUnder('~', [homedir()], '/work')).toBe(true);
    expect(isUnder('~root/x', ['/'], '/')).toBe(false);
    expect(isUnder('./~/x', ['/work'], '/work')).toBe(true);
  });

  it('accepts a single directory', () => {
    expect(isUnder('/a/b', ['/a'], '/')).toBe(true);
    expect(engine({ rules: [{ tool: 'r', where: { p: { under: '.' } }, allow: true }] }, { base: root }).check('tools/call', call('r', { p: join(root, 'x') })).allow).toBe(true);
  });

  it('cleans up', () => rmSync(root, { recursive: true, force: true }));
});

describe('tool lists and results', () => {
  it('hides tools no call could be allowed to use', () => {
    const policy = engine({
      rules: [
        { tool: 'admin_*', deny: 'admin' },
        { tool: 'read', where: { path: { under: '/srv' } }, allow: true },
        { tool: 'maybe', where: { x: { in: [1] } }, deny: 'sometimes' },
        { method: 'resources/read', deny: 'no resources' },
        { tool: 'listed', allow: true },
      ],
    });
    const result = { tools: [{ name: 'admin_reset' }, { name: 'read' }, { name: 'maybe' }, { name: 'listed' }, { name: 'other' }, { description: 'nameless' }], nextCursor: 'c' };
    expect(policy.filterToolList(result)).toEqual({ result: { tools: [{ name: 'read' }, { name: 'listed' }], nextCursor: 'c' }, hidden: ['admin_reset', 'maybe', 'other', '(unnamed)'] });
    const open = engine({ default: 'allow' });
    const tools = { tools: [{ name: 'a' }] };
    expect(open.filterToolList(tools)).toEqual({ result: tools, hidden: [] });
    expect(open.filterToolList(tools).result).toBe(tools);
    expect(open.filterToolList(null)).toEqual({ result: null, hidden: [] });
    expect(open.filterToolList({ tools: 'x' })).toEqual({ result: { tools: 'x' }, hidden: [] });
  });

  it('redacts results and replaces ones over the size limit', () => {
    const redacting = engine({ results: { redact: ['ghp_\\w+', 'secret'] } });
    const result = { content: [{ type: 'text', text: 'token ghp_abc and ghp_def, secret' }], n: 1 };
    expect(redacting.limitResult(result)).toEqual({
      result: { content: [{ type: 'text', text: 'token [redacted by policy] and [redacted by policy], [redacted by policy]' }], n: 1 },
      change: 'result redacted',
    });
    expect(redacting.limitResult({ content: [] })).toEqual({ result: { content: [] }, change: null });
    const capped = engine({ results: { maxBytes: 20 } });
    expect(capped.limitResult({ content: 'x'.repeat(30) })).toEqual({
      result: { content: [{ type: 'text', text: 'Blocked by mcpspy policy: the result was 44 bytes, over the limit of 20.' }], isError: true },
      change: 'result too large',
    });
    expect(capped.limitResult({ a: 1 })).toEqual({ result: { a: 1 }, change: null });
    expect(engine({}).limitResult('x')).toEqual({ result: 'x', change: null });
  });
});

describe('policy files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpspy-policy-file-'));
  const path = join(dir, 'policy.json');
  const write = (file: unknown, mtime: number) => {
    writeFileSync(path, typeof file === 'string' ? file : JSON.stringify(file));
    utimesSync(path, mtime, mtime);
  };

  it('refuses to load a broken policy, naming the file', () => {
    write('{"default": "sometimes"}', 1000);
    expect(() => new PolicyEngine(path, null, dir)).toThrow(`${path}: "default" must be "allow" or "deny"`);
    expect(() => new PolicyEngine(join(dir, 'none.json'), null, dir)).toThrow(/none\.json: ENOENT/);
  });

  it('reloads on change, keeping the previous rules when an edit is broken or the file goes', () => {
    write({ rules: [{ tool: 'a', allow: true }] }, 1000);
    const warnings: string[] = [];
    const policy = new PolicyEngine(path, null, dir, (message) => warnings.push(message));
    expect(policy.check('tools/call', call('a')).allow).toBe(true);
    write({ rules: [{ tool: 'b', allow: true }] }, 2000);
    expect(policy.check('tools/call', call('a')).allow).toBe(false);
    expect(policy.filterToolList({ tools: [{ name: 'b' }] }).hidden).toEqual([]);
    write('{"rules": [{"tool": "c"}]}', 3000);
    expect(policy.check('tools/call', call('b')).allow).toBe(true);
    expect(policy.limitResult(1).change).toBeNull();
    rmSync(path);
    expect(policy.check('tools/call', call('b')).allow).toBe(true);
    expect(policy.check('tools/call', call('b')).allow).toBe(true);
    write({ default: 'allow' }, 4000);
    expect(policy.check('tools/call', call('z')).allow).toBe(true);
    expect(warnings).toEqual([
      `reloaded policy from ${path}`,
      `kept previous policy; ${path}: rules[0] needs exactly one of "allow": true, "deny": "<reason>" or "ask": "<prompt>"`,
      expect.stringMatching(/^kept previous policy; .*ENOENT/),
      `reloaded policy from ${path}`,
    ]);
    // Without a warn callback, reloads are silent.
    const quiet = new PolicyEngine(path, null, dir);
    write({}, 5000);
    expect(quiet.check('tools/call', call('z')).allow).toBe(false);
  });

  it('cleans up', () => rmSync(dir, { recursive: true, force: true }));
});
