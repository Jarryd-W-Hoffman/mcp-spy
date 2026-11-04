import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../src/audit.js';
import { alertText, retryDelay, sendTestAlert, startAlerts, type Alerts } from '../src/collect/alerts.js';
import { renderPage } from '../src/collect/page.js';
import { startCollector } from '../src/collect/server.js';
import { CollectorStore, INCIDENT_ALERTS_PER_HOUR, type AlertBody } from '../src/collect/store.js';
import { Store } from '../src/store.js';
import { cli } from './cli-harness.js';

const localEvents = (count: number): AuditEvent[] => {
  const store = new Store(':memory:');
  for (let i = 0; i < count; i++) store.appendAudit({ ts: i, session_id: 1, type: 'call', data: '{}' });
  const events = [...store.auditEvents()];
  store.close();
  return events;
};

type Received = { text: string; alert: AlertBody & { kind: string } };

/** A webhook that keeps what it's sent and answers with the status the test sets. */
async function webhook() {
  const received: Received[] = [];
  const state = { status: 200, redirect: false };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (state.redirect) return void res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end();
      if (state.status < 300) received.push(JSON.parse(body) as Received);
      res.writeHead(state.status).end(state.status === 204 ? undefined : 'secret detail in the reply');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    received,
    state,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/services/SECRET`,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

describe('what an alert says', () => {
  it('describes each kind', () => {
    expect(alertText({ kind: 'incident', machine: 'ben', at: 0, incident: { kind: 'gap', seq: 3, detail: 'expected event 2 next' } })).toBe('mcpspy: ben was flagged: gap at event 3. expected event 2 next.');
    expect(alertText({ kind: 'silent', machine: 'ben', at: 0, last_seen: 0 })).toBe('mcpspy: ben has gone silent. Last heard from 1970-01-01 00:00 UTC.');
    expect(alertText({ kind: 'recovered', machine: 'ben', at: 0 })).toBe('mcpspy: ben is pushing again.');
  });

  it("won't let a machine ping a channel, post a link or fake a line", () => {
    const text = alertText({ kind: 'incident', machine: '<!here>', at: 0, incident: { kind: 'tampered', seq: 1, detail: 'x <!channel> <http://evil|click> & \n forged' } });
    expect(text).not.toMatch(/[<>\n]/);
    expect(text).toContain('&lt;!channel&gt; &lt;http://evil|click&gt; &amp;   forged');
    expect(text).toContain('&lt;!here&gt;');
  });

  it('shortens long details, and says when it stops alerting', () => {
    const long = alertText({ kind: 'incident', machine: 'm', at: 0, limit_reached: true, incident: { kind: 'gap', seq: 1, detail: 'x'.repeat(1000) } });
    expect(long.length).toBeLessThan(450);
    expect(long).toContain('…');
    expect(long).toContain('No more alerts for this machine');
  });

  it('waits longer after each failure, up to an hour', () => {
    expect([0, 1, 2, 20].map((attempts) => retryDelay(attempts))).toEqual([30_000, 60_000, 120_000, 3_600_000]);
  });
});

describe('the queue', () => {
  let store: CollectorStore;
  let token: string;
  const machine = () => store.machineForToken(token)!;
  beforeEach(() => {
    store = new CollectorStore(':memory:');
    token = store.addMachine('ben');
  });
  afterEach(() => store.close());

  it('stays empty until alerts are on, so turning them on sends no backlog', () => {
    store.ingest(machine(), [], null, 'broken');
    store.noteSilentMachines(1, Date.now() + 100);
    expect(store.dueAlerts()).toEqual([]);
    expect(store.alertStatus()).toEqual({ waiting: 0, lastError: null });
  });

  it('queues a new incident once, however often it recurs', () => {
    store.enableAlerts();
    store.ingest(machine(), [], null, 'broken');
    store.ingest(machine(), [], null, 'broken');
    const due = store.dueAlerts();
    expect(due).toHaveLength(1);
    expect(JSON.parse(due[0]!.body)).toMatchObject({ kind: 'incident', machine: 'ben', incident: { kind: 'tampered' } });
    expect(store.incidents()[0]!.count).toBe(2);
  });

  it('limits how many alerts one machine can cause, but keeps every incident', () => {
    store.enableAlerts();
    const other = store.addMachine('other');
    for (let i = 0; i < INCIDENT_ALERTS_PER_HOUR + 3; i++) store.ingest(machine(), [], null, `problem ${i}`, 1000);
    const due = store.dueAlerts(1000).map((alert) => JSON.parse(alert.body) as AlertBody);
    expect(due).toHaveLength(INCIDENT_ALERTS_PER_HOUR);
    expect(due.map((alert) => alert.limit_reached ?? false)).toEqual([false, false, false, false, true]);
    expect(store.incidents()).toHaveLength(INCIDENT_ALERTS_PER_HOUR + 3);

    store.ingest(store.machineForToken(other)!, [], null, 'unrelated', 1000);
    expect(store.dueAlerts(1000)).toHaveLength(INCIDENT_ALERTS_PER_HOUR + 1);
    store.ingest(machine(), [], null, 'an hour on', 1000 + 3_600_001);
    expect(store.dueAlerts(1000 + 3_600_001, 100)).toHaveLength(INCIDENT_ALERTS_PER_HOUR + 2);
  });

  it('reports each silence once, and the recovery', () => {
    store.enableAlerts();
    const events = localEvents(1);
    store.ingest(machine(), events, { seq: 1, hash: events[0]!.hash }, null, 1000);
    store.addMachine('never-pushed');
    const revoked = store.addMachine('revoked');
    store.ingest(store.machineForToken(revoked)!, [], null, null, 1000);
    store.revokeMachine('revoked');

    store.noteSilentMachines(100, 1050);
    expect(store.dueAlerts(1050)).toEqual([]);
    store.noteSilentMachines(100, 2000);
    store.noteSilentMachines(100, 3000);
    expect(store.dueAlerts(3000).map((alert) => JSON.parse(alert.body))).toMatchObject([{ kind: 'silent', machine: 'ben', last_seen: 1000 }]);

    store.ingest(machine(), [], { seq: 1, hash: events[0]!.hash }, null, 4000);
    expect(store.dueAlerts(4000).map((alert) => (JSON.parse(alert.body) as AlertBody).kind)).toEqual(['silent', 'recovered']);
    store.noteSilentMachines(100, 4050);
    expect(store.dueAlerts(4050)).toHaveLength(2);
    store.noteSilentMachines(100, 9000);
    expect(store.dueAlerts(9000)).toHaveLength(3);
  });

  it('rolls back a sweep that fails', () => {
    store.enableAlerts();
    store.ingest(machine(), [], null, null, 1000);
    store.close();
    expect(() => store.noteSilentMachines(1, 5000)).toThrow();
    store = new CollectorStore(':memory:');
    const broken = store as unknown as { queueAlert(): void };
    token = store.addMachine('ben');
    store.ingest(machine(), [], null, null, 1000);
    broken.queueAlert = () => {
      throw new Error('disk full');
    };
    expect(() => store.noteSilentMachines(1, 5000)).toThrow('disk full');
    delete (broken as { queueAlert?: unknown }).queueAlert;
    store.enableAlerts();
    store.noteSilentMachines(1, 5000);
    expect(store.dueAlerts(5000)).toHaveLength(1);
  });

  it('tracks retries and forgets old sent alerts', () => {
    store.enableAlerts();
    store.ingest(machine(), [], null, 'one', 1000);
    const [alert] = store.dueAlerts(1000);
    store.alertFailed(alert!.id, 5000, 'hooks.example answered 500');
    expect(store.dueAlerts(1000)).toEqual([]);
    expect(store.alertStatus()).toEqual({ waiting: 1, lastError: 'hooks.example answered 500' });
    expect(store.dueAlerts(5000)[0]!.attempts).toBe(1);
    store.alertSent(alert!.id, 6000);
    expect(store.alertStatus()).toEqual({ waiting: 0, lastError: null });
    expect(store.dueAlerts(9000)).toEqual([]);
    // Still counted toward the hourly limit, until a day later.
    for (let i = 0; i < INCIDENT_ALERTS_PER_HOUR; i++) store.ingest(machine(), [], null, `more ${i}`, 7000);
    expect(store.dueAlerts(7000)).toHaveLength(INCIDENT_ALERTS_PER_HOUR - 1);
    store.alertSent(store.dueAlerts(7000)[0]!.id, 6000 + 24 * 3_600_000 + 1);
    expect(store.alertStatus().waiting).toBe(INCIDENT_ALERTS_PER_HOUR - 2);
  });
});

describe('sending', () => {
  let store: CollectorStore;
  let hook: Awaited<ReturnType<typeof webhook>>;
  let alerts: Alerts | undefined;
  let token: string;
  const logs: string[] = [];
  const machine = () => store.machineForToken(token)!;
  const start = (silentAfterMs: number | null = null, firstRetryMs = 60_000) => {
    alerts = startAlerts({ store, url: hook.url, silentAfterMs, log: (message) => logs.push(message), pollMs: 5, firstRetryMs });
  };
  beforeEach(async () => {
    logs.length = 0;
    store = new CollectorStore(':memory:');
    store.enableAlerts();
    token = store.addMachine('ben');
    hook = await webhook();
  });
  afterEach(async () => {
    await alerts?.close();
    alerts = undefined;
    await hook.close();
    store.close();
  });

  it('sends what is queued, in order, and only once', async () => {
    store.ingest(machine(), [], null, 'first');
    store.ingest(machine(), [], null, 'second');
    start();
    await vi.waitFor(() => expect(hook.received).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hook.received).toHaveLength(2);
    expect(hook.received[0]!.text).toContain('first');
    expect(hook.received[0]!.alert).toMatchObject({ kind: 'incident', machine: 'ben' });
    expect(hook.received[1]!.text).toContain('second');
    expect(store.alertStatus().waiting).toBe(0);
    expect(logs).toEqual([]);
  });

  it('accepts any success, with or without a body', async () => {
    hook.state.status = 204;
    store.ingest(machine(), [], null, 'one');
    start();
    await vi.waitFor(() => expect(hook.received).toHaveLength(1));
    await vi.waitFor(() => expect(store.alertStatus().waiting).toBe(0));
  });

  it('keeps an alert through an outage, without leaking the address or the reply', async () => {
    hook.state.status = 500;
    store.ingest(machine(), [], null, 'during the outage');
    store.ingest(machine(), [], null, 'also during it');
    start();
    await vi.waitFor(() => expect(store.alertStatus().lastError).toContain('answered 500'));
    expect(store.alertStatus().waiting).toBe(2);
    expect(logs[0]).toContain("alerts aren't getting through");
    expect(JSON.stringify([logs, store.alertStatus()])).not.toMatch(/SECRET|secret detail/);
    // The whole queue waits, so the second can't overtake the first, however many rounds go by.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.dueAlerts(Date.now())[0]!.attempts).toBe(0);
    expect(logs).toHaveLength(1);

    // A restart picks up what's due: the second now, and the first once its wait is over.
    hook.state.status = 200;
    await alerts!.close();
    start();
    await vi.waitFor(() => expect(hook.received).toHaveLength(1));
    expect(hook.received[0]!.text).toContain('also during it');
    expect(store.alertStatus().waiting).toBe(1);
  });

  it('says when delivery recovers', async () => {
    hook.state.status = 500;
    store.ingest(machine(), [], null, 'first');
    store.ingest(machine(), [], null, 'second');
    start(null, 20);
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    hook.state.status = 200;
    await vi.waitFor(() => expect(logs.at(-1)).toBe('alerts are getting through again'));
    expect(hook.received.map((entry) => entry.text.includes('first'))).toEqual([true, false]);
    expect(store.alertStatus()).toEqual({ waiting: 0, lastError: null });
  });

  it("doesn't follow redirects, and fails cleanly when the webhook is gone", async () => {
    hook.state.redirect = true;
    store.ingest(machine(), [], null, 'one');
    start();
    await vi.waitFor(() => expect(store.alertStatus().lastError).toContain("couldn't reach"));
    expect(store.alertStatus().lastError).not.toContain('SECRET');
  });

  it('alerts on silence only when asked', async () => {
    store.ingest(machine(), [], null, null, 1000);
    start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hook.received).toEqual([]);
    await alerts!.close();
    start(1);
    await vi.waitFor(() => expect(hook.received.map((entry) => entry.alert.kind)).toEqual(['silent']));
  });

  it('survives its own storage failing', async () => {
    const due = store.dueAlerts.bind(store);
    store.dueAlerts = () => {
      throw new Error('database is locked');
    };
    start();
    await vi.waitFor(() => expect(logs[0]).toContain("couldn't process alerts, will retry: database is locked"));
    store.dueAlerts = due;
  });

  it('closes while an alert is on its way, without counting it as failed', async () => {
    const stalled = createServer(() => {});
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    store.ingest(machine(), [], null, 'one');
    const running = startAlerts({ store, url: `http://127.0.0.1:${(stalled.address() as AddressInfo).port}/`, silentAfterMs: null, log: (message) => logs.push(message), pollMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await running.close();
    expect(store.dueAlerts()[0]!.attempts).toBe(0);
    expect(logs).toEqual([]);
    stalled.closeAllConnections();
    await new Promise<void>((resolve) => stalled.close(() => resolve()));
  });

  it('sends a test alert, and reports failure', async () => {
    await sendTestAlert(hook.url);
    expect(hook.received[0]).toMatchObject({ text: expect.stringContaining('test alert'), alert: { kind: 'test' } });
    hook.state.status = 404;
    await expect(sendTestAlert(hook.url)).rejects.toThrow(/answered 404/);
  });
});

describe('on the page', () => {
  const page = (alerts?: { waiting: number; lastError: string | null }) => renderPage({ machines: [], incidents: [], events: [], filter: {}, now: 0, silentAfterMs: 1, alerts });

  it('shows delivery only when a webhook is set up, and warns when it is failing', () => {
    expect(page()).not.toContain('alerts waiting');
    expect(page({ waiting: 0, lastError: null })).toContain('alerts waiting');
    expect(page({ waiting: 0, lastError: null })).not.toContain('getting through');
    const failing = page({ waiting: 2, lastError: 'hooks<x> answered 500' });
    expect(failing).toContain('stat warn');
    expect(failing).toContain("Alerts aren't getting through");
    expect(failing).toContain('hooks&lt;x&gt; answered 500');
  });

  it('the server passes the status on', async () => {
    const store = new CollectorStore(':memory:');
    store.enableAlerts();
    const collector = await startCollector({ store, port: 0, viewKey: 'k', showAlerts: true });
    const redirect = await fetch(`${collector.url}?key=k`, { redirect: 'manual' });
    const cookie = redirect.headers.get('set-cookie')!.split(';')[0]!;
    expect(await (await fetch(collector.url, { headers: { cookie } })).text()).toContain('alerts waiting');
    await collector.close();
    store.close();
  });
});

describe('the commands', () => {
  let dir: string;
  let hook: Awaited<ReturnType<typeof webhook>>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpspy-alerts-'));
    hook = await webhook();
  });
  afterEach(async () => {
    delete process.env.MCPSPY_COLLECT_WEBHOOK;
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = () => join(dir, 'c.db');

  it('test-alert needs a webhook, and reports what happened', async () => {
    expect((await cli(['collect', 'test-alert'])).stderr).toContain('set MCPSPY_COLLECT_WEBHOOK');
    process.env.MCPSPY_COLLECT_WEBHOOK = hook.url;
    const sent = await cli(['collect', 'test-alert']);
    expect([sent.code, sent.stdout]).toEqual([0, expect.stringContaining('Test alert sent')]);
    expect(hook.received).toHaveLength(1);
    hook.state.status = 500;
    const failed = await cli(['collect', 'test-alert']);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("didn't get through");
    expect(failed.stderr).not.toContain('SECRET');
  });

  it('refuses an unencrypted webhook elsewhere, without printing its address', async () => {
    process.env.MCPSPY_COLLECT_WEBHOOK = 'http://hooks.example/SECRET';
    const refused = await cli(['collect', 'test-alert']);
    expect(refused.stderr).toContain('--insecure-webhook');
    expect(refused.stderr).not.toContain('SECRET');
    expect((await cli(['collect', '--db', db()])).stderr).toContain('--insecure-webhook');
    expect((await cli(['collect', 'test-alert', '--insecure-webhook'])).stderr).toContain("didn't get through");
  });

  it('--alert-silent needs a webhook', async () => {
    expect((await cli(['collect', '--alert-silent', '--db', db()])).stderr).toContain('--alert-silent needs a webhook');
  });

  it('serving sends alerts until stopped', async () => {
    process.env.MCPSPY_COLLECT_WEBHOOK = hook.url;
    for (const flags of [[], ['--alert-silent']]) {
      const run = await cli(['collect', '--port', '0', ...flags, '--db', db()]);
      expect(run.stdout).toContain(flags.length ? 'incidents and silent machines' : 'alerts on incidents to 127.0.0.1');
      expect(run.stdout).not.toContain('SECRET');
      const stopped = new Promise<void>((resolve) => {
        vi.spyOn(process, 'exit').mockImplementationOnce((() => {
          resolve();
          return undefined as never;
        }) as typeof process.exit);
      });
      run.signals.get('SIGTERM')!();
      await stopped;
      vi.restoreAllMocks();
    }
  });
});
