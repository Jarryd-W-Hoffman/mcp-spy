import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStdioProxy } from '../src/proxy/stdio.js';
import { Store } from '../src/store.js';

const server = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

function harness(store: Store, serverArgs: string[] = [], command = process.execPath) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let stdout = '';
  let stderr = '';
  output.on('data', (chunk) => (stdout += chunk));
  errorOutput.on('data', (chunk) => (stderr += chunk));

  const done = runStdioProxy({
    command,
    args: [server, ...serverArgs],
    store,
    name: 'echo',
    input,
    output,
    errorOutput,
    forwardSignals: [],
  });

  const send = (message: object) => input.write(JSON.stringify(message) + '\n');
  const waitForLines = async (count: number) => {
    while (stdout.split('\n').filter(Boolean).length < count) await once(output, 'data');
  };

  return { input, done, send, waitForLines, stdout: () => stdout, stderr: () => stderr };
}

describe('runStdioProxy when the log fails', () => {
  // The agent started this process to reach its server; a broken log must not stop that.
  it('still proxies, without recording, when the session cannot be written', async () => {
    const broken = new Store(':memory:');
    broken.close();
    const proxy = harness(broken);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await proxy.waitForLines(1);
    proxy.input.end();

    const { exitCode } = await proxy.done;
    expect(exitCode).toBe(0);
    expect(JSON.parse(proxy.stdout().trim())).toMatchObject({ id: 1, result: { serverInfo: { name: 'echo-server' } } });
    expect(proxy.stderr()).toContain('[mcpspy] not recording this session');
  });
});

describe('runStdioProxy redaction', () => {
  it('forwards secrets untouched but records them redacted, command line included', async () => {
    const store = new Store(':memory:');
    const proxy = harness(store, ['--api-key=ghp_0123456789abcdefghijABCDEFGHIJ012345', '--token', 'plainsecret']);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: { ms: 1, text: 'password=hunter2 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' } } });
    await proxy.waitForLines(1);
    proxy.input.end();
    const { sessionId } = await proxy.done;

    expect(proxy.stdout()).toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
    const recorded = JSON.stringify([store.getSession(sessionId), store.messagesAfter(0, { sessionId })]);
    expect(recorded).not.toMatch(/ghp_0123|sk-ant-api03|plainsecret/);
    expect(recorded).toContain('[REDACTED]');
    store.close();
  });
});

describe('runStdioProxy', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  it('forwards traffic unchanged and records both directions', async () => {
    const proxy = harness(store);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    proxy.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: { ms: 30, text: 'hi' } } });
    await proxy.waitForLines(2);
    proxy.input.end();

    const { sessionId, exitCode } = await proxy.done;
    expect(exitCode).toBe(0);

    const responses = proxy.stdout().trim().split('\n').map((line) => JSON.parse(line));
    expect(responses[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hi' }] } });
    expect(proxy.stderr()).toContain('echo-server: starting');

    // stderr interleaves with stdio unpredictably, so check it separately.
    const all = store.messagesAfter(0, { sessionId });
    expect(all.filter((m) => m.direction === 'stderr').map((m) => m.payload)).toEqual(['echo-server: starting']);

    const messages = all.filter((m) => m.direction !== 'stderr');
    expect(messages.map((m) => [m.direction, m.kind, m.method])).toEqual([
      ['client', 'request', 'initialize'],
      ['client', 'notification', 'notifications/initialized'],
      ['client', 'request', 'tools/call'],
      ['server', 'response', 'initialize'],
      ['server', 'response', 'tools/call'],
    ]);
    expect(messages[4]!.latency_ms).toBeGreaterThanOrEqual(25);

    const session = store.getSession(sessionId)!;
    expect(session).toMatchObject({ name: 'echo', transport: 'stdio', exit_code: 0 });
    expect(session.pid).toBeGreaterThan(0);
    expect(session.ended_at).not.toBeNull();
  });

  it('records non-JSON server output as invalid but still forwards it', async () => {
    const proxy = harness(store, ['--noisy']);
    await proxy.waitForLines(1);
    proxy.input.end();
    const { sessionId } = await proxy.done;

    expect(proxy.stdout()).toBe('this is not json\n');
    const invalid = store.messagesAfter(0, { sessionId }).find((m) => m.kind === 'invalid');
    expect(invalid).toMatchObject({ direction: 'server', payload: 'this is not json' });
  });

  it('reports a missing server command with exit code 127', async () => {
    const proxy = harness(store, [], '/definitely/not/a/real/binary');
    const { sessionId, exitCode } = await proxy.done;
    expect(exitCode).toBe(127);
    expect(proxy.stderr()).toContain('failed to start');
    expect(store.getSession(sessionId)!.ended_at).not.toBeNull();
  });
});

describe('runStdioProxy edge cases', () => {
  const run = (store: Store, args: string[], options: Partial<Parameters<typeof runStdioProxy>[0]> = {}) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let stdout = '';
    let stderr = '';
    output.on('data', (chunk) => (stdout += chunk));
    errorOutput.on('data', (chunk) => (stderr += chunk));
    const done = runStdioProxy({ command: process.execPath, args, store, input, output, errorOutput, forwardSignals: [], ...options });
    return { input, done, stdout: () => stdout, stderr: () => stderr };
  };

  it('stops recording when the log breaks mid-session, and keeps proxying', async () => {
    const store = new Store(':memory:');
    const proxy = run(store, [server]);
    const { vi } = await import('vitest');
    const insert = vi.spyOn(store, 'insertMessage').mockImplementation(() => {
      throw new Error('disk full');
    });
    proxy.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    proxy.input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    await vi.waitFor(() => expect(proxy.stdout()).toContain('"id":2'));
    proxy.input.end();
    await proxy.done;
    insert.mockRestore();
    expect(proxy.stderr().match(/recording stopped, still proxying: disk full/g)).toHaveLength(1);
  });

  it('reports a server killed by a signal', async () => {
    const store = new Store(':memory:');
    const proxy = run(store, ['-e', "process.kill(process.pid, 'SIGKILL')"]);
    proxy.input.end();
    const { sessionId, exitCode } = await proxy.done;
    expect(exitCode).toBe(137);
    expect(store.getSession(sessionId)).toMatchObject({ exit_code: null, exit_signal: 'SIGKILL' });
  });

  it('exits 126 when the command cannot be run', async () => {
    const store = new Store(':memory:');
    const proxy = run(store, [], { command: import.meta.dirname });
    proxy.input.end();
    expect((await proxy.done).exitCode).toBe(126);
    expect(proxy.stderr()).toContain('[mcpspy] failed to start');
  });

  it('forwards signals to the server', async () => {
    const store = new Store(':memory:');
    const proxy = run(store, ['-e', "process.stdin.resume(); console.error('ready')"], { forwardSignals: ['SIGUSR2'] });
    const { vi } = await import('vitest');
    await vi.waitFor(() => expect(proxy.stderr()).toContain('ready'));
    process.emit('SIGUSR2', 'SIGUSR2');
    const { sessionId } = await proxy.done;
    expect(store.getSession(sessionId)!.exit_signal).toBe('SIGUSR2');
    expect(process.listenerCount('SIGUSR2')).toBe(0);
  });

  it('passes through lines mock rules cannot apply to', async () => {
    const store = new Store(':memory:');
    const { MockEngine } = await import('../src/mocks.js');
    const mocks = new MockEngine(null, null, () => {}, { rules: [{ match: { method: 'never/called' }, result: {} }] });
    const script = `
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        process.stdout.write('server says: ' + line + '\\n');
        process.stdout.write('[1,2]\\n');
        process.stdout.write('{"jsonrpc":"2.0","id":"x","method":"roots/list"}\\n');
      });`;
    const proxy = run(store, ['-e', script], { mocks });
    proxy.input.write('not json\n');
    proxy.input.write('[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n');
    proxy.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    proxy.input.write('{"jsonrpc":"2.0","id":"x","result":{}}\n');
    proxy.input.end();
    await proxy.done;
    for (const line of ['server says: not json', 'server says: [{"jsonrpc":"2.0","id":1,"method":"ping"}]', 'server says: {"jsonrpc":"2.0","method":"notifications/initialized"}', '[1,2]', '"method":"roots/list"']) {
      expect(proxy.stdout()).toContain(line);
    }
  });

  it('drops writes to a server that has exited', async () => {
    const store = new Store(':memory:');
    const { MockEngine } = await import('../src/mocks.js');
    const mocks = new MockEngine(null, null, () => {}, { rules: [] });
    const proxy = run(store, ['-e', "require('node:fs').closeSync(0); setTimeout(() => {}, 400)"], { mocks });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Spread out, so the first write's EPIPE has closed the pipe before the next.
    for (let i = 0; i < 5; i++) {
      proxy.input.write(`{"jsonrpc":"2.0","id":${i},"method":"ping","params":{"pad":"${'x'.repeat(5000)}"}}\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    proxy.input.end();
    expect((await proxy.done).exitCode).toBe(0);
  });
});
