import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runStdioProxy } from '../src/proxy/stdio.js';
import type { Store } from '../src/store.js';

export const echoServer = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

/** Records a session as an agent would, through the proxy. Returns message ids by request id. */
export async function recordSession(store: Store, env: NodeJS.ProcessEnv = process.env) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop()!;
    for (const part of parts) if (part) lines.push(JSON.parse(part) as Record<string, unknown>);
  });
  const done = runStdioProxy({ command: process.execPath, args: [echoServer], store, name: 'echo', env, input, output, errorOutput: new PassThrough(), forwardSignals: [] });

  const send = (message: object) => input.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (predicate: (line: Record<string, unknown>) => boolean) => {
    for (;;) {
      const found = lines.find(predicate);
      if (found) return found;
      await once(output, 'data');
    }
  };

  send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 'agent', version: '9' } } });
  await waitFor((line) => line.id === 0);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'roots' } });
  const rootsRequest = await waitFor((line) => line.method === 'roots/list');
  send({ jsonrpc: '2.0', id: rootsRequest.id, result: { roots: [{ uri: 'file:///work', name: 'work' }] } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'env', arguments: { key: 'MY_API_KEY' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'time' } });
  await waitFor((line) => line.id === 4);
  input.end();
  const { sessionId } = await done;

  const requests = store.messagesAfter(0, { sessionId }).filter((m) => m.kind === 'request' && m.direction === 'client');
  const byRpcId = (id: number) => requests.find((m) => m.rpc_id === String(id))!.id;
  return { sessionId, echo: byRpcId(1), roots: byRpcId(2), env: byRpcId(3), time: byRpcId(4), initialize: byRpcId(0) };
}

