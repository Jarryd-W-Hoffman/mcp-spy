import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockEngine, type MockFile } from '../src/mocks.js';
import { parsePolicy, PolicyEngine, type PolicyFile } from '../src/policy.js';
import { POLICY_ERROR } from '../src/proxy/interceptor.js';
import { runStdioProxy } from '../src/proxy/stdio.js';
import { Store } from '../src/store.js';
import { echoServer } from './helpers.js';

type Line = Record<string, unknown> & { id?: unknown; result?: Record<string, unknown>; error?: Record<string, unknown> };

describe('stdio proxy with a policy', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  function start(file: PolicyFile | null, mocks?: MockFile) {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const lines: Line[] = [];
    let warnings = '';
    errorOutput.on('data', (chunk: Buffer) => (warnings += chunk.toString()));
    let buffer = '';
    output.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop()!;
      for (const part of parts) lines.push(JSON.parse(part) as Line);
    });
    const done = runStdioProxy({
      command: process.execPath,
      args: [echoServer],
      store,
      name: 'echo',
      input,
      output,
      errorOutput,
      forwardSignals: [],
      policy: file ? new PolicyEngine(null, 'echo', process.cwd(), () => {}, parsePolicy(JSON.stringify(file), '/')) : undefined,
      mocks: mocks ? new MockEngine(null, 'echo', () => {}, mocks) : undefined,
    });
    return {
      lines,
      warnings: () => warnings,
      send: (message: object | string) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
      async reply(id: unknown): Promise<Line> {
        for (;;) {
          const found = lines.find((line) => line.id === id && !('method' in line));
          if (found) return found;
          await once(output, 'data');
        }
      },
      async end() {
        input.end();
        return done;
      },
    };
  }
  const tool = (id: number, name: string, args: object = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const text = (line: Line) => (line.result!.content as { text: string }[])[0]!.text;
  const replyRules = () =>
    store
      .messagesAfter(0)
      .filter((message) => message.direction === 'server' && message.mock !== null)
      .map((message) => [message.rpc_id, message.mock]);

  it('answers refused calls itself, forwards allowed ones and hides forbidden tools', async () => {
    const proxy = start({
      rules: [
        { name: 'no writes', tool: 'write*', deny: 'writes need review' },
        { tool: 'echo', where: { text: { notMatch: 'rm -rf' } }, allow: true },
        { tool: 'roots', allow: true },
        { method: 'resources/read', deny: 'no resources here' },
      ],
    });
    proxy.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    await proxy.reply(0);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((await proxy.reply(1)).result!.tools).toEqual([expect.objectContaining({ name: 'echo' }), expect.objectContaining({ name: 'roots' })]);

    proxy.send(tool(2, 'write_file', { path: '/etc/passwd' }));
    const refused = await proxy.reply(2);
    expect(refused.result).toEqual({ content: [{ type: 'text', text: 'Blocked by mcpspy policy: writes need review' }], isError: true });
    proxy.send(tool(3, 'echo', { text: 'hi' }));
    expect(text(await proxy.reply(3))).toBe('hi');
    proxy.send(tool(4, 'echo', { text: 'rm -rf /' }));
    expect(text(await proxy.reply(4))).toBe('Blocked by mcpspy policy: "text" is not allowed for echo');
    proxy.send({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'file:///a' } });
    expect((await proxy.reply(5)).error).toEqual({ code: POLICY_ERROR, message: 'Blocked by mcpspy policy: no resources here' });

    // Server requests and the agent's answers to them still flow.
    proxy.send(tool(6, 'roots'));
    const ask = await (async () => {
      for (;;) {
        const found = proxy.lines.find((line) => line.method === 'roots/list');
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    proxy.send({ jsonrpc: '2.0', id: ask.id, result: { roots: [] } });
    expect(text(await proxy.reply(6))).toBe('{"roots":[]}');
    await proxy.end();

    expect(proxy.lines.filter((line) => line.id === 2)).toHaveLength(1);
    expect(replyRules()).toEqual([
      ['1', 'policy: hid slow, time, env'],
      ['2', 'policy: no writes'],
      ['4', 'policy: default'],
      ['5', 'policy: rules[3]'],
    ]);
    expect(proxy.warnings()).toContain('[mcpspy] policy denied tools/call write_file (no writes): writes need review\n');
    expect(proxy.warnings()).toContain('[mcpspy] policy denied resources/read (rules[3]): no resources here\n');
  });

  it('forwards the message it checked, not the bytes it was sent', async () => {
    const proxy = start({ rules: [{ tool: 'echo', allow: true }] });
    // JSON.parse keeps the last of duplicate keys; a server that kept the first would run "write".
    proxy.send('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write","name":"echo","arguments":{"text":"checked"}}}');
    expect(text(await proxy.reply(1))).toBe('checked');
    proxy.send('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","name":"write"}}');
    expect(text(await proxy.reply(2))).toBe('Blocked by mcpspy policy: no rule allows write');
    await proxy.end();
  });

  it('refuses batches, drops lines that are not JSON and swallows refused notifications', async () => {
    const proxy = start({ default: 'allow', rules: [{ tool: 'secret', deny: 'never' }] });
    proxy.send('this is not json');
    proxy.send([tool(1, 'echo', { text: 'a' }), { jsonrpc: '2.0', method: 'notifications/initialized' }, 7, tool(2, 'echo')]);
    proxy.send([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    proxy.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'secret' } });
    proxy.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    proxy.send({ jsonrpc: '2.0', id: 3, result: {} });
    proxy.send(tool(4, 'echo', { text: 'still alive' }));
    expect(text(await proxy.reply(4))).toBe('still alive');
    await proxy.end();

    const batch = proxy.lines.find(Array.isArray) as unknown as Line[];
    expect(batch.map((reply) => [reply.id, reply.error!.code])).toEqual([
      [1, POLICY_ERROR],
      [2, POLICY_ERROR],
    ]);
    expect(proxy.lines.filter((line) => !Array.isArray(line))).toHaveLength(1);
    expect(proxy.warnings()).toContain('[mcpspy] policy: dropped a line from the agent that is not JSON\n');
    expect(proxy.warnings().match(/refused a batch/g)).toHaveLength(2);
    expect(proxy.warnings()).toContain('[mcpspy] policy denied tools/call secret (rules[0]): never\n');
  });

  it('redacts results and replaces those over the size limit', async () => {
    const proxy = start({ default: 'allow', results: { redact: ['ghp_\\w+'], maxBytes: 200 } });
    proxy.send(tool(1, 'echo', { text: 'token ghp_abc123' }));
    expect(text(await proxy.reply(1))).toBe('token [redacted by policy]');
    proxy.send(tool(2, 'echo', { text: 'x'.repeat(300) }));
    expect(text(await proxy.reply(2))).toMatch(/^Blocked by mcpspy policy: the result was \d+ bytes, over the limit of 200\.$/);
    proxy.send(tool(3, 'echo', { text: 'plain' }));
    expect(text(await proxy.reply(3))).toBe('plain');
    proxy.send(tool(4, 'nope'));
    expect((await proxy.reply(4)).error).toMatchObject({ message: 'Unknown tool: nope' });
    await proxy.end();
    expect(replyRules()).toEqual([
      ['1', 'policy: result redacted'],
      ['2', 'policy: result too large'],
    ]);
  });

  it('leaves tool lists alone when every tool is allowed', async () => {
    const proxy = start({ default: 'allow' });
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((await proxy.reply(1)).result!.tools).toHaveLength(5);
    await proxy.end();
    expect(replyRules()).toEqual([]);
  });

  it('checks requests before mock rules, and filters mock tools too', async () => {
    const proxy = start(
      { rules: [{ tool: 'weather', allow: true }, { tool: 'echo', allow: true }] },
      {
        tools: [
          { name: 'weather', inputSchema: { type: 'object' } },
          { name: 'stocks', inputSchema: { type: 'object' } },
        ],
        rules: [
          { name: 'sunny', match: { tool: 'weather' }, text: 'sunny' },
          { name: 'ticker', match: { tool: 'stocks' }, text: 'up' },
        ],
      },
    );
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(((await proxy.reply(1)).result!.tools as { name: string }[]).map((t) => t.name)).toEqual(['echo', 'weather']);
    proxy.send(tool(2, 'weather'));
    expect(text(await proxy.reply(2))).toBe('sunny');
    proxy.send(tool(3, 'stocks'));
    expect(text(await proxy.reply(3))).toBe('Blocked by mcpspy policy: no rule allows stocks');
    await proxy.end();
  });

  it('sends requests a mock rule is delaying before ending the server input', async () => {
    const proxy = start(null, { rules: [{ name: 'slowly', match: { tool: 'echo' }, passthrough: true, delayMs: 60 }] });
    proxy.send(tool(1, 'echo', { text: 'late' }));
    await proxy.end();
    expect(text(proxy.lines.find((line) => line.id === 1)!)).toBe('late');
  });
});
