import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditTrail, chainHash, type AuditEvent } from '../src/audit.js';
import { machineStatus, escapeHtml, renderPage, type PageData } from '../src/collect/page.js';
import { assertSafeUrl, describeHead, followAudit, pushAudit } from '../src/collect/push.js';
import { startCollector, type Collector } from '../src/collect/server.js';
import { CollectorStore, defaultCollectorDbPath, type CollectedEvent, type MachineSummary } from '../src/collect/store.js';
import { Store } from '../src/store.js';
import { cli } from './cli-harness.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpspy-collect-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fill = (store: Store, count: number, label = 'tool') => {
  for (let i = 0; i < count; i++) store.appendAudit({ ts: 1000 + i, session_id: 1, type: 'call', data: JSON.stringify({ subject: `${label}${i}` }) });
};
const localEvents = (count: number, label?: string): AuditEvent[] => {
  const store = new Store(':memory:');
  fill(store, count, label);
  const events = [...store.auditEvents()];
  store.close();
  return events;
};
const head = (events: AuditEvent[]) => (events.length ? { seq: events.at(-1)!.seq, hash: events.at(-1)!.hash } : null);

describe('taking in events', () => {
  let store: CollectorStore;
  const machine = () => store.machineForToken(token)!;
  let token: string;
  beforeEach(() => {
    store = new CollectorStore(':memory:');
    token = store.addMachine('laptop', 5);
  });
  afterEach(() => store.close());

  it('keeps tokens hashed, and stops honouring revoked ones', () => {
    expect(token).toMatch(/^mcs_/);
    expect(machine().name).toBe('laptop');
    expect(JSON.stringify(store.machines())).not.toContain(token);
    expect(store.machineForToken('nope')).toBeUndefined();
    expect(store.revokeMachine('laptop')).toBe(true);
    expect(store.revokeMachine('laptop')).toBe(false);
    expect(store.machineForToken(token)).toBeUndefined();
  });

  it('accepts a chain in order, in pieces, and ignores repeats', () => {
    const events = localEvents(5);
    expect(store.ingest(machine(), events.slice(0, 2), head(events))).toMatchObject({ accepted: 2, problems: [], head: { seq: 2 } });
    expect(store.ingest(machine(), events.slice(1, 5), head(events))).toMatchObject({ accepted: 3, problems: [], head: head(events) });
    expect(store.ingest(machine(), events, head(events))).toMatchObject({ accepted: 0, problems: [] });
    expect(store.machines()[0]).toMatchObject({ head_seq: 5, incidents: 0 });
    expect(store.verify()[0]!.report.problems).toEqual([]);
  });

  it('answers an empty first push with no head', () => {
    expect(store.ingest(machine(), [], null)).toEqual({ accepted: 0, head: null, problems: [] });
  });

  it('flags a changed event, and keeps those before it', () => {
    const events = localEvents(3);
    const changed = events.map((event) => (event.seq === 2 ? { ...event, data: '{}' } : event));
    const result = store.ingest(machine(), changed, head(events));
    expect(result).toMatchObject({ accepted: 1, head: { seq: 1 }, problems: [{ kind: 'tampered', seq: 2 }] });
    expect(store.incidents()[0]).toMatchObject({ machine: 'laptop', kind: 'tampered', seq: 2, count: 1 });
  });

  it('flags an event whose hash is right but that follows the wrong event', () => {
    const events = localEvents(3);
    store.ingest(machine(), events.slice(0, 1), head(events));
    const forged = { ...events[1]!, prev_hash: 'a'.repeat(64) };
    forged.hash = chainHash(forged);
    expect(store.ingest(machine(), [forged], head(events)).problems[0]).toMatchObject({ kind: 'tampered', seq: 2 });
  });

  it('flags a gap', () => {
    const events = localEvents(3);
    expect(store.ingest(machine(), [events[2]!], head(events)).problems[0]).toMatchObject({ kind: 'gap', seq: 3 });
  });

  it('flags a rewritten chain and never replaces what it holds', () => {
    const events = localEvents(3);
    store.ingest(machine(), events, head(events));
    const rewritten = localEvents(3, 'other');
    expect(store.ingest(machine(), rewritten, head(rewritten)).problems[0]).toMatchObject({ kind: 'rewritten', seq: 1 });
    expect(store.ingest(machine(), [], head(rewritten)).problems[0]).toMatchObject({ kind: 'rewritten', seq: 3 });
    expect(store.machines()[0]!.head_hash).toBe(events[2]!.hash);
    expect(store.events({ limit: 10 }).map((event) => JSON.parse(event.data).subject)).not.toContain('other0');
  });

  it('flags a machine whose chain got shorter or vanished', () => {
    const events = localEvents(3);
    store.ingest(machine(), events, head(events));
    expect(store.ingest(machine(), [], head(events.slice(0, 2))).problems[0]).toMatchObject({ kind: 'truncated', seq: 3 });
    expect(store.ingest(machine(), [], null).problems[0]).toMatchObject({ kind: 'truncated', detail: "the machine's chain now ends at event 0" });
  });

  it('records what a machine found wrong with its own chain', () => {
    const events = localEvents(2);
    const result = store.ingest(machine(), events, head(events), 'event 1 is missing');
    expect(result).toMatchObject({ accepted: 2, problems: [{ kind: 'tampered', seq: 2, detail: "the machine's own check of its chain says: event 1 is missing" }] });
    expect(store.ingest(machine(), [], null, 'gone').problems.at(-1)).toMatchObject({ seq: 0 });
  });

  it('counts a repeated problem instead of adding it again', () => {
    const events = localEvents(2);
    store.ingest(machine(), events, head(events));
    store.ingest(machine(), [], null, null, 10);
    store.ingest(machine(), [], null, null, 20);
    expect(store.incidents()).toHaveLength(1);
    expect(store.incidents()[0]).toMatchObject({ count: 2, first_seen: 10, last_seen: 20 });
  });

  it('rolls back a push that fails partway', () => {
    const events = localEvents(2);
    expect(() => store.ingest(machine(), [events[0]!, { ...events[1]!, data: null as unknown as string, hash: chainHash({ ...events[1]!, data: null as unknown as string }) }], head(events))).toThrow();
    expect(store.machines()[0]!.head_seq).toBe(0);
  });

  it('summarises machines and filters events', () => {
    const other = store.addMachine('server');
    const write = new Store(':memory:');
    const trail = new AuditTrail(write, 1, 'files', () => 1, { user: 'a', host: 'b' });
    trail.started({ transport: 'stdio', command: '[]', cwd: '/', policy: null });
    trail.verdict('tools/call', { name: 'x' }, { allow: false, rule: 'r', reason: 'no' }, null);
    trail.verdict('tools/call', { name: 'y' }, { allow: true, rule: 'r' }, null);
    const events = [...write.auditEvents()];
    write.close();
    store.ingest(machine(), events, head(events));
    const more = localEvents(1);
    store.ingest(store.machineForToken(other)!, more, head(more));
    expect(store.machines().map((entry) => [entry.name, entry.denied, entry.open_sessions])).toEqual([['laptop', 1, 1], ['server', 0, 0]]);
    expect(store.events({ limit: 10 })).toHaveLength(4);
    expect(store.events({ limit: 1 })).toHaveLength(1);
    expect(store.events({ machine: 'server', limit: 10 })).toHaveLength(1);
    expect(store.events({ denied: true, limit: 10 }).map((event) => event.seq)).toEqual([2]);
  });

  it('finds changes made directly to its own file', () => {
    const path = join(dir, 'collector.db');
    const onDisk = new CollectorStore(path);
    const machineToken = onDisk.addMachine('m');
    const events = localEvents(2);
    onDisk.ingest(onDisk.machineForToken(machineToken)!, events, head(events));
    onDisk.addMachine('empty');
    onDisk.close();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE events SET data = '{}'")).toThrow(/append-only/);
    expect(() => raw.exec('DELETE FROM events')).toThrow(/append-only/);
    raw.exec("DROP TRIGGER events_no_update; UPDATE events SET data = '{}' WHERE seq = 2");
    raw.close();
    const again = new CollectorStore(path);
    expect(again.verify().map((entry) => entry.report.problems.length)).toEqual([0, 1]);
    again.close();
  });

  it('finds its data through the environment', () => {
    process.env.MCPSPY_COLLECT_DB = '/somewhere.db';
    expect(defaultCollectorDbPath()).toBe('/somewhere.db');
    delete process.env.MCPSPY_COLLECT_DB;
    expect(defaultCollectorDbPath()).toContain('collector.db');
  });
});

describe('the web view', () => {
  const summary = (fields: Partial<MachineSummary> = {}): MachineSummary => ({
    id: 1, name: 'laptop', created_at: 0, last_seen: 1000, revoked_at: null, head_seq: 3, head_hash: 'a'.repeat(64), denied: 0, open_sessions: 0, incidents: 0, ...fields,
  });
  const event = (type: AuditEvent['type'], data: unknown): CollectedEvent => ({
    seq: 1, ts: 0, session_id: 1, type, data: typeof data === 'string' ? data : JSON.stringify(data), prev_hash: '', hash: '', machine: 'laptop', received_at: 0,
  });
  const page = (fields: Partial<PageData> = {}) => renderPage({ machines: [], incidents: [], events: [], filter: {}, now: 1000, silentAfterMs: 100, ...fields });

  it('gives each machine the worst status true of it', () => {
    expect(machineStatus(summary({ incidents: 1, revoked_at: 1 }), 1000, 100)).toBe('flagged');
    expect(machineStatus(summary({ revoked_at: 1 }), 1000, 100)).toBe('revoked');
    expect(machineStatus(summary({ last_seen: null }), 1000, 100)).toBe('waiting');
    expect(machineStatus(summary({ last_seen: 1 }), 1000, 100)).toBe('silent');
    expect(machineStatus(summary(), 1000, 100)).toBe('ok');
  });

  it('escapes everything a machine or agent can choose', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    const evil = '<script>alert(1)</script>';
    const html = page({
      machines: [summary({ name: evil })],
      incidents: [{ id: 1, machine: evil, kind: 'gap', seq: 1, detail: evil, first_seen: 0, last_seen: 0, count: 1 }],
      events: [
        { ...event('call', { subject: evil, agent: evil }), machine: evil },
        event('session_start', { user: evil, host: evil, command: evil }),
        event('session_end', { exit_signal: evil }),
        event('verdict', { decision: evil, subject: evil, rule: evil, reason: evil }),
        event('approval', { action: evil }),
        event('outcome', { subject: evil, status: evil, rule: evil }),
      ],
      filter: { machine: evil },
    });
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders each kind of event, including forged ones', () => {
    const html = page({
      events: [
        event('session_end', { exit_code: 0 }),
        event('session_end', { exit_code: null }),
        event('verdict', { decision: 'ask', method: 'ping' }),
        event('verdict', { decision: 'allow', subject: 'allowed-tool' }),
        event('verdict', { decision: 'deny' }),
        event('outcome', { status: 'ok', subject: 'worked' }),
        event('call', { subject: 'no-agent' }),
        event('call', 'not json'),
        event('nonsense' as AuditEvent['type'], {}),
      ],
    });
    for (const text of ['exit 0', 'ended', 'badge warn', 'allowed-tool', 'worked', 'no-agent', 'nonsense']) expect(html).toContain(text);
  });

  it('shows how long ago, and what is empty', () => {
    const at = (ms: number) => page({ now: ms, silentAfterMs: 1e12, machines: [summary({ last_seen: 0 })] });
    expect(at(5_000)).toContain('5s ago');
    expect(at(120_000)).toContain('2m ago');
    expect(at(7_200_000)).toContain('2h ago');
    expect(at(172_800_000)).toContain('2d ago');
    expect(page({ machines: [summary({ last_seen: null, head_hash: null, head_seq: 0 })] })).toContain('never');
    expect(page()).toContain('No machines yet');
    expect(page()).toContain('None: every chain lines up');
    const tones = page({ now: 1e12, silentAfterMs: 1, machines: [summary({ last_seen: 0, denied: 2 }), summary({ incidents: 1 })] });
    expect(tones).toContain('stat bad');
    expect(tones).toContain('stat warn');
  });

  it('offers and describes its filters', () => {
    expect(page()).toContain('denied only');
    expect(page({ filter: { denied: true } })).toContain('Denied calls');
    expect(page({ filter: { denied: true } })).toContain('show all');
    expect(page({ filter: { denied: true, machine: 'm' } })).toContain('Denied calls on m');
    const one = page({ filter: { machine: 'a b' } });
    expect(one).toContain('Latest events on a b');
    expect(one).toContain('?machine=a%20b&amp;denied=1');
  });
});

describe('the collector over HTTP', () => {
  let store: CollectorStore;
  let collector: Collector;
  let token: string;
  const viewKey = 'view-secret';
  beforeEach(async () => {
    store = new CollectorStore(':memory:');
    token = store.addMachine('laptop');
    collector = await startCollector({ store, port: 0, viewKey });
  });
  afterEach(async () => {
    await collector.close();
    store.close();
  });

  const push = (body: unknown, auth: string | null = `Bearer ${token}`) =>
    fetch(new URL('/v1/events', collector.url), { method: 'POST', headers: auth ? { authorization: auth } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const open = async () => {
    const response = await fetch(`${collector.url}?key=${viewKey}`, { redirect: 'manual' });
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };

  it('needs a valid token to take events', async () => {
    expect((await push({ head: null, events: [] }, null)).status).toBe(401);
    expect((await push({ head: null, events: [] }, 'Basic abc')).status).toBe(401);
    expect((await push({ head: null, events: [] }, 'Bearer wrong')).status).toBe(401);
    store.revokeMachine('laptop');
    expect((await push({ head: null, events: [] })).status).toBe(401);
  });

  it('takes valid events and answers 409 on a problem', async () => {
    const events = localEvents(2);
    const ok = await push({ head: head(events), events });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ accepted: 2 });
    const bad = await push({ head: null, events: [] });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ problems: [{ kind: 'truncated' }] });
  });

  it.each([
    ['not JSON', '{bad', /not JSON/],
    ['null', 'null', /events must be/],
    ['a bad head', { head: { seq: 0, hash: 'x' }, events: [] }, /head must be/],
    ['a head without a hash', { head: { seq: 1 }, events: [] }, /head must be/],
    ['a head that is a number', { head: 3, events: [] }, /head must be/],
    ['no list of events', { head: null }, /events must be/],
    ['a non-string local problem', { head: null, events: [], local_problem: 1 }, /local_problem must be/],
    ['a long local problem', { head: null, events: [], local_problem: 'x'.repeat(1001) }, /local_problem must be/],
    ['an event that is null', { head: null, events: [null] }, /events must be/],
    ['an event with a bad type', { head: null, events: [{ ...localEvents(1)[0], type: 'x' }] }, /events must be/],
    ['an event with a bad seq', { head: null, events: [{ ...localEvents(1)[0], seq: 0 }] }, /events must be/],
    ['an event with a bad ts', { head: null, events: [{ ...localEvents(1)[0], ts: 'x' }] }, /events must be/],
    ['an event with a bad session', { head: null, events: [{ ...localEvents(1)[0], session_id: -1 }] }, /events must be/],
    ['an event with no data', { head: null, events: [{ ...localEvents(1)[0], data: 1 }] }, /events must be/],
    ['an event with a bad previous hash', { head: null, events: [{ ...localEvents(1)[0], prev_hash: 'x' }] }, /events must be/],
    ['an event with a non-string previous hash', { head: null, events: [{ ...localEvents(1)[0], prev_hash: 1 }] }, /events must be/],
    ['an event with a bad hash', { head: null, events: [{ ...localEvents(1)[0], hash: 'x' }] }, /events must be/],
    ['an event with a non-string hash', { head: null, events: [{ ...localEvents(1)[0], hash: 1 }] }, /events must be/],
  ])('refuses %s', async (_name, body, message) => {
    const response = await push(body);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toMatch(message);
  });

  it('refuses oversized pushes', async () => {
    const many = Array.from({ length: 1001 }, () => localEvents(1)[0]);
    expect((await push({ head: null, events: many })).status).toBe(413);
    expect((await push('x'.repeat(9 * 1024 * 1024))).status).toBe(413);
  });

  it('stores only the fields the chain covers', async () => {
    const events = localEvents(1);
    await push({ head: head(events), events: [{ ...events[0], extra: 'junk' }] });
    expect(JSON.stringify(store.events({ limit: 1 }))).not.toContain('junk');
  });

  it('keeps people out without the key, and swaps the key for a cookie', async () => {
    expect((await fetch(collector.url)).status).toBe(401);
    expect((await fetch(`${collector.url}?key=wrong`)).status).toBe(401);
    expect((await fetch(`${collector.url}?key=${viewKey}x`)).status).toBe(401);
    expect((await fetch(collector.url, { headers: { cookie: 'other=1' } })).status).toBe(401);
    const redirect = await fetch(`${collector.url}?key=${viewKey}&machine=a`, { redirect: 'manual' });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('location')).toBe('/?machine=a');
    expect(redirect.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    expect(redirect.headers.get('set-cookie')).not.toContain('Secure');
    const cookie = await open();
    const page = await fetch(collector.url, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).toContain('mcpspy collector');
  });

  it('serves JSON, filtered', async () => {
    const events = localEvents(3);
    await push({ head: head(events), events });
    const cookie = await open();
    const get = async (path: string) => {
      const response = await fetch(new URL(path, collector.url), { headers: { cookie } });
      return { status: response.status, body: await response.json() as unknown[] };
    };
    expect((await get('/api/machines')).body).toHaveLength(1);
    expect((await get('/api/incidents')).body).toEqual([]);
    expect((await get('/api/events')).body).toHaveLength(3);
    expect((await get('/api/events?limit=2')).body).toHaveLength(2);
    expect((await get('/api/events?machine=none')).body).toEqual([]);
    expect((await get('/api/events?denied=1')).body).toEqual([]);
    expect((await get('/nothing')).status).toBe(404);
  });

  it('refuses other methods and foreign Host names', async () => {
    expect((await fetch(collector.url, { method: 'DELETE' })).status).toBe(405);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      request(new URL(collector.url), { headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode!)).end();
    });
    expect(status).toBe(403);
  });

  it('says little when something inside fails', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    store.ingest = () => {
      throw new Error('disk full: /secret/path');
    };
    const response = await push({ head: null, events: [] });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
    expect(write.mock.calls.join()).toContain('disk full');
    write.mockRestore();
  });

  it('answers on non-loopback binds without a Host check, and shows IPv6 hosts properly', async () => {
    const wide = await startCollector({ store, host: '0.0.0.0', port: 0, viewKey });
    expect((await fetch(`http://127.0.0.1:${new URL(wide.url).port}/`)).status).toBe(401);
    await wide.close();
    const six = await startCollector({ store, host: '::1', port: 0, viewKey });
    expect(six.url).toMatch(/^http:\/\/\[::1\]:\d+\/$/);
    await six.close();
  });

  it('reports a port in use', async () => {
    const port = Number(new URL(collector.url).port);
    await expect(startCollector({ store, port, viewKey })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('serves TLS, with a Secure cookie', async () => {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const secure = await startCollector({ store, port: 0, viewKey, tls: { cert: readFileSync(cert), key: readFileSync(key) } });
    expect(secure.url).toMatch(/^https:/);
    const cookie = await new Promise<string>((resolve) => {
      httpsRequest(`${secure.url}?key=${viewKey}`, { rejectUnauthorized: false }, (res) => resolve(res.headers['set-cookie']![0]!)).end();
    });
    expect(cookie).toContain('Secure');
    await secure.close();
  });
});

describe('pushing', () => {
  let collectorStore: CollectorStore;
  let collector: Collector;
  let token: string;
  let local: Store;
  beforeEach(async () => {
    collectorStore = new CollectorStore(':memory:');
    token = collectorStore.addMachine('laptop');
    collector = await startCollector({ store: collectorStore, port: 0, viewKey: 'k' });
    local = new Store(join(dir, 'log.db'));
  });
  afterEach(async () => {
    local.close();
    await collector.close();
    collectorStore.close();
  });
  const options = () => ({ url: collector.url, token });

  it('only allows plain HTTP to this machine unless told otherwise', () => {
    expect(assertSafeUrl('https://audit.example.com', false).host).toBe('audit.example.com');
    expect(assertSafeUrl('http://localhost:7900', false).port).toBe('7900');
    expect(() => assertSafeUrl('http://audit.example.com', false)).toThrow(/unencrypted/);
    expect(assertSafeUrl('http://audit.example.com', true).protocol).toBe('http:');
    expect(() => assertSafeUrl('nope', false)).toThrow(/not a URL/);
    expect(() => assertSafeUrl('ftp://x', false)).toThrow(/not an http/);
  });

  it('describes a head', () => {
    expect(describeHead(null)).toBe('empty');
    expect(describeHead({ seq: 2, hash: 'ab' })).toBe('2:ab');
  });

  it('sends everything, in batches, then only what is new', async () => {
    fill(local, 7);
    expect(await pushAudit(local, { ...options(), batch: 3 })).toMatchObject({ sent: 7, problems: [], head: local.auditHead() });
    expect(await pushAudit(local, options())).toMatchObject({ sent: 0, problems: [] });
    fill(local, 2);
    expect(await pushAudit(local, options())).toMatchObject({ sent: 2, head: local.auditHead() });
    expect(collectorStore.verify()[0]!.report).toMatchObject({ count: 9, problems: [] });
  });

  it('has nothing to do on an empty log, but still counts as seen', async () => {
    expect(await pushAudit(local, options())).toEqual({ sent: 0, head: null, problems: [] });
    expect(collectorStore.machines()[0]!.last_seen).not.toBeNull();
  });

  it('is flagged when the local chain was rebuilt or cut, and the collector keeps its copy', async () => {
    fill(local, 3);
    await pushAudit(local, options());
    const held = collectorStore.machines()[0]!.head_hash;
    const path = join(dir, 'log.db');
    local.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER audit_events_no_delete; DROP TRIGGER audit_events_no_update; DELETE FROM audit_events WHERE seq = 3;');
    raw.close();
    local = new Store(path);
    expect((await pushAudit(local, options())).problems[0]).toContain('truncated at event 3');

    local.close();
    const again = new DatabaseSync(path);
    again.exec("DROP TRIGGER IF EXISTS audit_events_no_delete; DELETE FROM audit_events; DELETE FROM sqlite_sequence WHERE name = 'audit_events';");
    again.close();
    local = new Store(path);
    fill(local, 5, 'forged');
    expect((await pushAudit(local, options())).problems[0]).toContain('rewritten at event');
    expect(collectorStore.machines()[0]!.head_hash).toBe(held);
    expect(collectorStore.incidents().map((incident) => incident.kind).sort()).toEqual(['rewritten', 'truncated']);
  });

  it('is flagged when events vanish from the middle, even with the head unchanged', async () => {
    fill(local, 5);
    await pushAudit(local, options());
    const path = join(dir, 'log.db');
    local.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE seq = 3;');
    raw.close();
    local = new Store(path);
    // Only the machine's own check can see this: the head still matches.
    expect((await pushAudit(local, { ...options(), checkLocal: false })).problems).toEqual([]);
    expect((await pushAudit(local, options())).problems[0]).toContain('event 3 is missing');
    expect(collectorStore.machines()[0]).toMatchObject({ head_seq: 5, incidents: 1 });
    expect(collectorStore.verify()[0]!.report.problems).toEqual([]);
  });

  it('a follow checks the whole chain at first and then only now and then', async () => {
    fill(local, 3);
    const path = join(dir, 'log.db');
    await pushAudit(local, options());
    local.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE seq = 2;');
    raw.close();
    local = new Store(path);
    const log: string[] = [];
    const stop = new AbortController();
    const running = followAudit(local, { ...options(), intervalMs: 2, signal: stop.signal, log: (message) => log.push(message) });
    await vi.waitFor(() => expect(log).toHaveLength(1));
    // Later pushes skip the check, so the same problem isn't raised on every one.
    const count = collectorStore.incidents()[0]!.count;
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    await running;
    expect(log[0]).toContain('event 2 is missing');
    expect(collectorStore.incidents()[0]!.count).toBe(count);
  });

  it('fails clearly on a bad token or a dead collector', async () => {
    await expect(pushAudit(local, { ...options(), token: 'wrong' })).rejects.toThrow(/answered 401/);
    await collector.close();
    await expect(pushAudit(local, options())).rejects.toThrow();
  });

  it('follows until stopped, says each thing once, and survives failures', async () => {
    fill(local, 2);
    const log: string[] = [];
    const stop = new AbortController();
    const running = followAudit(local, { ...options(), intervalMs: 5, signal: stop.signal, log: (message) => log.push(message) });
    await vi.waitFor(() => expect(collectorStore.machines()[0]!.head_seq).toBe(2));
    fill(local, 1);
    await vi.waitFor(() => expect(collectorStore.machines()[0]!.head_seq).toBe(3));
    stop.abort();
    await running;
    expect(log[0]).toContain('sent 2 events');
    expect(log[1]).toContain('sent 1 event;');

    const failing: string[] = [];
    const stopFailing = new AbortController();
    const broken = followAudit(local, { ...options(), token: 'wrong', intervalMs: 2, signal: stopFailing.signal, log: (message) => failing.push(message) });
    await vi.waitFor(() => expect(failing).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopFailing.abort();
    await broken;
    expect(failing).toHaveLength(1);
    expect(failing[0]).toContain('push failed, will retry');

    local.close();
    const path = join(dir, 'log.db');
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE seq = 3;');
    raw.close();
    local = new Store(path);
    const flagged: string[] = [];
    const stopFlagged = new AbortController();
    const running2 = followAudit(local, { ...options(), intervalMs: 2, checkEveryMs: 1, signal: stopFlagged.signal, log: (message) => flagged.push(message) });
    await vi.waitFor(() => expect(flagged).toHaveLength(1));
    stopFlagged.abort();
    await running2;
    expect(flagged[0]).toContain('the collector flagged this chain');
  });
});

describe('the commands', () => {
  let db: string;
  let collectorDb: string;
  beforeEach(() => {
    db = join(dir, 'log.db');
    collectorDb = join(dir, 'collector.db');
  });
  afterEach(() => {
    delete process.env.MCPSPY_COLLECT_TOKEN;
    delete process.env.MCPSPY_COLLECT_VIEW_KEY;
  });
  const addMachine = async (name: string) => /MCPSPY_COLLECT_TOKEN=(\S+)/.exec((await cli(['collect', 'add', name, '--db', collectorDb])).stdout)![1]!;

  it('add, machines and revoke manage machines', async () => {
    expect((await cli(['collect', 'machines', '--db', collectorDb])).stdout).toContain('No machines yet');
    const added = await cli(['collect', 'add', 'laptop', '--db', collectorDb]);
    expect(added.stdout).toMatch(/^MCPSPY_COLLECT_TOKEN=mcs_/);
    expect(added.stderr).toContain('shown once');
    expect((await cli(['collect', 'add', 'laptop', '--db', collectorDb])).stderr).toContain("there's already a machine named laptop");
    expect((await cli(['collect', 'add', '--db', collectorDb])).stderr).toContain('needs a machine name');
    expect((await cli(['collect', 'machines', '--db', collectorDb])).stdout).toContain('laptop');
    expect(JSON.parse((await cli(['collect', 'machines', '--json', '--db', collectorDb])).stdout)[0].name).toBe('laptop');
    expect((await cli(['collect', 'revoke', 'laptop', '--db', collectorDb])).stdout).toContain('Revoked laptop');
    expect((await cli(['collect', 'revoke', 'laptop', '--db', collectorDb])).stderr).toContain('no active machine');
  });

  it('verify reports each chain', async () => {
    expect((await cli(['collect', 'verify', '--db', collectorDb])).stdout).toContain('No machines to verify');
    const store = new CollectorStore(collectorDb);
    const token = store.addMachine('laptop');
    const events = localEvents(2);
    store.ingest(store.machineForToken(token)!, events, head(events));
    store.close();
    const good = await cli(['collect', 'verify', '--db', collectorDb]);
    expect([good.code, good.stdout]).toEqual([0, 'laptop: intact, 2 events\n']);
    expect((await cli(['collect', 'machines', '--db', collectorDb])).stdout).toContain(`anchor 2:${events[1]!.hash}`);
    const raw = new DatabaseSync(collectorDb);
    raw.exec("DROP TRIGGER events_no_update; UPDATE events SET data = '{}' WHERE seq = 1");
    raw.close();
    const bad = await cli(['collect', 'verify', '--db', collectorDb]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('laptop: FAILED: event 1 was changed');
  });

  it('serving checks its options before starting', async () => {
    expect((await cli(['collect', 'nonsense', '--db', collectorDb])).stderr).toContain('unknown collect command');
    expect((await cli(['collect', '--tls-cert', 'x', '--db', collectorDb])).stderr).toContain('go together');
    expect((await cli(['collect', '--tls-key', 'x', '--db', collectorDb])).stderr).toContain('go together');
    expect((await cli(['collect', '--host', '0.0.0.0', '--db', collectorDb])).stderr).toContain('unencrypted');
    expect((await cli(['collect', '--silent-after', 'soon', '--db', collectorDb])).stderr).toContain('is not an age');
  });

  it('serves until signalled, and explains a port in use', async () => {
    process.env.MCPSPY_COLLECT_VIEW_KEY = 'fixed-key';
    process.env.MCPSPY_COLLECT_DB = collectorDb;
    const run = await cli(['collect', '--port', '0']);
    delete process.env.MCPSPY_COLLECT_DB;
    expect(run.stdout).toContain('?key=fixed-key');
    expect(run.stdout).toContain(`data: ${collectorDb}`);
    const url = /(http:\S+)\?key/.exec(run.stdout)![1]!;
    expect((await fetch(url)).status).toBe(401);
    const stopped = new Promise<void>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementationOnce((() => {
        resolve();
        return undefined as never;
      }) as typeof process.exit);
    });
    run.signals.get('SIGTERM')!();
    await stopped;
    vi.restoreAllMocks();

    const taken = await startCollector({ store: new CollectorStore(':memory:'), port: 0, viewKey: 'k' });
    const port = new URL(taken.url).port;
    expect((await cli(['collect', '--port', port, '--db', collectorDb])).stderr).toContain(`port ${port} is in use`);
    await taken.close();
  });

  it('starts on a network address only with TLS or --plain-http, and passes other start errors on', async () => {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=x'], { stdio: 'ignore' });
    for (const flags of [['--tls-cert', cert, '--tls-key', key], ['--plain-http']]) {
      const run = await cli(['collect', '--host', '0.0.0.0', '--port', '0', ...flags, '--db', collectorDb]);
      expect(run.code).toBe(0);
      const stopped = new Promise<void>((resolve) => {
        vi.spyOn(process, 'exit').mockImplementationOnce((() => {
          resolve();
          return undefined as never;
        }) as typeof process.exit);
      });
      run.signals.get('SIGINT')!();
      await stopped;
      vi.restoreAllMocks();
    }
    await expect(cli(['collect', '--host', '192.0.2.1', '--plain-http', '--port', '0', '--db', collectorDb])).rejects.toThrow();
  });

  it('push checks its inputs', async () => {
    expect((await cli(['audit', 'push', '--db', db])).stderr).toContain("needs the collector's URL");
    expect((await cli(['audit', 'push', 'http://localhost:1', '--db', db])).stderr).toContain('MCPSPY_COLLECT_TOKEN');
    process.env.MCPSPY_COLLECT_TOKEN = 't';
    expect((await cli(['audit', 'push', 'http://audit.example.com', '--db', db])).stderr).toContain('unencrypted');
    expect((await cli(['audit', 'push', 'http://localhost:1', '--interval', '0', '--db', db])).stderr).toContain('at least 1 second');
    expect((await cli(['audit', 'push', 'http://audit.invalid', '--insecure-http', '--db', db])).stderr).toContain("couldn't push");
  });

  it('push sends the trail, and fails when the collector flags it', async () => {
    const collectorStore = new CollectorStore(':memory:');
    process.env.MCPSPY_COLLECT_TOKEN = collectorStore.addMachine('laptop');
    const collector = await startCollector({ store: collectorStore, port: 0, viewKey: 'k' });
    const local = new Store(db);
    fill(local, 2);
    local.close();
    const sent = await cli(['audit', 'push', collector.url, '--db', db]);
    expect([sent.code, sent.stdout]).toEqual([0, expect.stringContaining('Sent 2 events')]);
    const raw = new DatabaseSync(db);
    raw.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE seq = 2');
    raw.close();
    const flagged = await cli(['audit', 'push', collector.url, '--db', db]);
    expect(flagged.code).toBe(1);
    expect(flagged.stdout).toContain('truncated at event 2');
    expect(flagged.stdout).toContain('kept what it already had');
    await collector.close();
    collectorStore.close();
  });

  it('push --follow runs until signalled', async () => {
    const collectorStore = new CollectorStore(':memory:');
    process.env.MCPSPY_COLLECT_TOKEN = collectorStore.addMachine('laptop');
    const collector = await startCollector({ store: collectorStore, port: 0, viewKey: 'k' });
    const local = new Store(db);
    fill(local, 1);
    local.close();
    const handlers = new Map<string, () => void>();
    const once = vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
      handlers.set(event, listener);
      return process;
    }) as typeof process.once);
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { main } = await import('../src/cli.js');
    const running = main(['audit', 'push', collector.url, '--follow', '--interval', '1', '--db', db]);
    await vi.waitFor(() => expect(collectorStore.machines()[0]!.head_seq).toBe(1));
    handlers.get('SIGTERM')!();
    await running;
    expect(write.mock.calls.join()).toContain('sent 1 event;');
    expect(handlers.has('SIGINT')).toBe(true);
    handlers.get('SIGINT')!();
    once.mockRestore();
    write.mockRestore();
    await collector.close();
    collectorStore.close();
  });
});
