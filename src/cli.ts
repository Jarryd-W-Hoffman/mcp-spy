#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { comparableBody, diffLines, hunks, jsonLines } from './diff.js';
import {
  errorSummary,
  formatBytes,
  formatClock,
  formatDuration,
  formatMessageLine,
  prettyPayload,
  requestSubject,
  styleFor,
  type Style,
} from './format.js';
import { MockEngine, parseMockFile, rulesFromRecording, type MockFile, type MockTool } from './mocks.js';
import { startHttpProxy, type HttpProxy } from './proxy/http.js';
import { runMockServer } from './proxy/mock-server.js';
import { runStdioProxy } from './proxy/stdio.js';
import { calledTool } from './validate.js';
import { backfillTokens, backfillValidation } from './recorder.js';
import { replay, ReplayError, withArguments, type ReplayResult } from './replay.js';
import { toolsReport } from './report.js';
import { isLoopbackHost, startUiServer } from './server.js';
import { addCases, emptySuite, parseSuite, runSuite, updateExpectations, type Suite } from './suite.js';
import { formatTokens } from './tokens.js';
import { defaultDbPath, Store, type MessageRow, type SessionRow } from './store.js';
import type { Issue } from './types.js';

const HELP = `mcpspy - see what your AI agent and its MCP servers say to each other

Usage:
  mcpspy run [--name <label>] [--mocks <file>] [--db <path>] -- <command> [args...]
  mcpspy -- <command> [args...]            shorthand for run
  mcpspy proxy <url> [--port <7800>] [--name <label>] [--mocks <file>]
                                           proxy an MCP server over HTTP (Streamable HTTP or SSE)
  mcpspy tail [-f] [-n <count>] [--session <id>] [--json] [--db <path>]
  mcpspy sessions [--limit <n>] [--db <path>]
  mcpspy show <message-id> [--db <path>]
  mcpspy ui [--port <7777>] [--open] [--read-only] [--db <path>]
  mcpspy tokens [--session <id>] [--exact] [--model <id>] [--db <path>]
  mcpspy diff <message-id> <message-id> [--db <path>]
  mcpspy replay <message-id> [--args <json> | --params <json>] [--repeat <n>] [-e KEY=VALUE]... [-H 'Name: value']... [--json]
  mcpspy suite add <file> <message-id>... [--name <case name>]
  mcpspy suite run <file> [--update] [--only <text>] [-H 'Name: value']... [--json]
  mcpspy validate [--session <id>] [--db <path>]
  mcpspy mock serve <file> [--name <label>]  a fake MCP server driven by mock rules
  mcpspy mock add <file> <message-id>...     turn recorded calls into mock rules

Wrap a stdio MCP server by putting mcpspy in front of its command in your
agent's MCP config, e.g. in .mcp.json:

  "command": "mcpspy",
  "args": ["run", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"]

For a server reached over HTTP, start mcpspy proxy <url> and give your agent
the local URL it prints instead of the server's.

Then watch the traffic with: mcpspy ui --open (or mcpspy tail -f in a terminal)

The log is a SQLite database at ${defaultDbPath()} (override with --db or MCPSPY_DB).`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function fail(message: string): never {
  process.stderr.write(`mcpspy: ${message}\n`);
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;

  switch (first) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(`${HELP}\n`);
      return;
    case '-v':
    case '--version':
      process.stdout.write(`${version()}\n`);
      return;
    case '--':
      return run(argv);
    case 'run':
      return run(rest);
    case 'tail':
      return tail(rest);
    case 'sessions':
      return sessions(rest);
    case 'show':
      return show(rest);
    case 'ui':
      return ui(rest);
    case 'tokens':
      return tokens(rest);
    case 'diff':
      return diff(rest);
    case 'replay':
      return replayCommand(rest);
    case 'suite':
      return suiteCommand(rest);
    case 'validate':
      return validate(rest);
    case 'mock':
      return mockCommand(rest);
    case 'proxy':
      return proxyCommand(rest);
    default:
      fail(`unknown command "${first}". Run mcpspy --help.`);
  }
}

async function run(argv: string[]): Promise<void> {
  const separator = argv.indexOf('--');
  if (separator === -1 || separator === argv.length - 1) fail('run needs a server command after "--"');

  const { values } = parseArgs({
    args: argv.slice(0, separator),
    options: { name: { type: 'string' }, mocks: { type: 'string' }, db: { type: 'string' } },
  });
  const [command, ...args] = argv.slice(separator + 1) as [string, ...string[]];

  const mocks = values.mocks !== undefined ? loadMocks(values.mocks, values.name ?? null) : undefined;
  const store = new Store(values.db);
  const { exitCode } = await runStdioProxy({ command, args, store, name: values.name ?? null, mocks });
  store.close();

  // stdin may still be open (the agent closed nothing); don't let it hold us up.
  process.stdin.destroy();
  process.exitCode = exitCode;
}

async function proxyCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '7800' },
      host: { type: 'string', default: '127.0.0.1' },
      name: { type: 'string' },
      mocks: { type: 'string' },
      db: { type: 'string' },
    },
  });
  if (positionals.length !== 1) fail('proxy needs the server URL, e.g. mcpspy proxy https://mcp.example.com/mcp');
  const port = Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a port number');
  if (!isLoopbackHost(values.host)) fail('--host must be a loopback address; recorded traffic can contain secrets');

  const mocks = values.mocks !== undefined ? loadMocks(values.mocks, values.name ?? null) : undefined;
  const store = new Store(values.db);
  let proxy: HttpProxy;
  try {
    proxy = await startHttpProxy({ upstream: positionals[0]!, store, name: values.name ?? null, host: values.host, port, mocks });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    fail(code === 'EADDRINUSE' ? `port ${port} is in use; pick another with --port` : (error as Error).message);
  }
  const style = styleFor(process.stderr);
  process.stderr.write(`mcpspy proxying ${positionals[0]}\nPoint your agent at ${style.cyan(proxy.url)}\n`);

  const stop = () => {
    void proxy.close().then(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function loadMocks(path: string, serverName: string | null): MockEngine {
  try {
    return new MockEngine(resolve(path), serverName, (message) => process.stderr.write(`[mcpspy] ${message}\n`));
  } catch (error) {
    fail((error as Error).message);
  }
}

async function mockCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === 'serve') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: 'string' }, db: { type: 'string' } } });
    if (positionals.length !== 1) fail('mock serve needs a mock file');
    const path = resolve(positionals[0]!);
    const mocks = loadMocks(path, values.name ?? null);
    const store = new Store(values.db);
    await runMockServer({ mocks, path, store, name: values.name ?? null });
    store.close();
    return;
  }
  if (sub === 'add') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { db: { type: 'string' } } });
    const [file, ...ids] = positionals;
    if (!file || ids.length === 0) fail('mock add needs a mock file and at least one message id');
    const existing: MockFile = existsSync(file) ? parseMockFileOrFail(file) : { tools: [], rules: [] };
    const tools = existing.tools ?? [];
    const rules = existing.rules ?? [];

    const store = new Store(values.db);
    for (const raw of ids) {
      const picked = store.getMessage(parseId(raw, 'message id'));
      if (!picked) fail(`no message #${raw}`);
      const request = picked.direction === 'server' && picked.request_id !== null ? store.getMessage(picked.request_id) : picked;
      if (!request || request.direction !== 'client' || request.kind !== 'request' || request.method === null) {
        fail(`#${raw} is not a client request or a response to one`);
      }
      const response = store.responseTo(request.id);
      const toolName = request.method === 'tools/call' ? calledTool(request.payload) : null;
      const definition = toolName !== null ? recordedTool(store, request.session_id, toolName) : undefined;
      const { rule, tool } = rulesFromRecording({ id: request.id, method: request.method, payload: request.payload }, response, definition);
      rules.push(rule);
      if (tool && !tools.some((known) => known.name === tool.name)) tools.push(tool);
      process.stdout.write(`added rule "${rule.name}"\n`);
    }
    store.close();
    writeFileSync(file, `${JSON.stringify({ ...existing, tools, rules }, null, 2)}\n`);
    process.stdout.write(`wrote ${file}\n`);
    return;
  }
  fail('usage: mcpspy mock serve <file> | mcpspy mock add <file> <message-id>...');
}

function parseMockFileOrFail(path: string): MockFile {
  try {
    return parseMockFile(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path}: ${(error as Error).message}`);
  }
}

/** The definition of a tool from the latest tools/list in a session. */
function recordedTool(store: Store, sessionId: number, name: string): MockTool | undefined {
  const list = store.latestReply(sessionId, 'tools/list');
  if (!list) return undefined;
  const tools = (JSON.parse(list.payload) as { result?: { tools?: MockTool[] } }).result?.tools ?? [];
  return tools.find((tool) => tool.name === name);
}

async function tail(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      follow: { type: 'boolean', short: 'f' },
      lines: { type: 'string', short: 'n', default: '50' },
      session: { type: 'string' },
      json: { type: 'boolean' },
      db: { type: 'string' },
    },
  });
  const count = Number.parseInt(values.lines, 10);
  if (!Number.isFinite(count) || count < 0) fail('-n must be a non-negative number');
  const sessionId = values.session !== undefined ? parseId(values.session, '--session') : undefined;

  const store = new Store(values.db);
  backfillValidation(store);
  const style = styleFor(process.stdout);
  const sessionCache = new Map<number, SessionRow | undefined>();
  const subjectCache = new Map<number, string | null>();

  const sessionFor = (id: number) => {
    if (!sessionCache.has(id)) sessionCache.set(id, store.getSession(id));
    return sessionCache.get(id);
  };
  const subjectFor = (message: MessageRow): string | null => {
    if (message.kind === 'request' || message.kind === 'notification') {
      const subject = requestSubject(message.method, message.payload);
      subjectCache.set(message.id, subject);
      return subject;
    }
    if (message.request_id === null) return null;
    if (!subjectCache.has(message.request_id)) {
      const request = store.getMessage(message.request_id);
      subjectCache.set(message.request_id, request ? requestSubject(request.method, request.payload) : null);
    }
    return subjectCache.get(message.request_id) ?? null;
  };

  let lastId = store.idBeforeLast(count, sessionId);
  const drain = () => {
    for (;;) {
      const batch = store.messagesAfter(lastId, { sessionId });
      for (const message of batch) {
        const line = values.json
          ? JSON.stringify(message)
          : formatMessageLine(message, sessionFor(message.session_id), subjectFor(message), style);
        process.stdout.write(`${line}\n`);
        lastId = message.id;
      }
      if (batch.length < 500) return;
    }
  };

  drain();
  if (!values.follow) {
    store.close();
    return;
  }

  // New sessions start while we follow; forget cached misses so they get names.
  const timer = setInterval(() => {
    for (const [id, session] of sessionCache) if (!session) sessionCache.delete(id);
    drain();
  }, 200);
  process.once('SIGINT', () => {
    clearInterval(timer);
    store.close();
  });
}

function sessions(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: 'string', default: '20' }, db: { type: 'string' } },
  });
  const store = new Store(values.db);
  const style = styleFor(process.stdout);
  const rows = store.listSessions(parseId(values.limit, '--limit'));
  store.close();

  if (rows.length === 0) {
    process.stdout.write('No sessions recorded yet. Wrap a server with: mcpspy run -- <command>\n');
    return;
  }

  for (const session of rows.reverse()) {
    const started = `${new Date(session.started_at).toISOString().slice(0, 10)} ${formatClock(session.started_at)}`;
    const status =
      session.ended_at === null
        ? style.green('running')
        : session.exit_signal
          ? style.yellow(`killed ${session.exit_signal}`)
          : session.exit_code === null
            ? style.dim('closed')
            : session.exit_code === 0
              ? style.dim(`exit 0`)
              : style.red(`exit ${session.exit_code}`);
    const duration = session.ended_at !== null ? style.dim(formatDuration(session.ended_at - session.started_at)) : '';
    const command = (JSON.parse(session.command) as string[]).join(' ');
    process.stdout.write(
      [
        style.dim(`#${session.id}`.padEnd(5)),
        style.cyan((session.name ?? '-').padEnd(12)),
        started,
        status,
        duration,
        `${session.message_count} msgs`,
        style.dim(command),
      ]
        .filter(Boolean)
        .join('  ') + '\n',
    );
  }
}

function show(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { db: { type: 'string' } } });
  if (positionals.length !== 1) fail('show takes exactly one message id');

  const store = new Store(values.db);
  const style = styleFor(process.stdout);
  const message = store.getMessage(parseId(positionals[0]!, 'message id'));
  if (!message) {
    store.close();
    fail(`no message with id ${positionals[0]}`);
  }

  // Show the request and its response together, whichever was asked for.
  const request = message.request_id !== null ? store.getMessage(message.request_id) : message.kind === 'request' ? message : undefined;
  const response =
    message.kind === 'request'
      ? store.responseTo(message.id)
      : message.request_id !== null
        ? message
        : undefined;
  const session = store.getSession(message.session_id);
  store.close();

  const header = (row: MessageRow) =>
    style.dim(
      `#${row.id}  ${row.direction}  ${row.kind}  ${formatClock(row.ts)}  ${formatBytes(row.size)}` +
        (row.latency_ms !== null ? `  ${formatDuration(row.latency_ms)}` : ''),
    );

  process.stdout.write(`${style.cyan(session?.name ?? `session #${message.session_id}`)}\n\n`);
  const parts = request || response ? [request, response].filter((row): row is MessageRow => row !== undefined) : [message];
  for (const row of parts) {
    process.stdout.write(`${header(row)}\n${prettyPayload(row.payload)}\n\n`);
  }
  if (request && !response) process.stdout.write(`${style.yellow('No response recorded.')}\n`);
}

const DEFAULT_MODEL = 'claude-opus-5-5';

async function tokens(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      exact: { type: 'boolean' },
      model: { type: 'string', default: DEFAULT_MODEL },
      db: { type: 'string' },
    },
  });
  const store = new Store(values.db);
  const style = styleFor(process.stdout);
  backfillTokens(store);

  const sessionId = values.session !== undefined ? parseId(values.session, '--session') : store.listSessions(1)[0]?.id;
  const session = sessionId !== undefined ? store.getSession(sessionId) : undefined;
  if (!session) {
    store.close();
    fail(sessionId === undefined ? 'no sessions recorded yet' : `no session with id ${sessionId}`);
  }

  const report = toolsReport(store, session.id);
  const out = (line = '') => process.stdout.write(`${line}\n`);
  const label = `${session.name ?? (JSON.parse(session.command) as string[]).join(' ')} #${session.id}`;
  const kind = values.exact ? `exact, ${values.model}` : 'estimate';

  // Exact counts replace the estimates where we have them.
  let definitionCosts = report.definitions?.tools ?? [];
  let definitionTotal = report.definitions?.total ?? 0;
  let overhead: number | null = null;
  const exactResults = new Map<string, number>();

  if (values.exact) {
    process.stderr.write(style.dim(`Counting with the count_tokens API (${values.model}); this sends tool definitions and results to Anthropic.\n`));
    // Loaded on demand: only --exact needs the SDK.
    const { describeApiError, ExactCounter } = await import('./exact.js');
    try {
      const counter = new ExactCounter(values.model);
      if (report.definitions) {
        const cached = store.exactCount(report.definitions.messageId, values.model);
        const exact = cached
          ? (JSON.parse(cached.detail!) as Awaited<ReturnType<InstanceType<typeof ExactCounter>['toolDefinitions']>>)
          : await counter.toolDefinitions(
              (JSON.parse(store.getMessage(report.definitions.messageId)!.payload) as { result: { tools: unknown[] } }).result.tools,
            );
        if (!cached) {
          store.saveExactCount({ message_id: report.definitions.messageId, model: values.model, tokens: exact.total, detail: JSON.stringify(exact) });
        }
        definitionCosts = exact.tools;
        definitionTotal = exact.total;
        overhead = exact.overhead;
      }
      // The largest result of each tool.
      const largest = new Map<string, MessageRow & { request_payload: string | null }>();
      for (const call of store.toolCalls(session.id)) {
        const name = (call.request_payload && requestSubject('tools/call', call.request_payload)) ?? '(unknown)';
        if ((call.tokens ?? 0) > (largest.get(name)?.tokens ?? -1)) largest.set(name, call);
      }
      for (const [name, call] of largest) {
        const cached = store.exactCount(call.id, values.model);
        let count = cached?.tokens;
        if (count === undefined) {
          const parsed = JSON.parse(call.payload) as { result?: { content?: unknown[]; isError?: boolean }; error?: { message?: string } };
          const content = parsed.result?.content ?? [{ type: 'text', text: parsed.error?.message ?? '' }];
          count = await counter.toolResult(name, content, parsed.result?.isError === true || parsed.error !== undefined);
          store.saveExactCount({ message_id: call.id, model: values.model, tokens: count, detail: null });
        }
        exactResults.set(name, count);
      }
    } catch (error) {
      store.close();
      fail(`exact count failed: ${describeApiError(error)}`);
    }
  }
  store.close();

  out(`${style.cyan(label)}  ${style.dim(`token counts are ${kind}`)}`);
  out();

  if (report.definitions) {
    const sorted = [...definitionCosts].sort((a, b) => b.tokens - a.tokens);
    out(
      `Tool definitions: ${style.yellow(`${values.exact ? '' : '≈'}${formatTokens(definitionTotal)} tokens`)} across ${sorted.length} tools, sent with every model request` +
        (overhead !== null ? style.dim(` (includes ${formatTokens(overhead)} of tool-use preamble)`) : ''),
    );
    const widest = Math.max(1, ...sorted.map((tool) => tool.tokens));
    for (const tool of sorted) {
      const bar = '█'.repeat(Math.max(1, Math.round((tool.tokens / widest) * 24)));
      out(`  ${formatTokens(tool.tokens).padStart(6)}  ${style.magenta(bar.padEnd(24))}  ${tool.name}`);
    }
  } else {
    out(style.dim('No tools/list recorded in this session.'));
  }

  if (report.calls.length > 0) {
    out();
    out('Tool calls');
    out(style.dim(`  ${'tool'.padEnd(28)} ${'calls'.padStart(5)} ${'errors'.padStart(6)} ${'avg'.padStart(8)} ${'max'.padStart(8)}  ${'result tokens: total / largest'}`));
    for (const stats of report.calls) {
      const exact = exactResults.get(stats.name);
      const errors = String(stats.errors).padStart(6);
      out(
        `  ${stats.name.padEnd(28)} ${String(stats.calls).padStart(5)} ${stats.errors ? style.red(errors) : errors} ` +
          `${(stats.avgLatency !== null ? formatDuration(stats.avgLatency) : '-').padStart(8)} ${(stats.maxLatency !== null ? formatDuration(stats.maxLatency) : '-').padStart(8)}  ` +
          `≈${formatTokens(stats.totalTokens)} / ${exact !== undefined ? `${formatTokens(exact)} exact` : `≈${formatTokens(stats.maxTokens)}`}`,
      );
    }
  }

  if (report.changes) {
    out();
    if (report.changes.length === 0) {
      out(style.dim(`Tool list unchanged since session #${report.previousSessionId}.`));
    } else {
      out(`Tool list changes since session #${report.previousSessionId}`);
      for (const change of report.changes) {
        const delta = change.tokenDelta === 0 ? '' : style.dim(` (${change.tokenDelta > 0 ? '+' : ''}${change.tokenDelta} tok)`);
        const marker = change.change === 'added' ? style.green('+') : change.change === 'removed' ? style.red('-') : style.yellow('~');
        out(`  ${marker} ${change.name}${change.fields.length ? style.dim(`: ${change.fields.join(', ')}`) : ''}${delta}`);
      }
    }
  }
}

function diff(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { db: { type: 'string' } } });
  if (positionals.length !== 2) fail('diff takes two message ids');

  const store = new Store(values.db);
  const style = styleFor(process.stdout);
  const [before, after] = positionals.map((value) => {
    const message = store.getMessage(parseId(value, 'message id'));
    if (!message) {
      store.close();
      fail(`no message with id ${value}`);
    }
    return message;
  }) as [MessageRow, MessageRow];

  // Two requests: compare their arguments and their responses.
  const pairs: [string, MessageRow | undefined, MessageRow | undefined][] =
    before.kind === 'request' && after.kind === 'request'
      ? [
          ['request', before, after],
          ['response', store.responseTo(before.id), store.responseTo(after.id)],
        ]
      : [['message', before, after]];
  store.close();

  for (const [title, a, b] of pairs) {
    process.stdout.write(`${style.cyan(`${title}: #${a?.id ?? '-'} → #${b?.id ?? '-'}`)}\n`);
    if (!a || !b) {
      process.stdout.write(style.dim('  missing on one side\n\n'));
      continue;
    }
    printDiff(comparableBody(a.payload), comparableBody(b.payload), style);
    process.stdout.write('\n');
  }
}

/** Prints a unified diff of two JSON values; returns whether they differ. */
function printDiff(before: unknown, after: unknown, style: Style): boolean {
  const groups = hunks(diffLines(jsonLines(before), jsonLines(after)));
  if (groups.length === 0) {
    process.stdout.write(style.dim('  identical\n'));
    return false;
  }
  for (const group of groups) {
    process.stdout.write(style.dim(`@@ -${group.beforeStart} +${group.afterStart} @@\n`));
    for (const op of group.ops) {
      const line = op.type === 'insert' ? style.green(`+${op.text}`) : op.type === 'delete' ? style.red(`-${op.text}`) : ` ${op.text}`;
      process.stdout.write(`${line}\n`);
    }
  }
  return true;
}

async function replayCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      args: { type: 'string' },
      params: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      env: { type: 'string', multiple: true, short: 'e' },
      header: { type: 'string', multiple: true, short: 'H' },
      timeout: { type: 'string', default: '30000' },
      json: { type: 'boolean' },
      db: { type: 'string' },
    },
  });
  if (positionals.length !== 1) fail('replay takes one message id (a request from the agent)');
  if (values.args !== undefined && values.params !== undefined) fail('use either --args or --params, not both');
  const repeat = parseId(values.repeat, '--repeat');
  if (repeat < 1) fail('--repeat must be at least 1');

  const env: Record<string, string> = {};
  for (const pair of values.env ?? []) {
    const index = pair.indexOf('=');
    if (index <= 0) fail(`--env expects KEY=VALUE, got "${pair}"`);
    env[pair.slice(0, index)] = pair.slice(index + 1);
  }
  const headers = parseHeaders(values.header);
  const parseJson = (text: string, flag: string): unknown => {
    try {
      return JSON.parse(text);
    } catch (error) {
      fail(`${flag} is not valid JSON: ${(error as Error).message}`);
    }
  };

  const store = new Store(values.db);
  const style = styleFor(process.stdout);
  const messageId = parseId(positionals[0]!, 'message id');
  const request = store.getMessage(messageId);
  let params: unknown;
  if (values.params !== undefined) params = parseJson(values.params, '--params');
  if (values.args !== undefined && request) params = withArguments(request, parseJson(values.args, '--args'));

  let result: ReplayResult;
  try {
    result = await replay({ store, messageId, params, repeat, env, headers, timeoutMs: parseId(values.timeout, '--timeout') });
  } catch (error) {
    store.close();
    if (error instanceof ReplayError) {
      const recorded = error.sessionId !== null ? ` (recorded as session #${error.sessionId})` : '';
      process.stderr.write(`mcpspy: replay failed${recorded}: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const original = result.original.responseId !== null ? store.getMessage(result.original.responseId) : undefined;
  const session = store.getSession(store.getMessage(messageId)!.session_id)!;
  store.close();

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const subject = request ? requestSubject(request.method, request.payload) : null;
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out(
    `Replayed ${[result.original.method, subject].filter(Boolean).join(' ')} ${style.dim(`(#${messageId} from ${session.name ?? 'session'} #${session.id})`)} → session #${result.sessionId}`,
  );
  out(style.dim(`  startup ${formatDuration(result.startupMs)} (spawn + initialize)`));
  for (const [index, run] of result.runs.entries()) {
    const failure = errorSummary({ payload: JSON.stringify(run.response) } as MessageRow);
    out(`  run ${index + 1}  ${failure ? style.red(`✗ ${failure}`) : style.green('✓')} ${formatDuration(run.latencyMs)}  ${style.dim(`#${run.responseId}`)}`);
  }
  if (result.runs.length > 2) {
    const sorted = result.runs.map((run) => run.latencyMs).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    out(style.dim(`  latency min ${formatDuration(sorted[0]!)} · median ${formatDuration(median)} · max ${formatDuration(sorted.at(-1)!)}`));
  }
  if (result.missingEnv.length > 0) {
    out(style.yellow(`  The original server had ${result.missingEnv.join(', ')} set, which isn't set now. Pass --env NAME=value or export it.`));
  }

  const last = result.runs.at(-1)!;
  out();
  if (original) {
    out(`Response vs original #${original.id}:`);
    printDiff(comparableBody(original.payload), comparableBody(JSON.stringify(last.response)), style);
  } else {
    out('Response (the original had none):');
    out(prettyPayload(JSON.stringify(last.response)));
  }
}

/** -H "Name: value" flags, for servers reached over HTTP. */
function parseHeaders(lines: string[] = []): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index <= 0) fail(`--header expects "Name: value", got "${line}"`);
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

async function suiteCommand(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      update: { type: 'boolean' },
      only: { type: 'string' },
      header: { type: 'string', multiple: true, short: 'H' },
      timeout: { type: 'string', default: '30000' },
      json: { type: 'boolean' },
      db: { type: 'string' },
    },
  });
  const [file, ...ids] = positionals;
  if (!file || (action !== 'add' && action !== 'run')) {
    fail('usage: mcpspy suite add <file> <message-id>... [--name <case name>] | mcpspy suite run <file> [--update] [--only <text>]');
  }
  const style = styleFor(process.stdout);
  const out = (line = '') => process.stdout.write(`${line}\n`);
  const load = (): Suite => {
    if (!existsSync(file)) return emptySuite();
    try {
      return parseSuite(readFileSync(file, 'utf8'));
    } catch (error) {
      fail(`${file}: ${(error as Error).message}`);
    }
  };
  const save = (suite: Suite) => writeFileSync(file, `${JSON.stringify(suite, null, 2)}\n`);

  if (action === 'add') {
    if (ids.length === 0) fail('suite add needs at least one message id (a request from the agent)');
    const suite = load();
    const store = new Store(values.db);
    try {
      const added = addCases(suite, file, store, ids.map((id) => parseId(id, 'message id')), values.name);
      save(suite);
      for (const testCase of added) out(`${style.green('+')} ${testCase.name} ${style.dim(`(${testCase.server})`)}`);
      out(style.dim(`${suite.cases.length} cases in ${file}. Add "ignore": ["path"] to a case for values that change between runs.`));
    } catch (error) {
      fail((error as Error).message);
    } finally {
      store.close();
    }
    return;
  }

  const suite = load();
  if (suite.cases.length === 0) fail(`${file} has no cases; add some with mcpspy suite add`);
  const results = await runSuite(suite, file, {
    filter: values.only,
    headers: parseHeaders(values.header),
    timeoutMs: parseId(values.timeout, '--timeout'),
    onResult: values.json
      ? undefined
      : (result) => {
          const latency = result.latencyMs !== null ? style.dim(` ${formatDuration(result.latencyMs)}`) : '';
          if (result.status === 'pass') out(`${style.green('✓')} ${result.name}${latency}`);
          else if (result.status === 'error') out(`${style.red('!')} ${result.name}  ${style.red(result.error ?? 'error')}`);
          else {
            out(`${style.red('✗')} ${result.name}${latency}`);
            for (const change of result.changes.slice(0, 10)) {
              const detail =
                change.type === 'changed'
                  ? `${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`
                  : change.type === 'added'
                    ? `added ${JSON.stringify(change.after)}`
                    : `removed ${JSON.stringify(change.before)}`;
              out(`    ${style.yellow(change.path)}  ${detail.length > 120 ? `${detail.slice(0, 119)}…` : detail}`);
            }
            if (result.changes.length > 10) out(style.dim(`    … ${result.changes.length - 10} more`));
          }
        },
  });

  const counts = { pass: 0, fail: 0, error: 0 };
  for (const result of results) counts[result.status]++;

  if (values.update && counts.fail > 0) {
    const updated = updateExpectations(suite, results);
    save(suite);
    if (!values.json) out(style.yellow(`Updated ${updated} expectation${updated === 1 ? '' : 's'} in ${file}.`));
    counts.fail = 0;
  }

  if (values.json) out(JSON.stringify({ results, ...counts }, null, 2));
  else {
    out();
    out(
      [
        style.green(`${counts.pass} passed`),
        counts.fail ? style.red(`${counts.fail} failed`) : '',
        counts.error ? style.red(`${counts.error} errored`) : '',
      ]
        .filter(Boolean)
        .join(', '),
    );
  }
  if (counts.fail > 0 || counts.error > 0) process.exitCode = 1;
}

function validate(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { session: { type: 'string' }, db: { type: 'string' } } });
  const store = new Store(values.db);
  const style = styleFor(process.stdout);
  backfillValidation(store);
  const sessionId = values.session !== undefined ? parseId(values.session, '--session') : undefined;
  const messages = store.messagesWithIssues(sessionId, 10_000).reverse();
  const sessions = new Map<number, SessionRow | undefined>();
  const requests = new Map<number, MessageRow | undefined>();
  const out = (line = '') => process.stdout.write(`${line}\n`);

  let errors = 0;
  let warnings = 0;
  for (const message of messages) {
    if (!sessions.has(message.session_id)) sessions.set(message.session_id, store.getSession(message.session_id));
    if (message.request_id !== null && !requests.has(message.request_id)) requests.set(message.request_id, store.getMessage(message.request_id));
    const session = sessions.get(message.session_id);
    const request = message.request_id !== null ? requests.get(message.request_id) : message;
    const subject = request ? requestSubject(request.method, request.payload) : null;
    const what = message.direction === 'client' ? 'request' : 'response';

    out(
      `${style.cyan(`${session?.name ?? 'session'} #${message.session_id}`)}  ${[message.method, subject].filter(Boolean).join(' ')} ${what} ${style.dim(`#${message.id}`)}`,
    );
    for (const issue of JSON.parse(message.issues!) as Issue[]) {
      if (issue.severity === 'error') errors++;
      else warnings++;
      const label = issue.severity === 'error' ? style.red('error  ') : style.yellow('warning');
      out(`  ${label}  ${style.yellow(issue.path)}  ${issue.message}`);
    }
  }
  store.close();

  if (messages.length === 0) {
    out(style.green('No schema or protocol issues found.'));
    return;
  }
  out();
  out(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} in ${messages.length} message${messages.length === 1 ? '' : 's'}`);
  if (errors > 0) process.exitCode = 1;
}

async function ui(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', short: 'p', default: '7777' },
      open: { type: 'boolean' },
      'read-only': { type: 'boolean' },
      db: { type: 'string' },
    },
  });

  const store = new Store(values.db);
  const staticDir = resolveUiDir();
  const server = await startUiServer({ store, port: parseId(values.port, '--port'), staticDir, readOnly: values['read-only'] }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') fail(`port ${values.port} is in use; pick another with --port`);
    throw error;
  });

  process.stdout.write(`mcpspy UI on ${server.url}  (log: ${values.db ?? defaultDbPath()})\n`);
  if (!staticDir) process.stdout.write('Web UI assets not found; only the API is available. Run npm run build.\n');
  if (values.open) openBrowser(server.url);

  const stop = () => {
    void server.close().then(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/** dist/ui next to the compiled CLI, or the build output when running from source. */
function resolveUiDir(): string | null {
  for (const candidate of ['./ui/', '../dist/ui/']) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(`${dir}index.html`)) return dir;
  }
  return null;
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(command, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function parseId(value: string, what: string): number {
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id < 0 || String(id) !== value.trim()) fail(`${what} must be a number`);
  return id;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`mcpspy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
