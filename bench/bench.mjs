// Benchmarks the notes server directly and through mcpspy, over stdio and Streamable HTTP.
// Linux only (it reads mcpspy's memory and CPU time from /proc). Run npm run build first.
//   npm run bench
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const cli = process.argv[2] ?? join(import.meta.dirname, '..', 'dist', 'bin.js');
const dir = mkdtemp();
function mkdtemp() {
  return mkdtempSync(join(tmpdir(), 'mcpspy-bench-'));
}
const server = join(import.meta.dirname, 'notes-server.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Peak resident memory (MB) and CPU time used so far (ms) of a process, from /proc. */
function usage(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const peakKb = Number(/VmHWM:\s+(\d+)/.exec(status)[1]);
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return { peakMb: peakKb / 1024, cpuMs: (Number(stat[11]) + Number(stat[12])) * 10 };
}

/** The log's size on disk, including its write-ahead log. */
function logMb(db) {
  const wal = statSync(`${db}-wal`, { throwIfNoEntry: false })?.size ?? 0;
  return (statSync(db).size + wal) / 1024 / 1024;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function workloads(client) {
  const results = {};
  const ping = () => client.callTool({ name: 'ping', arguments: {} });
  for (let i = 0; i < 300; i++) await ping(); // warm up

  const times = [];
  const start = performance.now();
  for (let i = 0; i < 3000; i++) {
    const t = performance.now();
    await ping();
    times.push(performance.now() - t);
  }
  const elapsed = performance.now() - start;
  times.sort((a, b) => a - b);
  results.sequential = { p50: percentile(times, 50), p95: percentile(times, 95), p99: percentile(times, 99), perSecond: 3000 / (elapsed / 1000) };

  const concurrentStart = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: 64 }, async () => { while (next++ < 5000) await ping(); }));
  results.concurrent = 5000 / ((performance.now() - concurrentStart) / 1000);

  results.payload = {};
  for (const [kb, count] of [[100, 50], [1024, 20], [5120, 5]]) {
    const t = performance.now();
    for (let i = 0; i < count; i++) await client.callTool({ name: 'report', arguments: { kb } });
    results.payload[kb] = (performance.now() - t) / count;
  }
  return results;
}

async function stdio(viaMcpspy) {
  const db = join(dir, 'bench-stdio.db');
  rmSync(db, { force: true }); rmSync(`${db}-wal`, { force: true }); rmSync(`${db}-shm`, { force: true });
  const transport = new StdioClientTransport(
    viaMcpspy
      ? { command: 'node', args: [cli, 'run', '--db', db, '--name', 'bench', '--', 'node', server, 'stdio'], stderr: 'ignore' }
      : { command: 'node', args: [server, 'stdio'], stderr: 'ignore' },
  );
  const client = new Client({ name: 'bench', version: '1' });
  await client.connect(transport);
  const results = await workloads(client);
  if (viaMcpspy) results.mcpspy = usage(transport.pid);
  await client.close();
  if (viaMcpspy) {
    await sleep(300);
    results.logMb = logMb(db);
  }
  return results;
}

async function http(viaMcpspy) {
  const db = join(dir, 'bench-http.db');
  rmSync(db, { force: true }); rmSync(`${db}-wal`, { force: true }); rmSync(`${db}-shm`, { force: true });
  const upstream = spawn('node', [server, 'http', '7910'], { stdio: 'ignore' });
  await sleep(700);
  const proxy = viaMcpspy ? spawn('node', [cli, 'proxy', 'http://127.0.0.1:7910/mcp', '--port', '7911', '--db', db, '--name', 'bench'], { stdio: 'ignore' }) : null;
  if (proxy) await sleep(800);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${viaMcpspy ? 7911 : 7910}/mcp`));
  const client = new Client({ name: 'bench', version: '1' });
  await client.connect(transport);
  const results = await workloads(client);
  if (proxy) results.mcpspy = usage(proxy.pid);
  await transport.terminateSession();
  await client.close();
  proxy?.kill();
  upstream.kill();
  await sleep(300);
  if (viaMcpspy) results.logMb = logMb(db);
  return results;
}

const all = {};
for (const [name, run] of [['stdio direct', () => stdio(false)], ['stdio mcpspy', () => stdio(true)], ['http direct', () => http(false)], ['http mcpspy', () => http(true)]]) {
  process.stderr.write(`running: ${name}\n`);
  all[name] = await run();
}
rmSync(dir, { recursive: true, force: true });

const ms = (n) => `${n.toFixed(2)} ms`;
console.log(`\n${cpus().length} × ${cpus()[0].model.trim()}, Node ${process.version}\n`);
console.log('| | p50 | p95 | p99 | calls/s, one at a time | calls/s, 64 at once | 100 KB result | 1 MB result | 5 MB result |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [name, r] of Object.entries(all)) {
  const { sequential: s, payload: p } = r;
  console.log(`| ${name} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${Math.round(s.perSecond)} | ${Math.round(r.concurrent)} | ${p[100].toFixed(1)} ms | ${p[1024].toFixed(1)} ms | ${Math.round(p[5120])} ms |`);
}
for (const [name, r] of Object.entries(all)) {
  if (r.mcpspy) console.log(`\n${name}: mcpspy peaked at ${r.mcpspy.peakMb.toFixed(0)} MB and used ${(r.mcpspy.cpuMs / 1000).toFixed(1)} s of CPU; the log grew to ${r.logMb.toFixed(1)} MB`);
}
if (process.env.BENCH_JSON) console.log(JSON.stringify(all));
