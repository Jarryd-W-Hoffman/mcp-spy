#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatBytes, formatClock, formatDuration, formatMessageLine, prettyPayload, requestSubject, styleFor } from './format.js';
import { runStdioProxy } from './proxy/stdio.js';
import { defaultDbPath, Store, type MessageRow, type SessionRow } from './store.js';

const HELP = `mcpspy - see what your AI agent and its MCP servers say to each other

Usage:
  mcpspy run [--name <label>] [--db <path>] -- <command> [args...]
  mcpspy -- <command> [args...]            shorthand for run
  mcpspy tail [-f] [-n <count>] [--session <id>] [--json] [--db <path>]
  mcpspy sessions [--limit <n>] [--db <path>]
  mcpspy show <message-id> [--db <path>]

Wrap a stdio MCP server by putting mcpspy in front of its command in your
agent's MCP config, e.g. in .mcp.json:

  "command": "npx",
  "args": ["mcpspy", "run", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"]

Then watch the traffic from another terminal with: mcpspy tail -f

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
    default:
      fail(`unknown command "${first}". Run mcpspy --help.`);
  }
}

async function run(argv: string[]): Promise<void> {
  const separator = argv.indexOf('--');
  if (separator === -1 || separator === argv.length - 1) fail('run needs a server command after "--"');

  const { values } = parseArgs({
    args: argv.slice(0, separator),
    options: { name: { type: 'string' }, db: { type: 'string' } },
  });
  const [command, ...args] = argv.slice(separator + 1) as [string, ...string[]];

  const store = new Store(values.db);
  const { exitCode } = await runStdioProxy({ command, args, store, name: values.name ?? null });
  store.close();

  // stdin may still be open (the agent closed nothing); don't let it hold us up.
  process.stdin.destroy();
  process.exitCode = exitCode;
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

function parseId(value: string, what: string): number {
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id < 0 || String(id) !== value.trim()) fail(`${what} must be a number`);
  return id;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`mcpspy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
