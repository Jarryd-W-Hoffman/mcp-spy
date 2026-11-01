import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';
import { cli } from './cli-harness.js';
import { startOAuthFixture } from './fixtures/oauth-server.js';
import { echoServer } from './helpers.js';

// Opening a browser and calling the count_tokens API are replaced: tests must
// not launch programs on the desktop or send data to Anthropic.
const spawned = vi.hoisted(() => [] as { command: string; args: string[] }[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((command: string, args: string[], options: object) => {
      if (!['open', 'explorer', 'xdg-open'].includes(command)) return actual.spawn(command, args, options);
      spawned.push({ command, args });
      const child = Object.assign(new EventEmitter(), { unref: () => child });
      queueMicrotask(() => child.emit('error', new Error('no browser here')));
      return child;
    }) as typeof actual.spawn,
  };
});

const counter = vi.hoisted(() => ({
  toolDefinitions: vi.fn(async (tools: { name: string }[]) => ({
    total: 100 * tools.length + 7,
    overhead: 7,
    tools: tools.map((tool) => ({ name: tool.name, tokens: 100 })),
  })),
  toolResult: vi.fn(async (_name: string, content: unknown[], isError: boolean) => JSON.stringify(content).length + (isError ? 1000 : 0)),
}));
vi.mock('../src/exact.js', () => ({
  ExactCounter: class {
    constructor(readonly model: string) {}
    toolDefinitions = counter.toolDefinitions;
    toolResult = counter.toolResult;
  },
  describeApiError: (error: unknown) => `described: ${(error as Error).message}`,
}));

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'mcpspy-mocked-')), 'log.db');
const line = (message: object) => `${JSON.stringify(message)}\n`;
const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} };

afterEach(() => {
  vi.restoreAllMocks();
  counter.toolDefinitions.mockClear();
  counter.toolResult.mockClear();
});

describe('mcpspy ui --open', () => {
  it.each([
    ['linux', 'xdg-open'],
    ['darwin', 'open'],
    ['win32', 'explorer'],
  ])('opens the browser on %s with %s', async (platform, command) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
    spawned.length = 0;
    const result = await cli(['ui', '--port', '0', '--open', '--db', tmpDb()]);
    const url = /mcpspy UI on (\S+)/.exec(result.stdout)![1]!;
    expect(spawned).toEqual([{ command, args: [url] }]);
    await new Promise((resolve) => setImmediate(resolve));
    const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
    result.signals.get('SIGINT')!();
    await exited;
  });
});

describe('mcpspy proxy --login', () => {
  it('logs in in the browser before listening, and adds the token to every request', async () => {
    const fixture = await startOAuthFixture();
    spawned.length = 0;
    try {
      const running = cli(['proxy', fixture.url, '--port', '0', '--login', '--db', tmpDb()]);
      // The "browser" follows the login page back to mcpspy.
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      await (await fetch(spawned[0]!.args[0]!)).text();
      const result = await running;
      expect(result.stderr).toContain(`log in to ${fixture.origin} in your browser`);
      expect(result.stderr).toContain(`Logged in to ${fixture.origin}`);
      expect(result.stderr).toContain('Adding Authorization (from --login) to every request (never recorded)');

      const url = /Point your agent at (\S+)/.exec(result.stderr)![1]!;
      const reply = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
      expect(await reply.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { token: 'token-1' } });

      const exited = new Promise<number>((resolve) => vi.spyOn(process, 'exit').mockImplementation(((code: number) => resolve(code)) as never));
      result.signals.get('SIGINT')!();
      expect(await exited).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a second Authorization, and stops when the login fails or the port's taken", async () => {
    expect((await cli(['proxy', 'http://x/mcp', '--login', '-H', 'authorization: Bearer t'])).stderr).toContain('--login gets its own token; drop the Authorization header');
    const fixture = await startOAuthFixture();
    try {
      fixture.challenge = null;
      fixture.documents['/.well-known/oauth-protected-resource/mcp'] = undefined;
      const failed = await cli(['proxy', fixture.url, '--port', '0', '--login', '--db', tmpDb()]);
      expect([failed.code, failed.stderr]).toEqual([2, expect.stringContaining("couldn't log in: http://127.0.0.1:")]);

      // Logged in, but the proxy can't listen: the login's callback is closed too.
      fixture.challenge = `Bearer resource_metadata="${fixture.origin}/.well-known/oauth-protected-resource"`;
      fixture.documents['/.well-known/oauth-protected-resource'] = { resource: fixture.url, authorization_servers: [fixture.origin] };
      spawned.length = 0;
      const running = cli(['proxy', fixture.url, '--port', String(new URL(fixture.url).port), '--login', '--db', tmpDb()]);
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      await (await fetch(spawned[0]!.args[0]!)).text();
      const busy = await running;
      expect([busy.code, busy.stderr]).toEqual([2, expect.stringContaining('is in use; pick another with --port')]);
      const callback = new URL(spawned[0]!.args[0]!).searchParams.get('redirect_uri')!;
      await expect(fetch(callback)).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });
});

describe('mcpspy tokens --exact', () => {
  async function recordCalls(db: string) {
    const result = await cli(['run', '--db', db, '--name', 'echo', '--', process.execPath, echoServer], {
      stdin: [
        initialize,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'short' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'a much longer piece of text than before' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'tiny' } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } },
      ]
        .map(line)
        .join(''),
    });
    expect(result.code).toBe(0);
  }

  it('counts definitions and the largest result of each tool, caching the counts', async () => {
    const db = tmpDb();
    await recordCalls(db);
    const first = await cli(['tokens', '--exact', '--db', db, '--model', 'claude-test']);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain('Counting with the count_tokens API (claude-test)');
    expect(first.stdout).toContain('token counts are exact, claude-test');
    expect(first.stdout).toMatch(/Tool definitions: 507 tokens across 5 tools, sent with every model request \(includes 7 of tool-use preamble\)/);
    expect(first.stdout).toMatch(/echo .* \/ \d+ exact/);
    expect(counter.toolDefinitions).toHaveBeenCalledTimes(1);
    // The largest echo result, and the unknown tool's error.
    expect(counter.toolResult.mock.calls.map(([name, content, isError]) => [name, JSON.stringify(content), isError])).toEqual([
      ['echo', JSON.stringify([{ type: 'text', text: 'a much longer piece of text than before' }]), false],
      ['nope', JSON.stringify([{ type: 'text', text: 'Unknown tool: nope' }]), true],
    ]);

    const second = await cli(['tokens', '--exact', '--db', db, '--model', 'claude-test']);
    expect(second.stdout).toBe(first.stdout);
    expect(counter.toolDefinitions).toHaveBeenCalledTimes(1);
    expect(counter.toolResult).toHaveBeenCalledTimes(2);
  });

  it('counts results without a tool list, flagged and unnamed ones included', async () => {
    const db = tmpDb();
    const store = new Store(db);
    const session = store.createSession({ name: 'odd', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
    const base = { session_id: session, ts: Date.now(), size: 1, problem: null, latency_ms: null, tokens: 5, token_detail: null, issues: null };
    const request = store.insertMessage({ ...base, direction: 'client', kind: 'request', method: 'tools/call', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"flaky"}}', request_id: null });
    store.insertMessage({ ...base, direction: 'server', kind: 'response', method: 'tools/call', rpc_id: '1', payload: '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"failed"}],"isError":true}}', request_id: request });
    store.insertMessage({ ...base, direction: 'server', kind: 'error', method: 'tools/call', rpc_id: '2', payload: '{"jsonrpc":"2.0","id":2,"error":{"code":1}}', request_id: null });
    store.close();

    const result = await cli(['tokens', '--exact', '--db', db]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No tools/list recorded in this session.');
    expect(result.stdout).toMatch(/flaky\s+1\s+1\s+-\s+-/);
    expect(counter.toolDefinitions).not.toHaveBeenCalled();
    expect(counter.toolResult.mock.calls.map(([name, content, isError]) => [name, content, isError])).toEqual([
      ['flaky', [{ type: 'text', text: 'failed' }], true],
      ['(unknown)', [{ type: 'text', text: '' }], true],
    ]);
  });

  it('explains a failed count', async () => {
    const db = tmpDb();
    await recordCalls(db);
    counter.toolDefinitions.mockRejectedValueOnce(new Error('no credentials'));
    const result = await cli(['tokens', '--exact', '--db', db]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('mcpspy: exact count failed: described: no credentials');
  });
});
