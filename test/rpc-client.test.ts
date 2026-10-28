import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Recorder } from '../src/recorder.js';
import { RpcError, StdioRpcClient } from '../src/rpc-client.js';
import { Store } from '../src/store.js';

const server = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

describe('StdioRpcClient', () => {
  it('sends requests, matches responses and records the exchange', async () => {
    const store = new Store(':memory:');
    const sessionId = store.createSession({ name: 'r', transport: 'replay', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const client = new StdioRpcClient({ command: process.execPath, args: [server], recorder: new Recorder(store, sessionId) });

    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.message).toMatchObject({ result: { serverInfo: { name: 'echo-server' } } });
    client.notify('notifications/initialized');

    const call = await client.request('tools/call', { name: 'slow', arguments: { ms: 40, text: 'hi' } });
    expect(call.message).toMatchObject({ result: { content: [{ type: 'text', text: 'hi' }] } });
    expect(call.latencyMs).toBeGreaterThanOrEqual(35);

    expect(await client.close()).toEqual({ code: 0, signal: null });
    const kinds = store.messagesAfter(0, { sessionId }).filter((m) => m.direction !== 'stderr').map((m) => `${m.direction}:${m.kind}:${m.method}`);
    expect(kinds).toEqual([
      'client:request:initialize',
      'server:response:initialize',
      'client:notification:notifications/initialized',
      'client:request:tools/call',
      'server:response:tools/call',
    ]);
    store.close();
  });

  it('answers server-initiated requests with the handler', async () => {
    const client = new StdioRpcClient({
      command: process.execPath,
      args: [server],
      onServerRequest: (method) => (method === 'roots/list' ? { result: { roots: [{ uri: 'file:///work' }] } } : { error: { code: -1, message: 'no' } }),
    });
    await client.request('initialize', {});
    const reply = await client.request('tools/call', { name: 'roots' });
    expect(reply.message).toMatchObject({ result: { content: [{ text: '{"roots":[{"uri":"file:///work"}]}' }] } });
    await client.close();
  });

  it('rejects pending requests when the server cannot start or times out', async () => {
    const missing = new StdioRpcClient({ command: '/no/such/binary', args: [] });
    await expect(missing.request('initialize', {})).rejects.toThrow(RpcError);
    await missing.close();

    const silent = new StdioRpcClient({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    await expect(silent.request('initialize', {}, 100)).rejects.toThrow(/timed out after 100ms/);
    expect((await silent.close(100)).signal).toBe('SIGTERM');
  });
});
