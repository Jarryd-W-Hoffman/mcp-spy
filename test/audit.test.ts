import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditTrail, chainHash, checkMessages, currentActor, GENESIS, parseAnchor, parseExport, sha256, verifyChain, type AuditEvent } from '../src/audit.js';
import { PolicyEngine } from '../src/policy.js';
import { startHttpProxy } from '../src/proxy/http.js';
import { runStdioProxy } from '../src/proxy/stdio.js';
import { planPrune, applyPrune } from '../src/prune.js';
import { Store } from '../src/store.js';
import { wrapConfig } from '../src/wrap.js';
import { cli } from './cli-harness.js';
import { echoServer } from './helpers.js';

const data = (event: AuditEvent) => JSON.parse(event.data) as Record<string, unknown>;
const call = (id: number, name: string) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { text: 'hi' } } });

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpspy-audit-'));
  db = join(dir, 'log.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Writes through a raw connection with the append-only triggers gone, as an attacker with the file could. */
function tamper(sql: string): void {
  const raw = new DatabaseSync(db);
  raw.exec(`DROP TRIGGER IF EXISTS audit_events_no_update; DROP TRIGGER IF EXISTS audit_events_no_delete; ${sql}`);
  raw.close();
}

function chain(count: number): Store {
  const store = new Store(db);
  for (let i = 0; i < count; i++) store.appendAudit({ ts: i, session_id: 1, type: 'call', data: JSON.stringify({ subject: `tool${i}` }) });
  return store;
}

describe('the chain', () => {
  it('links each event to the one before it', () => {
    const store = chain(3);
    const events = [...store.auditEvents()];
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events[0]!.prev_hash).toBe(GENESIS);
    expect(events[1]!.prev_hash).toBe(events[0]!.hash);
    expect(chainHash(events[2]!)).toBe(events[2]!.hash);
    expect(verifyChain(events)).toEqual({ count: 3, head: { seq: 3, hash: events[2]!.hash }, problems: [] });
    store.close();
  });

  it('pages through long chains, including one that fills its last page', () => {
    const store = chain(4);
    expect([...store.auditEvents(2)].map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect([...store.auditEvents(3)].map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    store.close();
  });

  it('refuses updates and deletes through SQL', () => {
    const store = chain(1);
    store.close();
    const raw = new DatabaseSync(db);
    expect(() => raw.exec('DELETE FROM audit_events')).toThrow(/append-only/);
    expect(() => raw.exec("UPDATE audit_events SET data = '{}'")).toThrow(/append-only/);
    raw.close();
  });

  it('rolls an append back when it fails', () => {
    const store = chain(1);
    expect(() => store.appendAudit({ ts: 1, session_id: 1, type: 'call', data: null as unknown as string })).toThrow();
    expect(store.appendAudit({ ts: 2, session_id: 1, type: 'call', data: '{}' }).seq).toBe(2);
    expect(verifyChain(store.auditEvents()).problems).toEqual([]);
    store.close();
  });

  it('survives writers in turn on the same file', () => {
    const [a, b] = [new Store(db), new Store(db)];
    for (let i = 0; i < 6; i++) (i % 2 ? a : b).appendAudit({ ts: i, session_id: i, type: 'call', data: '{}' });
    expect(verifyChain(a.auditEvents())).toMatchObject({ count: 6, problems: [] });
    a.close();
    b.close();
  });

  it.each([
    ['a changed event', (e: AuditEvent[]) => e.map((x) => (x.seq === 2 ? { ...x, data: '{"subject":"other"}' } : x)), 'event 2 was changed'],
    ['a removed event', (e: AuditEvent[]) => e.filter((x) => x.seq !== 2), 'event 2 is missing'],
    ['a removed start', (e: AuditEvent[]) => e.filter((x) => x.seq !== 1), 'event 1 is missing'],
    ['a recomputed event', (e: AuditEvent[]) => e.map((x) => (x.seq === 2 ? { ...x, data: '{}', hash: chainHash({ ...x, data: '{}' }) } : x)), "event 3 doesn't follow event 2"],
  ])('finds %s', (_name, change, problem) => {
    const store = chain(3);
    expect(verifyChain(change([...store.auditEvents()])).problems[0]).toContain(problem);
    store.close();
  });

  it('needs an anchor to find a rewrite or a removed end', () => {
    const store = chain(3);
    const events = [...store.auditEvents()];
    store.close();
    expect(verifyChain(events, { seq: 2, hash: events[1]!.hash }).problems).toEqual([]);
    expect(verifyChain(events, { seq: 2, hash: 'f'.repeat(64) }).problems[0]).toContain('rewritten');
    expect(verifyChain(events.slice(0, 1), { seq: 2, hash: events[1]!.hash }).problems[0]).toContain('its end was removed');
    expect(verifyChain([]).head).toBeNull();
  });

  it('parses anchors and exports strictly', () => {
    expect(parseAnchor(` 4:${'a'.repeat(64)} `)).toEqual({ seq: 4, hash: 'a'.repeat(64) });
    expect(() => parseAnchor('4:abc')).toThrow(/not an anchor/);
    expect(() => parseExport('')).toThrow(/not an mcpspy audit export/);
    expect(() => parseExport('{bad')).toThrow(/not an mcpspy audit export/);
    expect(() => parseExport('{"format":"other","version":1}')).toThrow(/not an mcpspy audit export/);
    expect(() => parseExport('{"format":"mcpspy-audit","version":2}')).toThrow(/not an mcpspy audit export/);
    expect(() => parseExport('{"format":"mcpspy-audit","version":1}\nnull')).toThrow(/line 2/);
    expect(() => parseExport('{"format":"mcpspy-audit","version":1}\n{bad')).toThrow(/line 2/);
  });

  it('compares messages with the hashes in the chain', () => {
    const event = (type: AuditEvent['type'], id: number): AuditEvent => ({
      seq: id, ts: 0, session_id: 1, type, prev_hash: '', hash: '',
      data: JSON.stringify({ message_id: id, message_ts: 5, payload_sha256: sha256('same') }),
    });
    const rows: Record<number, { ts: number; payload: string }> = { 1: { ts: 5, payload: 'same' }, 2: { ts: 5, payload: 'edited' }, 3: { ts: 6, payload: 'reused id' } };
    const events = [event('call', 1), event('outcome', 2), event('call', 3), event('call', 4), event('verdict', 1)];
    expect(checkMessages(events, (id) => rows[id])).toEqual({ matched: 1, gone: 2, changed: [2] });
    // A forged event may not refer to anything, or hold JSON at all.
    expect(checkMessages([{ ...event('call', 1), data: 'x' }, { ...event('call', 1), data: '{}' }], (id) => rows[id])).toEqual({ matched: 0, gone: 2, changed: [] });
  });

  it('reports the user even without a passwd entry', () => {
    expect(currentActor(() => ({ username: 'ada' })).user).toBe('ada');
    expect(currentActor(() => { throw new Error('no entry'); }).user).toBe('unknown');
    expect(currentActor().host).not.toBe('');
  });
});

describe('what a session writes', () => {
  const trail = () => {
    const store = chain(0);
    return { store, audit: new AuditTrail(store, 7, 'files', () => 1000, { user: 'ada', host: 'box' }) };
  };
  const message = (fields: Partial<Parameters<AuditTrail['message']>[0]>) => ({
    id: 1, ts: 2, direction: 'client' as const, kind: 'request' as const, method: null, rpcId: '1', payload: '{}', latencyMs: null, rule: null, ...fields,
  });

  it('names the agent as it reports itself', () => {
    const { store, audit } = trail();
    const init = (clientInfo: unknown, params = true) => audit.message(message({ method: 'initialize', payload: JSON.stringify(params ? { params: { clientInfo } } : {}) }));
    const seen = () => {
      audit.message(message({ method: 'tools/call', payload: '{"params":{"name":"t"}}' }));
      return data([...store.auditEvents()].at(-1)!).agent;
    };
    init({ name: 'claude', version: '2' });
    expect(seen()).toBe('claude 2');
    init({ name: 'cursor' });
    expect(seen()).toBe('cursor');
    init({ version: '1' });
    expect(seen()).toBeNull();
    init(null, false);
    expect(seen()).toBeNull();
    store.close();
  });

  it('records audited requests with a hash in place of the arguments', () => {
    const { store, audit } = trail();
    const payload = '{"params":{"uri":"file:///a","secretish":"value"}}';
    audit.message(message({ method: 'resources/read', payload, id: 4 }));
    audit.message(message({ method: 'prompts/get', payload: '{"params":{"name":"p"}}', rpcId: '2' }));
    audit.message(message({ method: 'tools/call', payload: '{"params":{"name":3}}', rpcId: '3' }));
    audit.message(message({ method: 'tools/list', rpcId: '4' }));
    audit.message(message({ kind: 'notification', method: 'notifications/initialized', rpcId: null }));
    audit.message(message({ method: 'sampling/createMessage', direction: 'server', payload: '{}', rpcId: '5' }));
    const events = [...store.auditEvents()];
    expect(events.map((event) => data(event).subject)).toEqual(['file:///a', 'p', null, null]);
    expect(events[0]!.session_id).toBe(7);
    expect(data(events[0]!)).toMatchObject({ server: 'files', message_id: 4, payload_sha256: sha256(payload) });
    expect(events[0]!.data).not.toContain('secretish');
    store.close();
  });

  it('pairs outcomes with their calls, and ignores other replies', () => {
    const { store, audit } = trail();
    const reply = (kind: 'response' | 'error', rpcId: string, payload: string, rule: string | null = null) =>
      audit.message(message({ kind, direction: 'server', method: 'tools/call', rpcId, payload, latencyMs: 3, rule }));
    for (const id of ['1', '2', '3', '4']) audit.message(message({ method: 'tools/call', rpcId: id, payload: '{"params":{"name":"t"}}' }));
    reply('response', '1', '{"result":{}}');
    reply('response', '2', '{"result":{"isError":true}}', 'policy: result too large');
    reply('error', '3', '{"error":{}}');
    reply('response', '4', '{}');
    reply('response', '99', '{"result":{}}');
    audit.message(message({ kind: 'log', direction: 'stderr', rpcId: null }));
    const outcomes = [...store.auditEvents()].filter((event) => event.type === 'outcome').map(data);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'tool_error', 'rpc_error', 'ok']);
    expect(outcomes[1]).toMatchObject({ rule: 'policy: result too large', latency_ms: 3, subject: 't' });
    store.close();
  });

  it('records answers to mcpspy\'s asks, not a server\'s lookalike', () => {
    const { store, audit } = trail();
    const answer = (rpcId: string, payload: string) => audit.message(message({ kind: 'response', method: 'elicitation/create', rpcId, payload }));
    // mcpspy's own ask carries a policy rule, so it isn't a call.
    audit.message(message({ method: 'elicitation/create', direction: 'server', rpcId: '"mcpspy-ask-1"', rule: 'policy: confirm', payload: '{}' }));
    answer('"mcpspy-ask-1"', '{"result":{"action":"accept"}}');
    answer('"mcpspy-ask-2"', '{"error":{}}');
    answer('"other"', '{"result":{"action":"accept"}}');
    audit.message(message({ method: 'elicitation/create', direction: 'server', rpcId: '"mcpspy-ask-3"', payload: '{"params":{}}' }));
    answer('"mcpspy-ask-3"', '{"result":{"action":"accept"}}');
    const events = [...store.auditEvents()];
    expect(events.map((event) => event.type)).toEqual(['approval', 'approval', 'call', 'outcome']);
    expect(events.slice(0, 2).map((event) => data(event).action)).toEqual(['accept', 'none']);
    store.close();
  });

  it('records decisions, leaving out passes no rule named', () => {
    const { store, audit } = trail();
    audit.verdict('tools/list', {}, { allow: true, rule: null }, 'h');
    audit.verdict('tools/call', { name: 't' }, { allow: true, rule: null }, 'h');
    audit.verdict('tools/call', { name: 't' }, { allow: true, rule: 'reads' }, 'h');
    audit.verdict('tools/call', { name: 't' }, { allow: false, rule: 'writes', reason: 'no' }, 'h');
    audit.verdict('tools/call', undefined, { allow: false, rule: 'sure', reason: 'r', ask: 'sure?' }, null);
    const verdicts = [...store.auditEvents()].map(data);
    expect(verdicts.map((verdict) => verdict.decision)).toEqual(['allow', 'allow', 'deny', 'ask']);
    expect(verdicts[2]).toMatchObject({ rule: 'writes', reason: 'no', policy_sha256: 'h', subject: 't' });
    expect(verdicts[3]).toMatchObject({ subject: null, policy_sha256: null });
    store.close();
  });
});

describe('through the proxies', () => {
  const policyFile = (rules: object[]) => {
    const path = join(dir, 'policy.json');
    writeFileSync(path, JSON.stringify({ default: 'deny', rules }));
    return path;
  };
  const stdio = async (store: Store, lines: string[], options: { policy?: PolicyEngine; audit?: boolean }) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runStdioProxy({ command: process.execPath, args: [echoServer], store, name: 'echo', input, output, errorOutput: new PassThrough(), forwardSignals: [], ...options });
    for (const line of lines) input.write(`${line}\n`);
    input.end();
    return running;
  };

  it('stdio: audits nothing unless asked to', async () => {
    const store = new Store(db);
    await stdio(store, [call(1, 'echo')], {});
    expect([...store.auditEvents()]).toEqual([]);
    store.close();
  });

  it('stdio: --audit alone records the session and its calls', async () => {
    const store = new Store(db);
    await stdio(store, [call(1, 'echo')], { audit: true });
    const events = [...store.auditEvents()];
    expect(events[0]!.type).toBe('session_start');
    expect(data(events[0]!)).toMatchObject({ server: 'echo', transport: 'stdio', policy: null });
    expect(events.at(-1)!.type).toBe('session_end');
    expect(events.some((event) => event.type === 'call')).toBe(true);
    store.close();
  });

  it('stdio: a policy implies auditing and records the rule and exact policy behind each decision', async () => {
    const path = policyFile([{ name: 'echoes', tool: 'echo', allow: true }, { name: 'no writes', tool: 'write', deny: 'read only' }]);
    const store = new Store(db);
    const policy = new PolicyEngine(path, 'echo', dir);
    await stdio(store, [call(1, 'echo'), call(2, 'write')], { policy });
    const events = [...store.auditEvents()];
    expect(data(events[0]!).policy).toEqual({ path, sha256: policy.identity().sha256 });
    const verdicts = events.filter((event) => event.type === 'verdict').map(data);
    expect(verdicts.map((verdict) => [verdict.subject, verdict.decision, verdict.rule])).toEqual([['echo', 'allow', 'echoes'], ['write', 'deny', 'no writes']]);
    expect(verdicts[0]!.policy_sha256).toMatch(/^[0-9a-f]{64}$/);
    const denied = events.filter((event) => event.type === 'outcome').map(data).find((outcome) => outcome.subject === 'write');
    expect(denied).toMatchObject({ status: 'tool_error', rule: 'policy: no writes' });
    expect(verifyChain(events).problems).toEqual([]);
    store.close();
  });

  it('http: records sessions, decisions, outcomes and session ends', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const message = JSON.parse(body) as { id: number };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const store = new Store(db);
    const policy = new PolicyEngine(policyFile([{ name: 'reads', tool: 'read', allow: true }, { method: 'sampling/createMessage', deny: 'no sampling' }]), 'remote', null);
    const proxy = await startHttpProxy({ upstream: `http://127.0.0.1:${port}/mcp`, store, name: 'remote', port: 0, policy, warn: () => {} });
    const post = (body: string) => fetch(proxy.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body });
    await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agent', version: '1' } } }));
    await post(call(2, 'read'));
    await post(call(3, 'write'));
    await proxy.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const events = [...store.auditEvents()];
    expect(events[0]!.type).toBe('session_start');
    expect(events.at(-1)!.type).toBe('session_end');
    expect(events.filter((event) => event.type === 'verdict').map(data).map((verdict) => [verdict.subject, verdict.decision])).toEqual([['read', 'allow'], ['write', 'deny']]);
    expect(data(events.find((event) => event.type === 'call')!).agent).toBe('agent 1');
    expect(verifyChain(events).problems).toEqual([]);
    store.close();
  });

  it('http: --audit works without a policy, and sessions stay unaudited by default', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => void res.writeHead(202).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    for (const audit of [false, true]) {
      const path = join(dir, `http-${audit}.db`);
      const store = new Store(path);
      const proxy = await startHttpProxy({ upstream: `http://127.0.0.1:${port}/mcp`, store, port: 0, audit, warn: () => {} });
      await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
      await proxy.close();
      expect([...store.auditEvents()].length > 0).toBe(audit);
      store.close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('keeps the trail when the session is pruned', async () => {
    const store = new Store(db);
    await stdio(store, [call(1, 'echo')], { audit: true });
    const before = [...store.auditEvents()];
    await applyPrune(store, planPrune(store, { keep: 0 }));
    expect(store.listSessions()).toEqual([]);
    expect([...store.auditEvents()]).toEqual(before);
    store.close();
  });

  it('wrap passes --audit on', () => {
    const wrapped = wrapConfig({ mcpServers: { a: { command: 'x' } } }, { audit: true }).config as { mcpServers: { a: { args: string[] } } };
    expect(wrapped.mcpServers.a.args).toEqual(['run', '--name', 'a', '--audit', '--', 'x']);
  });
});

describe('the audit command', () => {
  const seeded = async () => {
    const store = new Store(db);
    const session = store.createSession({ name: 'echo', transport: 'stdio', command: '["x"]', cwd: '/', pid: null, started_at: 1 });
    const audit = new AuditTrail(store, session, 'echo', () => 1_700_000_000_000, { user: 'ada', host: 'box' });
    audit.started({ transport: 'stdio', command: '["x"]', cwd: '/', policy: { path: '/p', sha256: 'h' } });
    const payload = '{"params":{"name":"read"}}';
    const id = store.insertMessage({ session_id: session, ts: 5, direction: 'client', kind: 'request', method: 'tools/call', rpc_id: '1', payload, size: 1, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
    audit.message({ id, ts: 5, direction: 'client', kind: 'request', method: 'tools/call', rpcId: '1', payload, latencyMs: null, rule: null });
    audit.verdict('tools/call', { name: 'read' }, { allow: true, rule: null }, 'h');
    audit.verdict('tools/call', { name: 'evil\n2026 forged' }, { allow: false, rule: 'writes', reason: 'no' }, 'h');
    audit.verdict('tools/call', { name: 'ok' }, { allow: false, rule: 'sure', reason: 'r', ask: 'sure?' }, 'h');
    audit.verdict('tools/call', {}, { allow: true, rule: 'rule' }, 'h');
    audit.message({ id, ts: 5, direction: 'client', kind: 'response', method: 'elicitation/create', rpcId: '"mcpspy-ask-1"', payload: '{"result":{"action":"accept"}}', latencyMs: null, rule: null });
    audit.message({ id: id + 1, ts: 6, direction: 'server', kind: 'response', method: 'tools/call', rpcId: '1', payload: '{"result":{}}', latencyMs: 1, rule: 'policy: redacted' });
    audit.ended({ exit_code: 0, exit_signal: null });
    new AuditTrail(store, session, null, () => 1, { user: 'a', host: 'b' }).ended({ exit_code: null, exit_signal: 'SIGTERM' });
    new AuditTrail(store, session, null, () => 2, { user: 'a', host: 'b' }).ended({ exit_code: null, exit_signal: null });
    new AuditTrail(store, session, null, () => 3, { user: 'a', host: 'b' }).started({ transport: 'http', command: '["u"]', cwd: '/', policy: null });
    new AuditTrail(store, session, null, () => 4, { user: 'a', host: 'b' }).verdict('ping', undefined, { allow: true, rule: 'r' }, null);
    const last = new AuditTrail(store, session, null, () => 4, { user: 'a', host: 'b' });
    last.message({ id: 98, ts: 1, direction: 'client', kind: 'request', method: 'tools/call', rpcId: '3', payload: '{"params":{"name":"plain"}}', latencyMs: null, rule: null });
    last.message({ id: 99, ts: 1, direction: 'server', kind: 'response', method: 'tools/call', rpcId: '3', payload: '{"result":{}}', latencyMs: 1, rule: null });
    last.message({ id: 100, ts: 1, direction: 'client', kind: 'request', method: 'initialize', rpcId: '1', payload: '{"params":{"clientInfo":{"name":"agent"}}}', latencyMs: null, rule: null });
    last.message({ id: 101, ts: 1, direction: 'client', kind: 'request', method: 'tools/call', rpcId: '2', payload: '{"params":{"name":"gone"}}', latencyMs: null, rule: null });
    store.close();
    return session;
  };

  it('lists events, and can filter them', async () => {
    const session = await seeded();
    const all = await cli(['audit', '--db', db]);
    expect(all.code).toBe(0);
    for (const text of ['ada@box', '(with policy)', 'allow read', 'deny evil?2026 forged (writes): no', 'ask ok (sure)', 'user answered: accept', 'read ok (policy: redacted)', 'exit 0', 'signal SIGTERM', 'ended', 'allow ping (r)', 'plain ok', 'gone (agent)']) expect(all.stdout).toContain(text);
    expect(all.stdout.split('\n').filter((line) => line.includes('forged'))).toHaveLength(1);
    expect(all.stdout.split('\n').some((line) => line.startsWith('2026 forged'))).toBe(false);

    const denied = await cli(['audit', '--denied', '--db', db]);
    expect(denied.stdout.trim().split('\n')).toHaveLength(1);
    const json = await cli(['audit', '--json', '-n', '1', '--session', String(session), '--db', db]);
    expect(JSON.parse(json.stdout)).toMatchObject({ type: 'call', data: { subject: 'gone' } });
    expect((await cli(['audit', '--session', '999', '--db', db])).stdout).toContain('No audit events');
    expect((await cli(['audit', '--session', '999', '--json', '--db', db])).stdout).toBe('');
    expect((await cli(['audit', 'nonsense', '--db', db])).stderr).toContain('unknown audit command');
  });

  it('verifies an intact trail, with and without an anchor', async () => {
    await seeded();
    const run = await cli(['audit', 'verify', '--db', db]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Intact: 16 events');
    expect(run.stdout).toContain('Recorded messages matching the chain: 1 (4 more are no longer in the log, usually pruned)');
    const anchor = /Anchor: (\S+)/.exec(run.stdout)![1]!;
    const again = await cli(['audit', 'verify', '--anchor', anchor, '--db', db]);
    expect(again.stdout).toContain('the anchor at event 16 matches');
    expect((await cli(['audit', 'verify', '--anchor', 'nope', '--db', db])).stderr).toContain('not an anchor');
  });

  it('says so when there is nothing to verify', async () => {
    const run = await cli(['audit', 'verify', '--db', db]);
    expect(run.stdout).toContain('No audit events to verify');
    expect(run.code).toBe(0);
  });

  it('leaves out the message line when every message is accounted for elsewhere', async () => {
    const store = new Store(db);
    new AuditTrail(store, 1, 'x', () => 1, { user: 'a', host: 'b' }).ended({ exit_code: 0, exit_signal: null });
    store.close();
    expect((await cli(['audit', 'verify', '--db', db])).stdout).toContain('matching the chain: 0.');
  });

  it.each([
    ['an edited event', "UPDATE audit_events SET data = '{}' WHERE seq = 2", 'event 2 was changed'],
    ['a removed event', 'DELETE FROM audit_events WHERE seq = 2', 'event 2 is missing'],
    ['a removed end', 'DELETE FROM audit_events WHERE seq > 3', 'events after 3 are missing'],
    ['an emptied trail', 'DELETE FROM audit_events', 'events after 0 are missing'],
    ['an edited message', "UPDATE messages SET payload = '{\"params\":{\"name\":\"other\"}}'", "doesn't match the hash"],
  ])('fails on %s', async (_name, sql, problem) => {
    await seeded();
    tamper(sql);
    const run = await cli(['audit', 'verify', '--db', db]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(problem);
    expect(run.stdout).toContain('failed verification');
  });

  it('an anchor catches a chain rebuilt from scratch', async () => {
    await seeded();
    const anchor = /Anchor: (\S+)/.exec((await cli(['audit', 'verify', '--db', db])).stdout)![1]!;
    tamper("DELETE FROM audit_events; DELETE FROM sqlite_sequence WHERE name = 'audit_events';");
    const store = new Store(db);
    store.appendAudit({ ts: 1, session_id: 1, type: 'call', data: '{}' });
    store.close();
    const clean = await cli(['audit', 'verify', '--db', db]);
    expect(clean.code).toBe(0); // the limit an anchor exists for
    const anchored = await cli(['audit', 'verify', '--anchor', anchor, '--db', db]);
    expect(anchored.code).toBe(1);
    expect(anchored.stdout).toContain('its end was removed');
  });

  it('lists a forged event rather than falling over', async () => {
    const store = new Store(db);
    store.appendAudit({ ts: 1, session_id: 1, type: 'call', data: 'not json' });
    store.close();
    expect((await cli(['audit', '--db', db])).code).toBe(0);
    expect(JSON.parse((await cli(['audit', '--json', '--db', db])).stdout).data).toEqual({});
  });

  it('exports a file that verifies on its own, and notices edits to it', async () => {
    await seeded();
    const exported = await cli(['audit', 'export', '--db', db]);
    expect(exported.stderr).toContain('Exported 16 audit events');
    const file = join(dir, 'audit.jsonl');
    writeFileSync(file, exported.stdout);
    const run = await cli(['audit', 'verify', '--file', file]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Intact: 16 events');
    expect(run.stdout).not.toContain('Recorded messages');

    writeFileSync(file, exported.stdout.replace('ada', 'eve'));
    expect((await cli(['audit', 'verify', '--file', file])).code).toBe(1);
    writeFileSync(file, 'not an export');
    expect((await cli(['audit', 'verify', '--file', file])).stderr).toContain('not an mcpspy audit export');
  });
});
