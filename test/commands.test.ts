import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { start } from '../src/cli.js';
import { Store } from '../src/store.js';
import { resolveUiDir } from '../src/ui-dir.js';
import { capture, cli, Exited } from './cli-harness.js';
import { startHttpFixture } from './fixtures/http-server.js';
import { echoServer, recordSession } from './helpers.js';

vi.mock('../src/ui-dir.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui-dir.js')>();
  return { resolveUiDir: vi.fn(actual.resolveUiDir) };
});

const dir = () => mkdtempSync(join(tmpdir(), 'mcpspy-commands-'));
const tmpDb = () => join(dir(), 'log.db');
const line = (message: object) => `${JSON.stringify(message)}\n`;
const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } };

/** Records a session by sending these messages through `mcpspy run` to the echo server. */
async function record(db: string, messages: object[], name = 'echo', server: string[] = [echoServer]) {
  const result = await cli(['run', '--db', db, '--name', name, '--', process.execPath, ...server], {
    stdin: [initialize, ...messages].map(line).join(''),
  });
  expect(result.code).toBe(0);
  return result;
}

/** A log holding one echo session (see recordSession) and its message ids. */
async function seeded() {
  const db = tmpDb();
  const store = new Store(db);
  const ids = await recordSession(store);
  store.close();
  return { db, ...ids };
}

function withStore<T>(db: string, use: (store: Store) => T): T {
  const store = new Store(db);
  try {
    return use(store);
  } finally {
    store.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('mcpspy help and version', () => {
  it('prints help with no command or a help flag', async () => {
    for (const args of [[], ['-h'], ['--help'], ['help']]) {
      const result = await cli(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('mcpspy - see what your AI agent');
    }
  });

  it('prints the version', async () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect((await cli(['-v'])).stdout).toBe(`${version}\n`);
    expect((await cli(['--version'])).stdout).toBe(`${version}\n`);
  });

  it('rejects an unknown command', async () => {
    const result = await cli(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('mcpspy: unknown command "frobnicate". Run mcpspy --help.\n');
  });
});

describe('start', () => {
  const errorListeners = () => process.stdout.listeners('error');

  it('runs a command and stops quietly when the reader goes away', async () => {
    const before = errorListeners();
    const captured = capture();
    try {
      await start(['--version']);
      expect(captured.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
      const added = errorListeners().filter((listener) => !before.includes(listener));
      expect(added).toHaveLength(1);
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      expect(() => added[0]!(epipe)).toThrow(new Exited(0));
      const other = Object.assign(new Error('boom'), { code: 'EIO' });
      expect(() => added[0]!(other)).toThrow(other);
      process.stdout.off('error', added[0]!);
    } finally {
      captured.restore();
    }
  });

  it('turns failures into exit code 1 with a message', async () => {
    const before = errorListeners();
    const captured = capture();
    try {
      vi.mocked(process.stdout.write).mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      await expect(start(['--version'])).rejects.toThrow(new Exited(1));
      expect(captured.stderr).toBe('mcpspy: disk full\n');

      vi.mocked(process.stdout.write).mockImplementationOnce(() => {
        throw 'not an error object';
      });
      await expect(start(['--version'])).rejects.toThrow(new Exited(1));
      expect(captured.stderr).toContain('mcpspy: not an error object\n');
    } finally {
      captured.restore();
      for (const listener of errorListeners()) if (!before.includes(listener)) process.stdout.off('error', listener);
    }
  });

  it('is what the executable runs', async () => {
    const before = errorListeners();
    const captured = capture();
    vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, 'mcpspy', '--version']);
    try {
      vi.resetModules();
      await import('../src/bin.js');
      await vi.waitFor(() => expect(captured.stdout).toMatch(/^\d+\.\d+\.\d+\n$/));
    } finally {
      captured.restore();
      for (const listener of errorListeners()) if (!before.includes(listener)) process.stdout.off('error', listener);
    }
  });
});

describe('mcpspy run', () => {
  it('proxies a server and records the session', async () => {
    const db = tmpDb();
    const result = await record(db, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }]);
    expect(result.stdout).toContain('"serverInfo"');
    expect(result.stdout).toContain('"text":"hi"');
    expect(result.stderr).toContain('echo-server: starting');
    withStore(db, (store) => {
      const [session] = store.listSessions();
      expect(session).toMatchObject({ name: 'echo', exit_code: 0 });
      expect(session!.message_count).toBeGreaterThanOrEqual(4);
    });
  });

  it('accepts the -- shorthand and runs unnamed', async () => {
    const db = join(dir(), 'log.db');
    vi.stubEnv('MCPSPY_DB', db);
    const result = await cli(['--', process.execPath, echoServer], { stdin: line(initialize) });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('echo-server');
  });

  it('records without a usable log, saying so', async () => {
    const file = join(dir(), 'file');
    writeFileSync(file, '');
    const result = await cli(['run', '--db', join(file, 'log.db'), '--', process.execPath, echoServer], { stdin: line(initialize) });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/can't open the log at .*; proxying without recording/);
  });

  it('uses mocks and redaction flags', async () => {
    const mocks = join(dir(), 'mocks.json');
    writeFileSync(mocks, JSON.stringify({ rules: [{ tool: 'echo', match: { tool: 'echo' }, text: 'mocked' }].map(({ tool: _tool, ...rule }) => rule) }));
    const db = tmpDb();
    const result = await cli(
      ['run', '--db', db, '--mocks', mocks, '--redact', 'hunter\\d', '--no-redact', '--', process.execPath, echoServer],
      { stdin: [initialize, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hunter2' } } }].map(line).join('') },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mocked');
    withStore(db, (store) => {
      const payloads = store.messagesAfter(0).map((message) => message.payload).join('\n');
      expect(payloads).not.toContain('hunter2');
    });
  });

  it('holds the server to a policy, and refuses to start it with a broken one', async () => {
    const folder = dir();
    const policy = join(folder, 'policy.json');
    writeFileSync(policy, JSON.stringify({ rules: [{ tool: 'echo', allow: true }] }));
    const db = tmpDb();
    const result = await cli(['run', '--db', db, '--name', 'echo', '--policy', policy, '--', process.execPath, echoServer], {
      stdin: [initialize, ...['echo', 'env'].map((name, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: { text: 'hi' } } }))].map(line).join(''),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"text":"hi"');
    expect(result.stdout).toContain('Blocked by mcpspy policy: no rule allows env');
    expect(result.stderr).toContain('[mcpspy] policy denied tools/call env (default deny): no rule allows env');

    writeFileSync(policy, '{"rules": [{"tool": "echo"}]}');
    const marker = join(folder, 'started');
    const broken = await cli(['run', '--db', db, '--policy', policy, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`]);
    expect(broken.code).toBe(2);
    expect(broken.stderr).toContain(`mcpspy: policy ${policy}: rules[0] needs exactly one of "allow": true, "deny": "<reason>" or "ask": "<prompt>"`);
    expect(existsSync(marker)).toBe(false);
  });

  it('reloads an edited policy, saying so', async () => {
    const policy = join(dir(), 'policy.json');
    writeFileSync(policy, '{"default": "deny"}');
    utimesSync(policy, 1000, 1000);
    const stdin = new PassThrough();
    const running = cli(['run', '--db', tmpDb(), '--policy', policy, '--', process.execPath, echoServer], { stdin });
    writeFileSync(policy, '{"default": "allow"}');
    stdin.end([initialize, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'now allowed' } } }].map(line).join(''));
    const result = await running;
    expect(result.stderr).toContain(`[mcpspy] reloaded policy from ${policy}`);
    expect(result.stdout).toContain('now allowed');
  });

  it('passes on the server exit code', async () => {
    const result = await cli(['run', '--db', tmpDb(), '--', process.execPath, '-e', 'process.exit(3)'], { stdin: '' });
    expect(result.code).toBe(3);
  });

  it('explains bad arguments', async () => {
    expect((await cli(['run'])).stderr).toContain('run needs a server command after "--"');
    expect((await cli(['run', '--'])).stderr).toContain('run needs a server command after "--"');
    const badRegex = await cli(['run', '--redact', '(', '--', 'true']);
    expect(badRegex.code).toBe(2);
    expect(badRegex.stderr).toContain('--redact');
    const missingMocks = await cli(['run', '--mocks', join(dir(), 'none.json'), '--', 'true']);
    expect(missingMocks.code).toBe(2);
    expect(missingMocks.stderr).toContain('none.json');
  });
});

describe('mcpspy proxy', () => {
  it('proxies an HTTP server until stopped', async () => {
    const fixture = await startHttpFixture();
    const db = tmpDb();
    try {
      const result = await cli(['proxy', fixture.url, '--port', '0', '--db', db, '--name', 'web', '-H', 'Authorization: Bearer abc']);
      expect(result.code).toBe(0);
      const url = /Point your agent at (\S+)/.exec(result.stderr)![1]!;
      expect(result.stderr).toContain('Adding authorization to every request (never recorded)');
      expect(result.stderr).not.toContain('abc');

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(initialize),
      });
      expect(response.status).toBe(200);
      expect(fixture.received.at(-1)!.authorization).toBe('Bearer abc');

      const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
      result.signals.get('SIGTERM')!();
      expect(await exited).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('holds an HTTP server to a policy, and refuses to listen with a broken one', async () => {
    const fixture = await startHttpFixture();
    const policy = join(dir(), 'policy.json');
    writeFileSync(policy, '{"default": "deny"}');
    try {
      const result = await cli(['proxy', fixture.url, '--port', '0', '--policy', policy, '--db', tmpDb()]);
      const url = /Point your agent at (\S+)/.exec(result.stderr)![1]!;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }),
      });
      expect(await response.text()).toContain('Blocked by mcpspy policy: no rule allows echo');
      const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
      result.signals.get('SIGINT')!();
      expect(await exited).toBe(0);

      writeFileSync(policy, '{"rules": 1}');
      const broken = await cli(['proxy', fixture.url, '--port', '0', '--policy', policy, '--db', tmpDb()]);
      expect(broken.code).toBe(2);
      expect(broken.stderr).toContain('"rules" must be an array');
    } finally {
      await fixture.close();
    }
  });

  it('proxies without extra headers', async () => {
    const fixture = await startHttpFixture();
    try {
      const result = await cli(['proxy', fixture.url, '--port', '0', '--db', tmpDb()]);
      expect(result.stderr).not.toContain('Adding');
      const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
      result.signals.get('SIGINT')!();
      expect(await exited).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('explains bad arguments', async () => {
    expect((await cli(['proxy'])).stderr).toContain('proxy needs the server URL');
    expect((await cli(['proxy', 'http://x', '--port', 'abc'])).stderr).toContain('--port must be a port number');
    expect((await cli(['proxy', 'http://x', '--port', '70000'])).stderr).toContain('--port must be a port number');
    expect((await cli(['proxy', 'http://x', '--host', '0.0.0.0'])).stderr).toContain('--host must be a loopback address');
    expect((await cli(['proxy', 'not a url', '--port', '0', '--db', tmpDb()])).code).toBe(2);
  });

  it('explains a port in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const result = await cli(['proxy', 'http://127.0.0.1:1/mcp', '--port', String(port), '--db', tmpDb()]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`port ${port} is in use; pick another with --port`);
    } finally {
      blocker.close();
    }
  });
});

describe('mcpspy mock', () => {
  it('serves a mock file as a server', async () => {
    const file = join(dir(), 'mocks.json');
    writeFileSync(file, JSON.stringify({ server: { name: 'fake' }, rules: [{ match: { tool: 'echo' }, text: 'canned' }] }));
    const db = tmpDb();
    const result = await cli(['mock', 'serve', file, '--db', db, '--name', 'fake'], {
      stdin: [initialize, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }].map(line).join(''),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('canned');
    withStore(db, (store) => expect(store.listSessions()[0]).toMatchObject({ name: 'fake', transport: 'mock' }));
  });

  it('serves unnamed', async () => {
    const file = join(dir(), 'mocks.json');
    writeFileSync(file, '{}');
    const result = await cli(['mock', 'serve', file, '--db', tmpDb()], { stdin: line(initialize) });
    expect(result.code).toBe(0);
  });

  it('turns recorded calls into rules, adding to an existing file', async () => {
    const { db, echo, time } = await seeded();
    const file = join(dir(), 'mocks.json');
    const first = await cli(['mock', 'add', file, String(echo), '--db', db]);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/added rule ".*echo.*"\nwrote /);

    const response = withStore(db, (store) => store.responseTo(time)!.id);
    const second = await cli(['mock', 'add', file, String(response), String(echo), '--db', db]);
    expect(second.code).toBe(0);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { rules: unknown[]; tools: unknown[] };
    expect(saved.rules).toHaveLength(3);
  });

  it('takes tool definitions from the recorded tools/list', async () => {
    const db = tmpDb();
    await record(db, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'a' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } },
      { jsonrpc: '2.0', id: 4, method: 'ping' },
    ]);
    const ids = withStore(db, (store) =>
      store
        .messagesAfter(0)
        .filter((message) => message.kind === 'request' && message.direction === 'client' && message.method !== 'initialize')
        .map((message) => String(message.id)),
    );
    const file = join(dir(), 'mocks.json');
    writeFileSync(file, JSON.stringify({ rules: [] }));
    const result = await cli(['mock', 'add', file, ...ids, '--db', db]);
    expect(result.code).toBe(0);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { tools: { name: string }[] };
    expect(saved.tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('explains bad arguments', async () => {
    const { db, roots } = await seeded();
    const rootsRequest = withStore(db, (store) => store.messagesAfter(0).find((message) => message.method === 'roots/list' && message.direction === 'server')!.id);
    const file = join(dir(), 'mocks.json');
    expect((await cli(['mock'])).stderr).toContain('usage: mcpspy mock serve');
    expect((await cli(['mock', 'serve'])).stderr).toContain('mock serve needs a mock file');
    expect((await cli(['mock', 'add', file])).stderr).toContain('mock add needs a mock file and at least one message id');
    expect((await cli(['mock', 'add', file, '9999', '--db', db])).stderr).toContain('no message #9999');
    expect((await cli(['mock', 'add', file, String(rootsRequest), '--db', db])).stderr).toContain('is not a client request or a response to one');
    expect((await cli(['mock', 'add', file, String(roots), '--db', db])).code).toBe(0);
    writeFileSync(file, '[]');
    expect((await cli(['mock', 'add', file, String(roots), '--db', db])).stderr).toContain('mock file must be a JSON object');
  });
});

describe('mcpspy tail', () => {
  it('prints the latest messages, as text or JSON', async () => {
    const { db, sessionId } = await seeded();
    const text = await cli(['tail', '--db', db, '-n', '3']);
    expect(text.code).toBe(0);
    expect(text.stdout.trim().split('\n')).toHaveLength(3);
    expect(text.stdout).toContain('echo');

    const json = await cli(['tail', '--db', db, '--json', '--session', String(sessionId)]);
    const rows = json.stdout.trim().split('\n').map((row) => JSON.parse(row) as { session_id: number });
    expect(rows.every((row) => row.session_id === sessionId)).toBe(true);
    expect(rows.length).toBeGreaterThan(8);
  });

  it('names the request a response answers, and flags responses to none', async () => {
    const { db, time } = await seeded();
    const response = withStore(db, (store) => store.responseTo(time)!.id);
    const all = await cli(['tail', '--db', db, '--json']);
    const after = all.stdout.trim().split('\n').map((row) => (JSON.parse(row) as { id: number }).id).filter((id) => id >= response).length;
    expect((await cli(['tail', '--db', db, '-n', String(after)])).stdout.split('\n')[0]).toMatch(/tools\/call time ✓/);
    withStore(db, (store) => {
      const session = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
      store.insertMessage({ session_id: session, ts: Date.now(), direction: 'server', kind: 'response', method: null, rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"result":{}}', size: 10, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
    });
    expect((await cli(['tail', '--db', db, '-n', '1'])).stdout).toContain('unmatched id=1');
  });

  it('reads past a batch', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      const session = store.createSession({ name: 'big', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
      for (let i = 0; i < 1001; i++) {
        store.insertMessage({ session_id: session, ts: Date.now(), direction: 'stderr', kind: 'log', method: null, rpc_id: null, payload: `line ${i}`, size: 6, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
      }
    });
    const result = await cli(['tail', '--db', db, '-n', '1001']);
    expect(result.stdout.trim().split('\n')).toHaveLength(1001);
  });

  it('follows new messages until interrupted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { db } = await seeded();
      const result = await cli(['tail', '-f', '--db', db, '-n', '0']);
      expect(result.stdout).toBe('');
      const captured = capture();
      try {
        withStore(db, (store) => {
          const session = store.createSession({ name: 'later', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
          store.insertMessage({ session_id: session, ts: Date.now(), direction: 'stderr', kind: 'log', method: null, rpc_id: null, payload: 'hello from later', size: 16, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
        });
        vi.advanceTimersByTime(200);
        vi.advanceTimersByTime(200);
        expect(captured.stdout).toContain('hello from later');
        expect(captured.stdout).toContain('later');
      } finally {
        captured.restore();
      }
      result.signals.get('SIGINT')!();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains bad arguments', async () => {
    expect((await cli(['tail', '-n', 'x'])).stderr).toContain('-n must be a non-negative number');
    expect((await cli(['tail', '--lines=-1'])).stderr).toContain('-n must be a non-negative number');
    expect((await cli(['tail', '--session', 'x'])).stderr).toContain('--session must be a number');
  });
});

describe('mcpspy sessions', () => {
  it('says when nothing is recorded', async () => {
    expect((await cli(['sessions', '--db', tmpDb()])).stdout).toContain('No sessions recorded yet');
  });

  it('lists sessions with their status', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      const add = (name: string | null, end: { exit_code: number | null; exit_signal: string | null } | null) => {
        const id = store.createSession({ name, transport: 'stdio', command: JSON.stringify(['node', name ?? 'x']), cwd: '/', pid: null, started_at: Date.now() - 5000 });
        if (end) store.endSession(id, { ended_at: Date.now(), ...end });
      };
      add('running', null);
      add('killed', { exit_code: null, exit_signal: 'SIGTERM' });
      add('closed', { exit_code: null, exit_signal: null });
      add('ok', { exit_code: 0, exit_signal: null });
      add(null, { exit_code: 1, exit_signal: null });
    });
    const result = await cli(['sessions', '--db', db, '--limit', '10']);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/#1\s+running\s+.*running\s+0 msgs\s+node running/);
    expect(lines[1]).toContain('killed SIGTERM');
    expect(lines[2]).toMatch(/closed\s+.*closed\s+\d/);
    expect(lines[3]).toContain('exit 0');
    expect(lines[4]).toMatch(/#5\s+-\s+.*exit 1/);
  });
});

describe('mcpspy search', () => {
  it('lists matching messages oldest first, with the match in context', async () => {
    const { db } = await seeded();
    const result = await cli(['search', 'ECHO', '--db', db]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    // Server stderr is searched too.
    expect(lines[0]).toMatch(/#\d+ stderr echo-server/);
    expect(lines).toContainEqual(expect.stringMatching(/#\d+ → tools\/call echo/));
    expect(lines[1]).toMatch(/^ {4}.*echo/i);
    const ids = lines.filter((_, i) => i % 2 === 0).map((line) => Number(/#(\d+)/.exec(line)![1]));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(result.stderr).toBe('');
  });

  it('limits, filters by session, and writes JSON', async () => {
    const { db, sessionId } = await seeded();
    const limited = await cli(['search', 'echo', '-n', '1', '--session', String(sessionId), '--json', '--db', db]);
    const rows = limited.stdout.trimEnd().split('\n').map((row) => JSON.parse(row) as { session_id: number });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe(sessionId);
    expect(limited.stderr).toContain('Showing the newest 1 matches');
  });

  it('exits 1 when nothing matches, and explains bad arguments', async () => {
    const { db } = await seeded();
    const none = await cli(['search', 'no', 'such', 'text', '--db', db]);
    expect([none.code, none.stdout, none.stderr]).toEqual([1, '', 'No recorded messages contain "no such text".\n']);
    expect((await cli(['search', ' ', '--db', db])).stderr).toContain('search needs some text to look for');
    expect((await cli(['search', 'x', '-n', '0', '--db', db])).stderr).toContain('-n must be a positive number');
    expect((await cli(['search', 'x', '--session', 'abc', '--db', db])).stderr).toContain('--session must be a number');
  });
});

describe('mcpspy show', () => {
  it('shows a request with its response, from either side', async () => {
    const { db, echo } = await seeded();
    const request = await cli(['show', String(echo), '--db', db]);
    expect(request.stdout).toMatch(/^echo\n\n#\d+ {2}client {2}request/);
    expect(request.stdout).toContain('server  response');
    const responseId = withStore(db, (store) => store.responseTo(echo)!.id);
    expect((await cli(['show', String(responseId), '--db', db])).stdout).toBe(request.stdout);
  });

  it('shows a message on its own, and a request without a reply', async () => {
    const db = tmpDb();
    const [log, request] = withStore(db, (store) => {
      const session = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
      const base = { session_id: session, ts: Date.now(), size: 1, problem: null, request_id: null, tokens: null, token_detail: null, issues: null, rpc_id: null };
      return [
        store.insertMessage({ ...base, direction: 'stderr', kind: 'log', method: null, payload: 'starting up', latency_ms: 3 }),
        store.insertMessage({ ...base, direction: 'client', kind: 'request', method: 'ping', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"ping"}', latency_ms: null }),
      ];
    });
    const logged = await cli(['show', String(log), '--db', db]);
    expect(logged.stdout).toMatch(/^session #1\n\n#1 {2}stderr {2}log .* 3ms\nstarting up/);
    expect((await cli(['show', String(request), '--db', db])).stdout).toContain('No response recorded.');
  });

  it('explains bad arguments', async () => {
    expect((await cli(['show'])).stderr).toContain('show takes exactly one message id');
    expect((await cli(['show', '42', '--db', tmpDb()])).stderr).toContain('no message with id 42');
    expect((await cli(['show', '4x', '--db', tmpDb()])).stderr).toContain('message id must be a number');
  });
});

describe('mcpspy tokens', () => {
  it('reports tool definitions, calls and changes between sessions', async () => {
    const db = tmpDb();
    const calls = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing' } },
    ];
    await record(db, calls);
    const first = await cli(['tokens', '--db', db]);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/echo #1 {2}token counts are estimate/);
    expect(first.stdout).toMatch(/Tool definitions: ≈\d+ tokens across 5 tools/);
    expect(first.stdout).toMatch(/echo\s+1\s+0/);
    expect(first.stdout).toMatch(/missing\s+1\s+1/);
    expect(first.stdout).not.toContain('Tool list');

    await record(db, calls);
    expect((await cli(['tokens', '--db', db])).stdout).toContain('Tool list unchanged since session #1.');

    // A different server under the same name: tools added, removed and changed.
    const mocks = join(dir(), 'mocks.json');
    writeFileSync(
      mocks,
      JSON.stringify({
        tools: [
          { name: 'echo', description: 'A much longer description of echo than before, to change its cost', inputSchema: { type: 'object' } },
          { name: 'brand-new', inputSchema: { type: 'object' } },
        ],
      }),
    );
    const changed = await cli(['run', '--db', db, '--name', 'echo', '--mocks', mocks, '--', process.execPath, echoServer], { stdin: [initialize, calls[0]!].map(line).join('') });
    expect(changed.code).toBe(0);
    const report = await cli(['tokens', '--db', db, '--session', '3']);
    expect(report.stdout).toContain('Tool list changes since session #2');
    expect(report.stdout).toMatch(/\+ brand-new/);
    expect(report.stdout).toMatch(/~ echo: description, inputSchema \(-\d+ tok\)/);

    // Same tools, one removed.
    const fewer = join(dir(), 'fewer.json');
    writeFileSync(fewer, JSON.stringify({ rules: [{ match: { method: 'tools/list' }, result: { tools: [{ name: 'echo', description: 'a much longer description of echo than before, to change its cost', inputSchema: { type: 'object' } }] } }] }));
    await cli(['run', '--db', db, '--name', 'echo', '--mocks', fewer, '--', process.execPath, echoServer], { stdin: [initialize, calls[0]!].map(line).join('') });
    const removed = await cli(['tokens', '--db', db]);
    expect(removed.stdout).toMatch(/- brand-new \(-\d+ tok\)/);
    expect(removed.stdout).toMatch(/~ echo: description\n/);
  });

  it('says when a session listed no tools', async () => {
    const { db, sessionId } = await seeded();
    const result = await cli(['tokens', '--db', db, '--session', String(sessionId)]);
    expect(result.stdout).toContain('No tools/list recorded in this session.');
    expect(result.stdout).toMatch(/echo\s+1\s+0\s+\S+\s+\S+/);
  });

  it('labels unnamed sessions by command, and shows calls with no timing', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      const session = store.createSession({ name: null, transport: 'stdio', command: '["node","server.js"]', cwd: '/', pid: null, started_at: Date.now() });
      store.insertMessage({ session_id: session, ts: Date.now(), direction: 'client', kind: 'request', method: 'tools/call', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t"}}', size: 1, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
    });
    const result = await cli(['tokens', '--db', db]);
    expect(result.stdout).toContain('node server.js #1');
  });

  it('explains a missing session', async () => {
    expect((await cli(['tokens', '--db', tmpDb()])).stderr).toContain('no sessions recorded yet');
    expect((await cli(['tokens', '--db', tmpDb(), '--session', '7'])).stderr).toContain('no session with id 7');
  });
});

describe('mcpspy diff', () => {
  it('compares two requests and their responses', async () => {
    const db = tmpDb();
    await record(db, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'a' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'b' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'a' } } },
    ]);
    const [a, b, c] = withStore(db, (store) => store.messagesAfter(0).filter((message) => message.method === 'tools/call').map((message) => String(message.id)));
    const different = await cli(['diff', a!, b!, '--db', db]);
    expect(different.stdout).toMatch(/request: #\d+ → #\d+\n@@ -\d+ \+\d+ @@\n/);
    expect(different.stdout).toContain('-    "text": "a"');
    expect(different.stdout).toContain('+    "text": "b"');
    expect(different.stdout).toContain('response:');
    const same = await cli(['diff', a!, c!, '--db', db]);
    expect(same.stdout).toContain('  identical');
  });

  it('compares any two messages, and says when a response is missing', async () => {
    const db = tmpDb();
    const [log1, log2, request] = withStore(db, (store) => {
      const session = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
      const base = { session_id: session, ts: Date.now(), size: 1, problem: null, request_id: null, tokens: null, token_detail: null, issues: null, latency_ms: null };
      return [
        store.insertMessage({ ...base, direction: 'stderr', kind: 'log', method: null, rpc_id: null, payload: 'one' }),
        store.insertMessage({ ...base, direction: 'stderr', kind: 'log', method: null, rpc_id: null, payload: 'two' }),
        store.insertMessage({ ...base, direction: 'client', kind: 'request', method: 'ping', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }),
      ];
    });
    expect((await cli(['diff', String(log1), String(log2), '--db', db])).stdout).toMatch(/^message: #1 → #2\n/);
    const missing = await cli(['diff', String(request), String(request), '--db', db]);
    expect(missing.stdout).toContain('response: #- → #-\n  missing on one side');
  });

  it('explains bad arguments', async () => {
    expect((await cli(['diff', '1'])).stderr).toContain('diff takes two message ids');
    expect((await cli(['diff', '1', '2', '--db', tmpDb()])).stderr).toContain('no message with id 1');
  });
});

describe('mcpspy validate', () => {
  it('reports no issues in clean traffic', async () => {
    const { db } = await seeded();
    const result = await cli(['validate', '--db', db]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No schema or protocol issues found.');
  });

  it('lists errors and warnings and fails on errors', async () => {
    const { db, echo } = await seeded();
    withStore(db, (store) => store.setIssues(echo, JSON.stringify([{ severity: 'error', path: 'params.arguments', message: 'must have text' }])));
    const result = await cli(['validate', '--db', db]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/echo #1 {2}tools\/call echo request #\d+/);
    expect(result.stdout).toMatch(/error {4}params\.arguments {2}must have text/);
    expect(result.stdout).toMatch(/1 error, 0 warnings in 1 message\n$/);

    withStore(db, (store) => {
      const response = store.responseTo(echo)!;
      store.setIssues(response.id, JSON.stringify([{ severity: 'warning', path: 'result', message: 'odd' }, { severity: 'warning', path: 'result', message: 'odder' }]));
      const session = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
      const id = store.insertMessage({ session_id: session, ts: Date.now(), direction: 'server', kind: 'response', method: null, rpc_id: '1', payload: '{}', size: 2, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
      store.setIssues(id, JSON.stringify([{ severity: 'error', path: '', message: 'bad' }]));
    });
    const many = await cli(['validate', '--db', db]);
    expect(many.stdout).toMatch(/2 errors, 2 warnings in 3 messages\n$/);
    expect(many.stdout).toMatch(/session #2 {2} response/);

    const one = await cli(['validate', '--db', db, '--session', '2']);
    expect(one.stdout).toMatch(/1 error, 0 warnings in 1 message/);
  });
});

describe('mcpspy replay', () => {
  it('replays a request and diffs the response with the original', async () => {
    const { db, echo, time } = await seeded();
    const same = await cli(['replay', String(echo), '--db', db]);
    expect(same.code).toBe(0);
    expect(same.stdout).toMatch(/^Replayed tools\/call echo \(#\d+ from echo #1\) → session #2\n/);
    expect(same.stdout).toContain('(spawn + initialize)');
    expect(same.stdout).toMatch(/run 1 {2}✓/);
    expect(same.stdout).toContain('identical');

    const changed = await cli(['replay', String(time), '--db', db, '--repeat', '3']);
    expect(changed.stdout).toMatch(/run 3/);
    expect(changed.stdout).toMatch(/latency min .* · median .* · max /);
    expect(changed.stdout).toContain('"now"');
  });

  it('replays with new arguments or params, as JSON', async () => {
    const { db, echo } = await seeded();
    const args = await cli(['replay', String(echo), '--db', db, '--args', '{"text":"changed"}', '--json']);
    expect(JSON.parse(args.stdout)).toMatchObject({ runs: [{ response: { result: { content: [{ text: 'changed' }] } } }] });
    const params = await cli(['replay', String(echo), '--db', db, '--params', '{"name":"nope"}']);
    expect(params.stdout).toMatch(/run 1 {2}✗ -32602 Unknown tool: nope/);
  });

  it('shows the whole response when the original had none, and warns about missing configuration', async () => {
    const db2 = tmpDb();
    const request = withStore(db2, (store) => {
      const session = store.createSession({ name: null, transport: 'stdio', command: JSON.stringify([process.execPath, echoServer]), cwd: process.cwd(), pid: null, started_at: Date.now(), env_keys: JSON.stringify(['MCPSPY_TEST_API_KEY', 'HOME']) });
      return store.insertMessage({ session_id: session, ts: Date.now(), direction: 'client', kind: 'request', method: 'tools/call', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"x"}}}', size: 1, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
    });
    const result = await cli(['replay', String(request), '--db', db2, '-e', 'OTHER=1']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Response (the original had none):');
    expect(result.stdout).toMatch(/Replayed tools\/call echo \(#1 from session #1\)/);
    expect(result.stdout).toContain('The original server had MCPSPY_TEST_API_KEY set');
  });

  it('reports a failed replay with exit code 1', async () => {
    const { db, initialize: init } = await seeded();
    const result = await cli(['replay', String(init), '--db', db]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mcpspy: replay failed: initialize is sent automatically');

    const broken = tmpDb();
    const request = withStore(broken, (store) => {
      const session = store.createSession({ name: null, transport: 'stdio', command: JSON.stringify([process.execPath, '-e', 'process.exit(1)']), cwd: process.cwd(), pid: null, started_at: Date.now() });
      return store.insertMessage({ session_id: session, ts: Date.now(), direction: 'client', kind: 'request', method: 'ping', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"ping"}', size: 1, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
    });
    const failed = await cli(['replay', String(request), '--db', broken, '--timeout', '2000']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/replay failed \(recorded as session #2\): /);
  });

  it('rethrows unexpected errors', async () => {
    const { db, echo } = await seeded();
    vi.spyOn(Store.prototype, 'createSession').mockImplementation(() => {
      throw new Error('disk on fire');
    });
    await expect(cli(['replay', String(echo), '--db', db])).rejects.toThrow('disk on fire');
  });

  it('explains bad arguments', async () => {
    expect((await cli(['replay'])).stderr).toContain('replay takes one message id');
    expect((await cli(['replay', '1', '--args', '{}', '--params', '{}'])).stderr).toContain('use either --args or --params, not both');
    expect((await cli(['replay', '1', '--repeat', '0'])).stderr).toContain('--repeat must be at least 1');
    expect((await cli(['replay', '1', '-e', 'NOEQUALS'])).stderr).toContain('--env expects KEY=VALUE, got "NOEQUALS"');
    expect((await cli(['replay', '1', '-e', '=x'])).stderr).toContain('--env expects KEY=VALUE');
    expect((await cli(['replay', '1', '-H', 'nocolon'])).stderr).toContain('--header expects "Name: value", got "nocolon"');
    const { db, echo } = await seeded();
    expect((await cli(['replay', String(echo), '--db', db, '--args', '{'])).stderr).toContain('--args is not valid JSON');
    expect((await cli(['replay', String(echo), '--db', db, '--params', 'nope'])).stderr).toContain('--params is not valid JSON');
    expect((await cli(['replay', '999', '--db', db, '--args', '{}'])).stderr).toContain('no message with id 999');
  });
});

describe('mcpspy suite', () => {
  it('adds cases and runs them, updating expectations on request', async () => {
    const { db, echo, time } = await seeded();
    const file = join(dir(), 'suite.json');
    const added = await cli(['suite', 'add', file, String(echo), '--db', db, '--name', 'echo works']);
    expect(added.code).toBe(0);
    expect(added.stdout).toMatch(/^\+ echo works \(echo\)\n1 cases in /);
    await cli(['suite', 'add', file, String(time), '--db', db]);

    const run = await cli(['suite', 'run', file]);
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/✓ echo works \S+/);
    expect(run.stdout).toMatch(/✗ tools\/call time/);
    expect(run.stdout).toMatch(/structuredContent\.now {2}\d+ → \d+/);
    expect(run.stdout).toMatch(/1 passed, 1 failed\n$/);

    const only = await cli(['suite', 'run', file, '--only', 'echo']);
    expect(only.code).toBe(0);
    expect(only.stdout).toMatch(/1 passed\n$/);

    const updated = await cli(['suite', 'run', file, '--update']);
    expect(updated.code).toBe(0);
    expect(updated.stdout).toContain('Updated 1 expectation in');

    const json = await cli(['suite', 'run', file, '--json', '--update']);
    const report = JSON.parse(json.stdout) as { pass: number; fail: number; results: unknown[] };
    expect(report.results).toHaveLength(2);
    expect(report.fail).toBe(0);
  });

  it('prints many and long changes compactly, and errors', async () => {
    const file = join(dir(), 'suite.json');
    const { db, echo } = await seeded();
    await cli(['suite', 'add', file, String(echo), '--db', db]);
    const suite = JSON.parse(readFileSync(file, 'utf8')) as { cases: { name: string; expect: unknown }[] };
    const content = Array.from({ length: 12 }, (_, i) => ({ type: 'text', text: `${'long '.repeat(40)}${i}` }));
    suite.cases[0]!.expect = { content, removed: 1 };
    suite.cases.push({ ...suite.cases[0]!, name: 'second', expect: {} });
    writeFileSync(file, JSON.stringify(suite));
    const run = await cli(['suite', 'run', file]);
    expect(run.stdout).toContain('… 3 more');
    expect(run.stdout).toMatch(/content\[1\] {2}removed /);
    expect(run.stdout).toMatch(/content {2}added /);
    expect(run.stdout).toMatch(/…\n/);
    expect(run.stdout).toMatch(/2 failed\n$/);

    const updated = await cli(['suite', 'run', file, '--update']);
    expect(updated.stdout).toContain('Updated 2 expectations');

    const broken = JSON.parse(readFileSync(file, 'utf8')) as { servers: Record<string, { command: string[] }> };
    for (const server of Object.values(broken.servers)) server.command = [process.execPath, '-e', 'process.exit(1)'];
    writeFileSync(file, JSON.stringify(broken));
    const errored = await cli(['suite', 'run', file, '--timeout', '2000']);
    expect(errored.code).toBe(1);
    expect(errored.stdout).toMatch(/! .* {2}\S/);
    expect(errored.stdout).toMatch(/0 passed, 2 errored\n$/);
  });

  it('explains bad arguments and files', async () => {
    const file = join(dir(), 'suite.json');
    expect((await cli(['suite'])).stderr).toContain('usage: mcpspy suite add');
    expect((await cli(['suite', 'list', file])).stderr).toContain('usage: mcpspy suite add');
    expect((await cli(['suite', 'add', file])).stderr).toContain('suite add needs at least one message id');
    expect((await cli(['suite', 'add', file, '77', '--db', tmpDb()])).stderr).toContain('77');
    expect((await cli(['suite', 'run', file])).stderr).toContain('has no cases; add some with mcpspy suite add');
    writeFileSync(file, '{"cases": 1}');
    expect((await cli(['suite', 'run', file])).stderr).toContain(`${file}: `);
  });
});

describe('mcpspy prune', () => {
  const old = (store: Store, name: string, daysAgo: number, ended = true) => {
    const started = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
    const id = store.createSession({ name, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: started });
    store.insertMessage({ session_id: id, ts: started, direction: 'stderr', kind: 'log', method: null, rpc_id: null, payload: 'x'.repeat(100), size: 100, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
    if (ended) store.endSession(id, { ended_at: started + 1000, exit_code: 0, exit_signal: null });
    return id;
  };

  it('keeps the newest sessions, listing at most 20 in a dry run', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      for (let i = 0; i < 25; i++) old(store, `s${i}`, 30 - i);
      old(store, 'one', 0, false);
    });
    const dryRun = await cli(['prune', '--keep', '2', '--dry-run', '--db', db]);
    expect(dryRun.stdout).toContain('Would delete 24 of 26 sessions');
    expect(dryRun.stdout).toContain('… and 4 more');

    const pruned = await cli(['prune', '--keep', '1', '--db', db]);
    expect(pruned.stdout).toContain('Deleted 25 of 26 sessions');
    expect(pruned.stdout).toContain('run with --vacuum to shrink the file now');
    expect((await cli(['prune', '--keep', '1', '--db', db])).stdout).toContain('Nothing to prune.');
    expect((await cli(['prune', '--keep', '0', '--db', db])).stdout).toMatch(/Nothing to prune\.\nKeeping 1 matching session that may still be running\./);
  });

  it('prunes by size, and says how many running sessions it kept', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      old(store, 'only', 3);
      old(store, 'live', 0, false);
      old(store, 'live2', 0, false);
    });
    const result = await cli(['prune', '--max-size', '1KB', '--keep', '0', '--db', db]);
    expect(result.stdout).toContain('Deleted 1 of 3 sessions');
    expect(result.stdout).toContain('Keeping 2 matching sessions that may still be running.');
    expect((await cli(['prune', '--older-than', '1d', '--keep', '9', '--db', db])).stdout).toContain('Nothing to prune.');
  });

  it('only vacuums with --vacuum alone, and reports free space', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      // Each deleted session pauses 20 ms for other writers; 40 free enough pages without taking seconds.
      for (let i = 0; i < 40; i++) old(store, `s${i}`, 10);
    });
    await cli(['prune', '--older-than', '1d', '--db', db]);
    const result = await cli(['prune', '--vacuum', '--db', db]);
    expect(result.stdout).toMatch(/free for reuse\)\nVacuumed: /);
    expect(result.stdout).not.toContain('Deleted');
    const dry = await cli(['prune', '--vacuum', '--older-than', '1d', '--dry-run', '--db', db]);
    expect(dry.stdout).not.toContain('Vacuumed');
  });

  it('prunes and vacuums in one go', async () => {
    const db = tmpDb();
    withStore(db, (store) => old(store, 'gone', 10));
    const result = await cli(['prune', '--older-than', '1d', '--vacuum', '--db', db]);
    expect(result.stdout).toMatch(/Deleted 1 of 1 session .*\nVacuumed: /);
    expect(result.stdout).not.toContain('run with --vacuum');
  });

  it('explains a failed vacuum', async () => {
    vi.spyOn(Store.prototype, 'vacuum').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const result = await cli(['prune', '--vacuum', '--db', tmpDb()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("couldn't vacuum the log (database is locked)");
  });

  it('uses the default log path', async () => {
    vi.stubEnv('MCPSPY_DB', tmpDb());
    expect((await cli(['prune', '--keep', '5'])).stdout).toContain(process.env.MCPSPY_DB!);
    expect((await cli(['prune', '--max-size', 'lots'])).code).toBe(2);
  });
});

describe('mcpspy policy suggest', () => {
  it('drafts a policy from the latest or a chosen session', async () => {
    const { db, sessionId } = await seeded();
    const latest = await cli(['policy', 'suggest', '--db', db]);
    expect(latest.code).toBe(0);
    const policy = JSON.parse(latest.stdout) as { default: string; rules: { tool: string }[] };
    expect(policy.default).toBe('deny');
    expect(policy.rules.map((rule) => rule.tool)).toEqual(['echo', 'env', 'roots', 'time']);
    expect(latest.stderr).toContain(`Allows the 4 tools session #${sessionId} called (4 calls), and denies everything else.`);
    expect((await cli(['policy', 'suggest', '--session', String(sessionId), '--db', db])).stdout).toBe(latest.stdout);
  });

  it('counts a single call, and pages through long sessions', async () => {
    const db = tmpDb();
    await record(db, [
      ...Array.from({ length: 600 }, (_, id) => ({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: id } })),
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} },
    ]);
    const result = await cli(['policy', 'suggest', '--db', db]);
    expect(result.stderr).toContain('Allows the 1 tool session #1 called (1 call)');
  });

  it('explains bad arguments', async () => {
    expect((await cli(['policy'])).stderr).toContain('policy takes one subcommand: suggest');
    expect((await cli(['policy', 'suggest', '--db', tmpDb()])).stderr).toContain('no sessions recorded yet');
    expect((await cli(['policy', 'suggest', '--session', '9', '--db', tmpDb()])).stderr).toContain('no session with id 9');
  });
});

describe('mcpspy export and import', () => {
  it('copies every session, or chosen ones, from one log to another', async () => {
    const { db, sessionId } = await seeded();
    const all = await cli(['export', '--db', db]);
    expect(all.code).toBe(0);
    expect(all.stderr).toMatch(/^Exported 1 session \(\d+ messages\)\. It holds tool arguments and results as recorded: check it before sharing\.\n$/);
    const file = join(dir(), 'log.jsonl');
    writeFileSync(file, all.stdout);

    const other = tmpDb();
    expect((await cli(['import', file, '--db', other])).stderr).toMatch(/^Imported 1 session \(\d+ messages\) as #1\.\n$/);
    const piped = await cli(['import', '-', '--db', other], { stdin: all.stdout + all.stdout.split('\n').slice(1).join('\n') });
    expect(piped.stderr).toMatch(/as #2–#3\.\n$/);
    expect((await cli(['export', '--session', '1', '--db', other])).stdout.replace(/"(id|session_id|request_id)":\d+/g, '')).toBe(
      (await cli(['export', '--session', String(sessionId), '--db', db])).stdout.replace(/"(id|session_id|request_id)":\d+/g, ''),
    );
  });

  it('handles empty logs and exports', async () => {
    const empty = await cli(['export', '--db', tmpDb()]);
    expect([empty.stdout, empty.stderr]).toEqual(['{"mcpspy":"log","version":1}\n', expect.stringContaining('Exported 0 sessions (0 messages)')]);
    expect((await cli(['import', '-', '--db', tmpDb()], { stdin: empty.stdout })).stderr).toBe('Imported 0 sessions (0 messages).\n');
  });

  it('explains bad arguments and bad files', async () => {
    expect((await cli(['export', '--session', '4', '--db', tmpDb()])).stderr).toContain('no session with id 4');
    expect((await cli(['import', '--db', tmpDb()])).stderr).toContain('import takes one file (or - for stdin)');
    expect((await cli(['import', '/no/such/file', '--db', tmpDb()])).stderr).toContain('no such file: /no/such/file');
    const bad = await cli(['import', '-', '--db', tmpDb()], { stdin: 'hello\n' });
    expect([bad.code, bad.stderr]).toEqual([2, 'mcpspy: import failed, nothing imported: line 1 is not JSON\n']);
  });
});

describe('mcpspy wrap and unwrap', () => {
  const config = (text: string) => {
    const path = join(dir(), 'mcp.json');
    writeFileSync(path, text);
    return path;
  };

  it('warns when the policy sits where the servers it governs could write it', async () => {
    const project = dir();
    const path = join(project, 'mcp.json');
    writeFileSync(path, '{"mcpServers":{"a":{"command":"node","args":["a.js"]}}}');
    writeFileSync(join(project, 'policy.json'), '{"default": "allow"}');
    const inside = await cli(['wrap', path, '--policy', join(project, 'policy.json'), '--dry-run']);
    expect(inside.code).toBe(0);
    expect(inside.stderr).toContain(`mcpspy: warning: the policy ${join(realpathSync(project), 'policy.json')} is inside the config's directory`);
    const elsewhere = join(dir(), 'policy.json');
    writeFileSync(elsewhere, '{"default": "allow"}');
    expect((await cli(['wrap', path, '--policy', elsewhere, '--dry-run'])).stderr).not.toContain('warning');

    const cwd = process.cwd();
    process.chdir(project);
    try {
      const run = await cli(['run', '--db', tmpDb(), '--policy', 'policy.json', '--', process.execPath, echoServer], { stdin: '' });
      expect(run.stderr).toContain("is inside the server's working directory. An agent that can write files there could change its own policy: make sure no tool");
    } finally {
      process.chdir(cwd);
    }
  });

  it('keeps compact files compact', async () => {
    const path = config('{"mcpServers":{"a":{"command":"node","args":["a.js"]},"b":{"url":"http://x"}}}');
    const result = await cli(['wrap', path, '--command', '/bin/mcpspy', '--db', 'x.db', '--mocks', 'm.json']);
    expect(result.stdout).toMatch(/wrapped {2}a/);
    expect(result.stdout).toMatch(/skipped {2}b: /);
    expect(result.stdout).toContain('Wrapped 1 server in');
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/^\{\n {2}"mcpServers"/);
    expect(text.endsWith('}')).toBe(true);
    const unwrapped = await cli(['unwrap', path, '--only', 'a']);
    expect(unwrapped.stdout).toContain('Unwrapped 1 server in');
  });

  it('adds a checked policy, by absolute path', async () => {
    const path = config('{"mcpServers":{"a":{"command":"node","args":["a.js"]}}}');
    const folder = dir();
    writeFileSync(join(folder, 'policy.json'), '{"default": "allow"}');
    const cwd = process.cwd();
    process.chdir(folder);
    try {
      expect((await cli(['wrap', path, '--policy', 'policy.json'])).code).toBe(0);
      writeFileSync(join(folder, 'broken.json'), '{"default": "never"}');
      const broken = await cli(['wrap', path, '--policy', 'broken.json']);
      expect(broken.code).toBe(2);
      expect(broken.stderr).toContain('broken.json: "default" must be "allow" or "deny"');
    } finally {
      process.chdir(cwd);
    }
    const args = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: { a: { args: string[] } } }).mcpServers.a.args;
    expect(args).toEqual(['run', '--name', 'a', '--policy', join(realpathSync(folder), 'policy.json'), '--', 'node', 'a.js']);
  });

  it('wraps several servers and says when there is nothing to do', async () => {
    const path = config('{"mcpServers":{"a":{"command":"node"},"b":{"command":"node"}}}');
    expect((await cli(['wrap', path])).stdout).toContain('Wrapped 2 servers');
    expect((await cli(['unwrap', path])).stdout).toContain('Unwrapped 2 servers');
    expect((await cli(['unwrap', path])).stdout).toContain('Nothing to unwrap in');
  });

  it('explains bad arguments and configs', async () => {
    expect((await cli(['wrap', 'a', 'b'])).stderr).toContain('wrap takes one config file');
    expect((await cli(['unwrap'])).stderr).toContain('no .mcp.json here');
    expect((await cli(['wrap', config('[1]')])).stderr).toMatch(/mcp\.json: /);
  });
});

describe('mcpspy ui', () => {
  it('serves the UI until stopped', async () => {
    const db = tmpDb();
    vi.mocked(resolveUiDir).mockReturnValueOnce(null);
    const result = await cli(['ui', '--port', '0', '--db', db, '--read-only']);
    expect(result.code).toBe(0);
    const url = /mcpspy UI on (\S+)/.exec(result.stdout)![1]!;
    expect(result.stdout).toContain(`(log: ${db})`);
    expect(result.stdout).toContain('Web UI assets not found');
    expect((await fetch(`${url}/api/sessions`)).status).toBe(200);
    const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
    result.signals.get('SIGINT')!();
    expect(await exited).toBe(0);
  });

  it('explains a port in use, and rethrows other errors', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const result = await cli(['ui', '--port', String(port), '--db', tmpDb()]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`port ${port} is in use`);
    } finally {
      blocker.close();
    }
    await expect(cli(['ui', '--port', '70000', '--db', tmpDb()])).rejects.toThrow();
  });

  it('prunes by MCPSPY_RETENTION when it starts', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      for (const daysAgo of [40, 50]) {
        const started = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
        const id = store.createSession({ name: 'old', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: started });
        store.endSession(id, { ended_at: started, exit_code: 0, exit_signal: null });
      }
    });
    vi.stubEnv('MCPSPY_RETENTION', '30d');
    const captured = capture();
    let signals: Map<string, () => void>;
    try {
      const { main } = await import('../src/cli.js');
      await main(['ui', '--port', '0', '--db', db]);
      await vi.waitFor(() => expect(captured.stdout).toContain('Pruned 2 old sessions (MCPSPY_RETENTION=30d)'));
      signals = captured.signals;
    } finally {
      captured.restore();
    }
    const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
    signals.get('SIGTERM')!();
    await exited;

    // One old session, then nothing left to prune.
    withStore(db, (store) => {
      const started = Date.now() - 40 * 24 * 60 * 60 * 1000;
      const id = store.createSession({ name: 'old', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: started });
      store.endSession(id, { ended_at: started, exit_code: 0, exit_signal: null });
    });
    const again = capture();
    try {
      const { main } = await import('../src/cli.js');
      await main(['ui', '--port', '0', '--db', db]);
      await vi.waitFor(() => expect(again.stdout).toContain('Pruned 1 old session (MCPSPY_RETENTION=30d)'));
      const third = await cli(['ui', '--port', '0', '--db', db]);
      expect(third.stdout).not.toContain('Pruned');
      signals = new Map([...again.signals, ['third', third.signals.get('SIGINT')!]]);
    } finally {
      again.restore();
    }
    const stopped = new Promise<void>((resolve) => {
      let count = 0;
      vi.spyOn(process, 'exit').mockImplementation((() => ++count === 2 && resolve()) as never);
    });
    signals.get('SIGINT')!();
    signals.get('third')!();
    await stopped;
  });

  it('reports a failed retention prune without stopping', async () => {
    vi.stubEnv('MCPSPY_RETENTION', '30d');
    vi.spyOn(Store.prototype, 'sessionFootprints').mockImplementation(() => {
      throw new Error('table is locked');
    });
    const result = await cli(['ui', '--port', '0', '--db', tmpDb()]);
    expect(result.stderr).toBe('[mcpspy] pruning failed: table is locked\n');
    const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
    result.signals.get('SIGINT')!();
    await exited;
  });

  it('rejects a bad MCPSPY_RETENTION', async () => {
    vi.stubEnv('MCPSPY_RETENTION', 'forever');
    const result = await cli(['ui', '--port', '0', '--db', tmpDb()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('MCPSPY_RETENTION: ');
  });

  it('finds the built UI next to the CLI', async () => {
    const root = dir();
    mkdirSync(join(root, 'dist', 'ui'), { recursive: true });
    writeFileSync(join(root, 'dist', 'ui', 'index.html'), '');
    mkdirSync(join(root, 'src'));
    const actual = await vi.importActual<typeof import('../src/ui-dir.js')>('../src/ui-dir.js');
    expect(actual.resolveUiDir(pathToFileURL(join(root, 'src', 'cli.js')).href)).toBe(join(root, 'dist', 'ui') + '/');
    expect(actual.resolveUiDir(pathToFileURL(join(root, 'dist', 'cli.js')).href)).toBe(join(root, 'dist', 'ui') + '/');
    expect(actual.resolveUiDir(pathToFileURL(join(root, 'elsewhere', 'deep', 'cli.js')).href)).toBeNull();
  });
});

describe('numbers', () => {
  it('rejects ids that are not plain non-negative integers', async () => {
    for (const value of ['1.5', ' 1x', '99999999999999999999']) {
      expect((await cli(['show', value, '--db', tmpDb()])).stderr).toContain('message id must be a number');
    }
  });
});


describe('less common paths', () => {
  it('names the default log when it cannot be opened', async () => {
    const file = join(dir(), 'file');
    writeFileSync(file, '');
    vi.stubEnv('MCPSPY_DB', join(file, 'log.db'));
    const result = await cli(['run', '--', process.execPath, echoServer], { stdin: line(initialize) });
    expect(result.stderr).toContain(`can't open the log at ${join(file, 'log.db')}`);
  });

  it('proxies HTTP with mocks, reporting reloads', async () => {
    const fixture = await startHttpFixture();
    const mocks = join(dir(), 'mocks.json');
    writeFileSync(mocks, JSON.stringify({ rules: [{ match: { tool: 'echo' }, text: 'mocked' }] }));
    try {
      for (const name of [[], ['--name', 'web']]) {
        const result = await cli(['proxy', fixture.url, '--port', '0', '--db', tmpDb(), '--mocks', mocks, ...name]);
        const url = /Point your agent at (\S+)/.exec(result.stderr)![1]!;
        const captured = capture();
        try {
          writeFileSync(mocks, '{ broken');
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'real' } } }),
          });
          await response.text();
          await vi.waitFor(() => expect(captured.stderr).toContain('[mcpspy] kept previous mock rules;'));
          writeFileSync(mocks, JSON.stringify({ rules: [{ match: { tool: 'echo' }, text: 'mocked' }] }));
        } finally {
          captured.restore();
        }
        const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
        result.signals.get('SIGINT')!();
        await exited;
        vi.restoreAllMocks();
      }
    } finally {
      await fixture.close();
    }
  });

  it('adds rules to a file without rules, and skips tools it already has', async () => {
    const db = tmpDb();
    await record(db, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'a' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'b' } } },
    ]);
    const ids = withStore(db, (store) => store.messagesAfter(0).filter((message) => message.method === 'tools/call' && message.direction === 'client').map((message) => String(message.id)));
    const file = join(dir(), 'mocks.json');
    writeFileSync(file, '{}');
    expect((await cli(['mock', 'add', file, ...ids, '--db', db])).code).toBe(0);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { tools: unknown[]; rules: unknown[] };
    expect(saved.tools).toHaveLength(1);
    expect(saved.rules).toHaveLength(2);
  });

  it('copes with a tool list that has no tools', async () => {
    const db = tmpDb();
    const call = withStore(db, (store) => {
      const session = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
      const base = { session_id: session, ts: Date.now(), size: 1, problem: null, latency_ms: 1, tokens: null, token_detail: null, issues: null };
      const list = store.insertMessage({ ...base, direction: 'client', kind: 'request', method: 'tools/list', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', request_id: null });
      store.insertMessage({ ...base, direction: 'server', kind: 'response', method: 'tools/list', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"result":{}}', request_id: list });
      const id = store.insertMessage({ ...base, direction: 'client', kind: 'request', method: 'tools/call', rpc_id: '2', payload: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x"}}', request_id: null });
      store.insertMessage({ ...base, direction: 'server', kind: 'response', method: 'tools/call', rpc_id: '2', payload: '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}', request_id: id });
      return id;
    });
    const file = join(dir(), 'mocks.json');
    expect((await cli(['mock', 'add', file, String(call), '--db', db])).code).toBe(0);
  });

  it('tails requests, notifications and replies to subjectless requests', async () => {
    const db = tmpDb();
    await record(db, [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } }]);
    const result = await cli(['tail', '--db', db]);
    expect(result.stdout).toContain('notifications/initialized');
    expect(result.stdout).toMatch(/ping/);
  });

  it('shows calls without timing', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      const session = store.createSession({ name: 'x', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
      const base = { session_id: session, ts: Date.now(), size: 1, problem: null, latency_ms: null, tokens: null, token_detail: null, issues: null };
      const id = store.insertMessage({ ...base, direction: 'client', kind: 'request', method: 'tools/call', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t"}}', request_id: null });
      store.insertMessage({ ...base, direction: 'server', kind: 'response', method: 'tools/call', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"result":{"content":[]}}', request_id: id });
    });
    expect((await cli(['tokens', '--db', db])).stdout).toMatch(/t\s+1\s+0\s+-\s+-\s+≈0 \/ ≈0/);
  });

  it('replays a request recorded over HTTP', async () => {
    const fixture = await startHttpFixture();
    const db = tmpDb();
    try {
      const proxy = await cli(['proxy', fixture.url, '--port', '0', '--db', db, '--name', 'web']);
      const url = /Point your agent at (\S+)/.exec(proxy.stderr)![1]!;
      const post = (body: object, session?: string) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
          body: JSON.stringify(body),
        });
      const init = await post(initialize);
      await init.text();
      const session = init.headers.get('mcp-session-id')!;
      await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'web' } } }, session)).text();
      const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
      proxy.signals.get('SIGINT')!();
      await exited;
      vi.restoreAllMocks();

      const call = withStore(db, (store) => store.messagesAfter(0).find((message) => message.method === 'tools/call' && message.direction === 'client')!.id);
      const result = await cli(['replay', String(call), '--db', db]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('(connect + initialize)');
    } finally {
      await fixture.close();
    }
  });

  it('prunes unnamed sessions and needs a rule', async () => {
    const db = tmpDb();
    withStore(db, (store) => {
      const started = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const id = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: started });
      store.endSession(id, { ended_at: started, exit_code: 0, exit_signal: null });
    });
    expect((await cli(['prune', '--older-than', '30d', '--dry-run', '--db', db])).stdout).toMatch(/#1\s+-\s+last active/);
    const none = await cli(['prune', '--db', db]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('prune needs --older-than <age>, --keep <n> or --max-size <size> (or --vacuum on its own)');
  });

  it('prunes by MCPSPY_RETENTION daily', async () => {
    // Runs the daily callback directly: advancing fake timers by a day would also run the UI's 250 ms poll ~350,000 times.
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const db = tmpDb();
    vi.stubEnv('MCPSPY_RETENTION', '30d');
    const result = await cli(['ui', '--port', '0', '--db', db]);
    const daily = setInterval.mock.calls.find(([, ms]) => ms === 24 * 60 * 60 * 1000)![0] as () => void;
    setInterval.mockRestore();
    withStore(db, (store) => {
      const started = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const id = store.createSession({ name: null, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: started });
      store.endSession(id, { ended_at: started, exit_code: 0, exit_signal: null });
    });
    const captured = capture();
    try {
      daily();
      await vi.waitFor(() => expect(captured.stdout).toContain('Pruned 1 old session'));
    } finally {
      captured.restore();
    }
    const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
    result.signals.get('SIGINT')!();
    await exited;
  });

  it('wraps in a dry run, keeps a final newline and rejects JSON with comments', async () => {
    const path = join(dir(), 'mcp.json');
    const original = '{\n\t"mcpServers": { "a": { "command": "node" } }\n}\n';
    writeFileSync(path, original);
    expect((await cli(['wrap', path, '--dry-run'])).stdout).toContain(`Dry run: ${path} is unchanged.`);
    expect(readFileSync(path, 'utf8')).toBe(original);
    await cli(['wrap', path]);
    expect(readFileSync(path, 'utf8')).toMatch(/^\{\n\t"mcpServers"[\s\S]*\}\n$/);
    writeFileSync(path, '{ // no\n}');
    const bad = await cli(['wrap', path]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("isn't plain JSON, which wrap needs");
  });

  it('counts a single warning', async () => {
    const { db, echo } = await seeded();
    withStore(db, (store) => store.setIssues(echo, JSON.stringify([{ severity: 'warning', path: 'x', message: 'hm' }])));
    const result = await cli(['validate', '--db', db]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/0 errors, 1 warning in 1 message\n$/);
  });

  it('serves the UI from the default log, with assets', async () => {
    const db = tmpDb();
    vi.stubEnv('MCPSPY_DB', db);
    vi.mocked(resolveUiDir).mockReturnValueOnce(dir());
    const result = await cli(['ui', '--port', '0']);
    expect(result.stdout).toContain(`(log: ${db})`);
    expect(result.stdout).not.toContain('Web UI assets not found');
    const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
    result.signals.get('SIGINT')!();
    await exited;
  });
});
