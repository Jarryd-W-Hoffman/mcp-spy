import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../src/mocks.js';
import { runMockServer } from '../src/proxy/mock-server.js';
import { Store } from '../src/store.js';

describe('mock serve', () => {
  it('answers initialize, tools/list and calls from the mock file, and records the session', async () => {
    const store = new Store(':memory:');
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Record<string, unknown>[] = [];
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
    });
    const mocks = new MockEngine(null, null, () => {}, {
      server: { name: 'fake', version: '2.0.0' },
      tools: [{ name: 'add', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }],
      rules: [
        { match: { tool: 'add', arguments: { a: 1 } }, text: 'one' },
        { match: { method: 'prompts/list' }, result: { prompts: [] } },
        { match: { tool: 'add', arguments: { a: 3 } }, passthrough: true },
      ],
    });
    const done = runMockServer({ mocks, path: '/x/mocks.json', store, input, output });
    const send = (id: number, method: string, params?: unknown) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    send(1, 'initialize', { protocolVersion: '2025-03-26' });
    send(2, 'tools/list');
    send(3, 'tools/call', { name: 'add', arguments: { a: 1 } });
    send(4, 'tools/call', { name: 'add', arguments: { a: 2 } });
    send(5, 'tools/call', { name: 'missing' });
    send(6, 'prompts/list');
    send(7, 'resources/list');
    send(8, 'tools/call', { name: 'add', arguments: { a: 3 } });
    send(9, 'ping');
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.end();
    const { sessionId } = await done;

    const byId = new Map(lines.map((line) => [line.id, line]));
    expect(byId.get(1)).toMatchObject({ result: { protocolVersion: '2025-03-26', serverInfo: { name: 'fake', version: '2.0.0' } } });
    expect(byId.get(2)).toMatchObject({ result: { tools: [{ name: 'add' }] } });
    expect(byId.get(3)).toMatchObject({ result: { content: [{ text: 'one' }] } });
    expect(byId.get(4)).toMatchObject({ result: { isError: true, content: [{ text: 'No mock rule matches this call to add.' }] } });
    expect(byId.get(5)).toMatchObject({ error: { code: -32602 } });
    expect(byId.get(6)).toMatchObject({ result: { prompts: [] } });
    expect(byId.get(7)).toMatchObject({ error: { code: -32601 } });
    expect(byId.get(8)).toMatchObject({ error: { message: expect.stringMatching(/no real server/) } });
    expect(byId.get(9)).toMatchObject({ result: {} });

    const session = store.getSession(sessionId)!;
    expect(session).toMatchObject({ name: 'fake', transport: 'mock', exit_code: 0 });
    expect(JSON.parse(session.command)).toEqual(['mcpspy', 'mock', 'serve', '/x/mocks.json']);
    const responses = store.messagesAfter(0, { sessionId }).filter((m) => m.direction === 'server');
    expect(responses.every((m) => m.mock !== null && m.request_id !== null)).toBe(true);
    store.close();
  });
});

describe('mock serve edge cases', () => {
  it('ignores unreadable lines and notifications, drops by rule and passes on instructions', async () => {
    const store = new Store(':memory:');
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => (text += chunk.toString()));
    const mocks = new MockEngine(null, null, () => {}, { server: { instructions: 'Be nice' }, rules: [{ match: { tool: 'gone' }, drop: true }] });
    const done = runMockServer({ mocks, path: '/x.json', store, input, output });
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gone"}}\n');
    input.end();
    await done;
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'mcpspy-mock', version: '0.0.0' }, instructions: 'Be nice' } }]);
    store.close();
  });
});
