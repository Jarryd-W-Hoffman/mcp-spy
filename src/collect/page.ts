import { eventData } from '../audit.js';
import type { CollectedEvent, Incident, MachineSummary } from './store.js';

export type MachineStatus = 'ok' | 'flagged' | 'silent' | 'waiting' | 'revoked';

/** The one word for how a machine stands; the worst thing that's true of it wins. */
export function machineStatus(machine: MachineSummary, now: number, silentAfterMs: number): MachineStatus {
  if (machine.incidents > 0) return 'flagged';
  if (machine.revoked_at !== null) return 'revoked';
  if (machine.last_seen === null) return 'waiting';
  return now - machine.last_seen > silentAfterMs ? 'silent' : 'ok';
}

export interface PageData {
  machines: MachineSummary[];
  incidents: Incident[];
  events: CollectedEvent[];
  filter: { machine?: string; denied?: boolean };
  now: number;
  silentAfterMs: number;
  /** Delivery of alerts, when a webhook is set up. */
  alerts?: { waiting: number; lastError: string | null };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Everything shown here came from a machine or an agent, so nothing goes in unescaped. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

const clock = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function ago(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

const badge = (tone: string, text: string) => `<span class="badge ${tone}">${escapeHtml(text)}</span>`;

const STATUS_TONES: Record<MachineStatus, string> = { ok: 'good', flagged: 'bad', silent: 'warn', waiting: 'muted', revoked: 'muted' };

/** What an event says, in a few words. A forged event can hold anything, so every field is optional. */
function eventSummary(event: CollectedEvent): string {
  const data = eventData(event);
  const name = escapeHtml(data.subject ?? data.method ?? '');
  const rule = data.rule ? ` <span class="dim">(${escapeHtml(data.rule)})</span>` : '';
  switch (event.type) {
    case 'session_start':
      return `${escapeHtml(data.user)}@${escapeHtml(data.host)} <span class="dim">${escapeHtml(data.command)}</span>`;
    case 'session_end':
      return data.exit_signal ? `signal ${escapeHtml(data.exit_signal)}` : data.exit_code === null ? 'ended' : `exit ${escapeHtml(data.exit_code)}`;
    case 'call':
      return `${name}${data.agent ? ` <span class="dim">${escapeHtml(data.agent)}</span>` : ''}`;
    case 'verdict': {
      const tone = data.decision === 'deny' ? 'bad' : data.decision === 'ask' ? 'warn' : 'good';
      return `${badge(tone, String(data.decision))} ${name}${rule}${data.reason ? `<span class="dim">: ${escapeHtml(data.reason)}</span>` : ''}`;
    }
    case 'approval':
      return `user answered ${escapeHtml(data.action)}`;
    case 'outcome':
      return `${name} ${badge(data.status === 'ok' ? 'good' : 'bad', String(data.status))}${rule}`;
    default:
      return '';
  }
}

function machineRow(machine: MachineSummary, data: PageData): string {
  const status = machineStatus(machine, data.now, data.silentAfterMs);
  const anchor = machine.head_hash ? `${machine.head_seq}:${machine.head_hash}` : '';
  return `<tr>
    <td><a href="?machine=${encodeURIComponent(machine.name)}">${escapeHtml(machine.name)}</a></td>
    <td>${badge(STATUS_TONES[status], status)}</td>
    <td class="num">${machine.head_seq}</td>
    <td class="num">${machine.denied}</td>
    <td class="num">${machine.open_sessions}</td>
    <td>${ago(machine.last_seen, data.now)}</td>
    <td class="hash" title="${escapeHtml(anchor)}">${anchor ? `${machine.head_seq}:${escapeHtml(machine.head_hash!.slice(0, 12))}…` : ''}</td>
  </tr>`;
}

function incidentRow(incident: Incident, now: number): string {
  return `<tr>
    <td>${escapeHtml(incident.machine)}</td>
    <td>${badge('bad', incident.kind)}</td>
    <td class="num">${incident.seq}</td>
    <td class="wrap">${escapeHtml(incident.detail)}</td>
    <td class="num">${incident.count}</td>
    <td>${ago(incident.last_seen, now)}</td>
  </tr>`;
}

function eventRow(event: CollectedEvent): string {
  return `<tr>
    <td class="dim" title="Received ${clock(event.received_at)} UTC">${clock(event.ts)}</td>
    <td>${escapeHtml(event.machine)}</td>
    <td class="num dim">${event.seq}</td>
    <td>${escapeHtml(event.type)}</td>
    <td class="wrap">${eventSummary(event)}</td>
  </tr>`;
}

function table(headings: string[], rows: string[], empty: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<div class="scroll"><table><thead><tr>${headings.map((heading) => (heading.startsWith('#') ? `<th class="num">${heading.slice(1)}</th>` : `<th>${heading}</th>`)).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function stat(value: number, label: string, tone = ''): string {
  return `<div class="stat ${tone}"><b>${value}</b><span>${escapeHtml(label)}</span></div>`;
}

/** The whole view as one page: no scripts, so a strict policy can forbid them outright. */
export function renderPage(data: PageData): string {
  const { machine, denied } = data.filter;
  const statuses = data.machines.map((entry) => machineStatus(entry, data.now, data.silentAfterMs));
  const count = (status: MachineStatus) => statuses.filter((entry) => entry === status).length;
  const scope = `${machine ? ` on ${escapeHtml(machine)}` : ''}`;
  const clearable = machine || denied ? ' <a href="?">show all</a>' : '';
  const deniedLink = `?${machine ? `machine=${encodeURIComponent(machine)}&amp;` : ''}denied=1`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>mcpspy collector</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f9; --panel: #fff; --line: #e2e2e8; --text: #1c1c24; --dim: #6b6b7b; --accent: #6a5ae0;
  --good: #1b8a4b; --good-bg: #e3f4ea; --warn: #a8650a; --warn-bg: #fbf0dc; --bad: #c4322f; --bad-bg: #fbe8e7; --muted-bg: #ececf1; }
@media (prefers-color-scheme: dark) { :root { --bg: #111116; --panel: #18181f; --line: #2c2c38; --text: #e6e6ee; --dim: #8d8d9e; --accent: #9b8ff5;
  --good: #75e0a7; --good-bg: #0b3a26; --warn: #fdb022; --warn-bg: #43300a; --bad: #fda29b; --bad-bg: #4a1512; --muted-bg: #2c2c38; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px clamp(16px, 3vw, 32px) 48px; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 20px; margin: 0; } h2 { font-size: 15px; margin: 28px 0 10px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.dim { color: var(--dim); }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px; min-width: 112px; }
.stat b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; } .stat span { color: var(--dim); font-size: 12px; }
.stat.bad b { color: var(--bad); } .stat.warn b { color: var(--warn); }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-size: 12px; font-weight: 600; color: var(--dim); background: var(--panel); }
th, td { padding: 7px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.wrap { white-space: normal; overflow-wrap: anywhere; min-width: 280px; }
th.num, .num { text-align: right; font-variant-numeric: tabular-nums; }
.hash { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dim); }
.badge { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--muted-bg); color: var(--dim); }
.badge.good { background: var(--good-bg); color: var(--good); } .badge.warn { background: var(--warn-bg); color: var(--warn); } .badge.bad { background: var(--bad-bg); color: var(--bad); }
.problem { margin: 14px 0 0; padding: 10px 14px; border-radius: 8px; background: var(--warn-bg); color: var(--warn); }
.empty { background: var(--panel); border: 1px dashed var(--line); border-radius: 8px; padding: 16px; color: var(--dim); margin: 0; }
</style>
</head>
<body>
<h1>mcpspy collector</h1>
<div class="dim">Audit trails from every machine, as first received. Times are UTC, as each machine reported them.</div>
<div class="stats">
  ${stat(data.machines.length, 'machines')}
  ${stat(count('flagged'), 'flagged', count('flagged') > 0 ? 'bad' : '')}
  ${stat(count('silent'), 'silent', count('silent') > 0 ? 'warn' : '')}
  ${stat(data.machines.reduce((sum, entry) => sum + entry.denied, 0), 'calls denied')}
  ${data.alerts ? stat(data.alerts.waiting, 'alerts waiting', data.alerts.waiting > 0 ? 'warn' : '') : ''}
</div>
${data.alerts?.lastError ? `<p class="problem"><b>Alerts aren't getting through:</b> ${escapeHtml(data.alerts.lastError)}. They'll keep retrying, and nothing is lost in the meantime. Check the webhook with <code>mcpspy collect test-alert</code>.</p>` : ''}
<h2>Machines</h2>
${table(['Machine', 'Status', '#Events', '#Denied', '#Open sessions', 'Last seen', 'Anchor'], data.machines.map((entry) => machineRow(entry, data)), 'No machines yet. Add one with: mcpspy collect add <name>')}
<h2>Incidents</h2>
${table(['Machine', 'Kind', '#Event', 'What the collector found', '#Times', 'Last seen'], data.incidents.map((incident) => incidentRow(incident, data.now)), 'None: every chain lines up with what the collector holds.')}
<h2>${denied ? 'Denied calls' : 'Latest events'}${scope}${clearable}${denied ? '' : ` <small><a href="${deniedLink}">denied only</a></small>`}</h2>
${table(['Time', 'Machine', '#Event', 'Type', 'Details'], data.events.map(eventRow), 'Nothing here yet.')}
</body>
</html>
`;
}
