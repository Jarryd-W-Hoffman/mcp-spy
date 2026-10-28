import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockEngine, type MockFile } from '../src/mocks.js';
import { runStdioProxy } from '../src/proxy/stdio.js';
import { Store } from '../src/store.js';
import { echoServer } from './helpers.js';

const file: MockFile = {
  tools: [
    {
      name: 'weather',
      description: 'Mocked weather',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      outputSchema: { type: 'object', properties: { temperature: { type: 'number' } }, required: ['temperature'] },
    },
  ],
  rules: [
    { name: 'weather', match: { tool: 'weather' }, result: { content: [{ type: 'text', text: 'Sunny in {{arguments.city}}' }], structuredContent: { temperature: 24 } } },
    { name: 'hang', match: { tool: 'echo', arguments: { text: 'hang' } }, drop: true },
    { name: 'slow echo', match: { tool: 'echo', arguments: { text: 'slow' } }, passthrough: true, delayMs: 80 },
    { name: 'rate limit', match: { tool: 'echo', arguments: { text: 'limit' } }, error: { code: -32000, message: 'rate limited' }, delayMs: 30 },
  ],
};

describe('proxy with mocks', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  it('answers, drops, delays and patches according to the rules', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = new Map<unknown, Record<string, unknown>>();
    let buffer = '';
    output.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>;
        replies.set(message.id, message);
      }
    });
    const done = runStdioProxy({
      command: process.execPath,
      args: [echoServer],
      store,
      name: 'docs',
      input,
      output,
      errorOutput: new PassThrough(),
      forwardSignals: [],
      mocks: new MockEngine(null, 'docs', () => {}, file),
    });
    const send = (message: object) => input.write(`${JSON.stringify(message)}\n`);
    const waitFor = async (id: number) => {
      while (!replies.has(id)) await once(output, 'data');
      return replies.get(id)!;
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = (await waitFor(2)).result as { tools: { name: string }[] };
    expect(list.tools.map((tool) => tool.name)).toContain('weather');
    expect(list.tools.map((tool) => tool.name)).toContain('echo');

    const started = performance.now();
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'weather', arguments: { city: 'Perth' } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hang' } } });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { text: 'slow' } } });
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo', arguments: { text: 'limit' } } });
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { text: 'real' } } });

    expect(await waitFor(3)).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Sunny in Perth' }], structuredContent: { temperature: 24 } } });
    expect(await waitFor(7)).toMatchObject({ result: { content: [{ text: 'real' }] } });
    expect(await waitFor(6)).toEqual({ jsonrpc: '2.0', id: 6, error: { code: -32000, message: 'rate limited' } });
    expect(await waitFor(5)).toMatchObject({ result: { content: [{ text: 'slow' }] } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(75);
    input.end();
    const { sessionId } = await done;
    expect(replies.has(4)).toBe(false);

    const responses = store.messagesAfter(0, { sessionId }).filter((m) => m.direction === 'server' && m.kind !== 'log');
    const byRpcId = (id: number) => responses.find((m) => m.rpc_id === String(id));
    expect(byRpcId(2)?.mock).toBe('mock tools');
    expect(byRpcId(3)).toMatchObject({ mock: 'weather', method: 'tools/call', issues: null });
    expect(byRpcId(4)).toBeUndefined();
    expect(byRpcId(5)?.mock).toBe('slow echo');
    expect(byRpcId(6)).toMatchObject({ mock: 'rate limit', kind: 'error' });
    expect(byRpcId(7)?.mock).toBeNull();
    // The mocked tool's arguments are validated against its mock schema.
    const weatherCall = store.messagesAfter(0, { sessionId }).find((m) => m.rpc_id === '3' && m.direction === 'client');
    expect(weatherCall?.issues).toBeNull();
  });
});
