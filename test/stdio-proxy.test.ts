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
