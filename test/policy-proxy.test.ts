import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockEngine, type MockFile } from '../src/mocks.js';
import { parsePolicy, PolicyEngine, type PolicyFile } from '../src/policy.js';
import { Interceptor, POLICY_ERROR } from '../src/proxy/interceptor.js';
import { runStdioProxy } from '../src/proxy/stdio.js';
import { Store } from '../src/store.js';
import { echoServer } from './helpers.js';

type Line = Record<string, unknown> & { id?: unknown; result?: Record<string, unknown>; error?: Record<string, unknown> };

describe('redacting everything the server sends', () => {
  const setup = (results: object | null = { redact: ['sk-\\w+'], maxBytes: 300 }) => {
    const file = { rules: [{ tool: 'search', allow: true }, { tool: 'read', allow: true }], ...(results ? { results } : {}) };
    const interceptor = new Interceptor({
      mocks: null,
      policy: new PolicyEngine(null, 'echo', '/', () => {}, parsePolicy(JSON.stringify(file), '/')),
      toServer: () => {},
      toClient: () => {},
      recordReply: () => {},
      warn: () => {},
    });
    const from = (message: unknown) => {
      const { line, rule } = interceptor.fromServer(JSON.stringify(message));
      return { message: JSON.parse(line!) as unknown, rule };
    };
    return { interceptor, from };
  };

  it('redacts results, requests, notifications and errors, but never the envelope', () => {
    const { interceptor, from } = setup();
    interceptor.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 'sk-id', method: 'resources/read', params: { uri: 'file:///.env' } }));
    expect(from({ jsonrpc: '2.0', id: 'sk-id', result: { contents: [{ uri: 'file:///.env', text: 'KEY=sk-live1' }] } })).toEqual({
      message: { jsonrpc: '2.0', id: 'sk-id', result: { contents: [{ uri: 'file:///.env', text: 'KEY=[redacted by policy]' }] } },
      rule: 'policy: redacted',
    });
    expect(from({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'using sk-live2' } }).message).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'using [redacted by policy]' },
    });
    expect((from({ jsonrpc: '2.0', id: 's1', method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'sk-live3' } }] } }).message as { params: unknown }).params).toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: '[redacted by policy]' } }],
    });
    expect(from({ jsonrpc: '2.0', id: 9, error: { code: -1, message: 'bad key sk-live4' } }).message).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -1, message: 'bad key [redacted by policy]' } });
    expect(from({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })).toEqual({ message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, rule: null });
    expect(from('sk-not-an-object')).toEqual({ message: 'sk-not-an-object', rule: null });
  });

  it('shapes a batch from the server item by item', () => {
    const { interceptor, from } = setup();
    interceptor.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: {} } }));
    interceptor.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: {} } }));
    const { message, rule } = from([
      { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'x'.repeat(400) }] } },
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'sk-live5' }] } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
    ]);
    expect(rule).toBe('policy: result too large');
    expect(message).toEqual([
      { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: expect.stringContaining('over the limit of 300') }], isError: true } },
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '[redacted by policy]' }] } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
    ]);
  });

  it('leaves messages byte for byte alone when nothing matches or no redact rule is set', () => {
    for (const results of [null, { maxBytes: 10 }]) {
      const { interceptor } = setup(results);
      const line = '{"jsonrpc":"2.0","method":"notifications/message","params":{"data":"sk-live6"}}';
      expect(interceptor.fromServer(line)).toEqual({ line, rule: null, answers: [] });
      expect(interceptor.fromServer('[1,{"jsonrpc":"2.0","id":3,"result":{}}]')).toEqual({ line: '[1,{"jsonrpc":"2.0","id":3,"result":{}}]', rule: null, answers: [] });
    }
  });

  it('redacts a tool list, and still hides what the policy forbids', () => {
    const { interceptor, from } = setup();
    interceptor.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const tools = [{ name: 'search', description: 'uses sk-live7', inputSchema: { type: 'object' } }, { name: 'delete', inputSchema: { type: 'object' } }];
    expect(from({ jsonrpc: '2.0', id: 1, result: { tools } })).toEqual({
      message: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search', description: 'uses [redacted by policy]', inputSchema: { type: 'object' } }] } },
      rule: 'policy: hid delete',
    });
  });
});

describe('checking what the server sends the agent', () => {
  it('refuses requests and drops notifications a rule denies, in batches too', () => {
    const warnings: string[] = [];
    const file = {
      default: 'allow',
      rules: [
        { name: 'small samples', method: 'sampling/createMessage', where: { maxTokens: { max: 1000 } }, allow: true },
        { name: 'no sampling', method: 'sampling/createMessage', deny: 'too many tokens' },
        { name: 'quiet', method: 'notifications/message', deny: 'no logs' },
      ],
    };
    const interceptor = new Interceptor({
      mocks: null,
      policy: new PolicyEngine(null, 'echo', '/', () => {}, parsePolicy(JSON.stringify(file), '/')),
      toServer: () => {},
      toClient: () => {},
      recordReply: () => {},
      warn: (message) => warnings.push(message),
    });
    const sample = (id: number, maxTokens: number) => ({ jsonrpc: '2.0', id, method: 'sampling/createMessage', params: { messages: [], maxTokens } });
    const small = JSON.stringify(sample(1, 500));
    const refused = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, error: { code: POLICY_ERROR, message: 'Blocked by mcpspy policy: too many tokens' } });
    expect(interceptor.fromServer(small)).toEqual({ line: small, rule: null, answers: [] });
    expect(interceptor.fromServer(JSON.stringify(sample(2, 5000)))).toEqual({ line: null, rule: 'policy: no sampling', answers: [refused(2)] });
    expect(interceptor.fromServer(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } }))).toEqual({
      line: null,
      rule: 'policy: quiet',
      answers: [],
    });
    // A batch keeps what's allowed; the refused item is answered on its own.
    const batch = interceptor.fromServer(JSON.stringify([sample(3, 5000), sample(4, 10)]));
    expect([JSON.parse(batch.line!), batch.rule, batch.answers]).toEqual([[sample(4, 10)], 'policy: no sampling', [refused(3)]]);
    expect(warnings).toContain('policy denied notifications/message from the server (quiet): no logs');
  });
});

describe('stdio proxy with a policy', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  function start(file: PolicyFile | null, mocks?: MockFile, askTimeoutMs?: number) {
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
      askTimeoutMs,
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

  it('refuses requests the server sends the agent, answering the server itself', async () => {
    const proxy = start({ default: 'allow', rules: [{ name: 'no roots', method: 'roots/list', deny: 'roots are private' }] });
    proxy.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    await proxy.reply(0);
    proxy.send(tool(1, 'roots'));
    // The server got the refusal as its reply, and handed it back in the tool result.
    expect(JSON.parse(text(await proxy.reply(1)))).toEqual({ code: POLICY_ERROR, message: 'Blocked by mcpspy policy: roots are private' });
    expect(proxy.lines.some((line) => line.method === 'roots/list')).toBe(false);
    await proxy.end();
    expect(proxy.warnings()).toContain('[mcpspy] policy denied roots/list from the server (no roots): roots are private');
    const recorded = store.messagesAfter(0).filter((message) => message.method === 'roots/list');
    expect(recorded.map((message) => [message.direction, message.kind, message.mock])).toEqual([
      ['server', 'request', 'policy: no roots'],
      ['client', 'error', 'policy: no roots'],
    ]);
    expect(recorded[1]!.request_id).toBe(recorded[0]!.id);
  });

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
      ['4', 'policy: default deny'],
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

  describe('ask rules', () => {
    const policy: PolicyFile = { rules: [{ name: 'check echo', tool: 'echo', ask: 'Echo this?' }] };
    const initialize = (elicitation: boolean) => ({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: elicitation ? { elicitation: {} } : {} } });
    const asked = async (proxy: ReturnType<typeof start>, id: string) => {
      for (;;) {
        const found = proxy.lines.find((line) => line.id === id && line.method === 'elicitation/create');
        if (found) return found as Line & { params: { message: string } };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    it('holds the call, asks the agent, and forwards it once accepted', async () => {
      const proxy = start(policy);
      proxy.send(initialize(true));
      await proxy.reply(0);
      proxy.send(tool(1, 'echo', { text: 'approved' }));
      const ask = await asked(proxy, 'mcpspy-ask-1');
      expect(ask.params).toEqual({ message: 'Echo this?\n\nmcpspy is holding tools/call echo {"text":"approved"}. Accept to let it through.', requestedSchema: { type: 'object', properties: {} } });
      expect(proxy.lines.some((line) => line.id === 1)).toBe(false);
      proxy.send({ jsonrpc: '2.0', id: 'mcpspy-ask-1', result: { action: 'accept', content: {} } });
      expect(text(await proxy.reply(1))).toBe('approved');

      proxy.send(tool(2, 'echo', { text: 'x'.repeat(600) }));
      expect((await asked(proxy, 'mcpspy-ask-2')).params.message).toContain(`${'x'.repeat(490)}…`);
      proxy.send({ jsonrpc: '2.0', id: 'mcpspy-ask-2', result: { action: 'decline' } });
      expect(text(await proxy.reply(2))).toBe('Blocked by mcpspy policy: Echo this? (the user declined)');
      proxy.send(tool(3, 'echo'));
      await asked(proxy, 'mcpspy-ask-3');
      proxy.send({ jsonrpc: '2.0', id: 'mcpspy-ask-3', error: { code: -1, message: 'no UI' } });
      expect(text(await proxy.reply(3))).toBe('Blocked by mcpspy policy: Echo this? (the user declined)');
      // Answers to asks the proxy never made go to the server like any other response.
      proxy.send({ jsonrpc: '2.0', id: 'mcpspy-ask-99', result: {} });
      await proxy.end();
      expect(proxy.warnings()).toContain('[mcpspy] policy approved tools/call echo (check echo) after asking\n');
      expect(proxy.warnings()).toContain('[mcpspy] policy denied tools/call echo (check echo) after asking: the user declined\n');
    });

    it('asks about other methods too, several at a time', async () => {
      const proxy = start({ rules: [{ method: 'resources/read', ask: 'Read it?' }] });
      proxy.send(initialize(true));
      proxy.send({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'file:///a' } });
      proxy.send({ jsonrpc: '2.0', id: 2, method: 'resources/read' });
      expect((await asked(proxy, 'mcpspy-ask-1')).params.message).toContain('holding resources/read {"uri":"file:///a"}.');
      expect((await asked(proxy, 'mcpspy-ask-2')).params.message).toContain('holding resources/read {}.');
      proxy.send({ jsonrpc: '2.0', id: 'mcpspy-ask-2', result: { action: 'cancel' } });
      expect((await proxy.reply(2)).error).toMatchObject({ code: POLICY_ERROR, message: 'Blocked by mcpspy policy: Read it? (the user declined)' });
      proxy.send({ jsonrpc: '2.0', id: 'mcpspy-ask-1', result: { action: 'accept' } });
      expect((await proxy.reply(1)).error).toMatchObject({ message: 'Method not found' });
      await proxy.end();
    });

    it('refuses when nobody answers in time, or the agent goes away first', async () => {
      const proxy = start(policy, undefined, 40);
      proxy.send(initialize(true));
      proxy.send(tool(1, 'echo'));
      expect(text(await proxy.reply(1))).toBe('Blocked by mcpspy policy: Echo this? (no answer in time)');
      proxy.send(tool(2, 'echo'));
      await asked(proxy, 'mcpspy-ask-2');
      await proxy.end();
      expect(text(proxy.lines.find((line) => line.id === 2)!)).toBe('Blocked by mcpspy policy: Echo this? (the agent closed its input before answering)');
    });

    it("refuses when the agent can't be asked, and drops asked-about notifications", async () => {
      const proxy = start(policy);
      proxy.send(tool(1, 'echo'));
      expect(text(await proxy.reply(1))).toBe("Blocked by mcpspy policy: needs approval (Echo this?), but the agent can't be asked");
      proxy.send(initialize(false));
      proxy.send({ jsonrpc: '2.0', id: 2, method: 'initialize' });
      proxy.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo' } });
      proxy.send(tool(3, 'echo'));
      expect(text(await proxy.reply(3))).toContain("but the agent can't be asked");
      await proxy.end();
      expect(proxy.lines.filter((line) => line.method === 'elicitation/create')).toEqual([]);
    });
  });

  it('sends requests a mock rule is delaying before ending the server input', async () => {
    const proxy = start(null, { rules: [{ name: 'slowly', match: { tool: 'echo' }, passthrough: true, delayMs: 60 }] });
    proxy.send(tool(1, 'echo', { text: 'late' }));
    await proxy.end();
    expect(text(proxy.lines.find((line) => line.id === 1)!)).toBe('late');
  });
});

describe('asking, and cancellation', () => {
  const setup = (askTimeoutMs = 60_000) => {
    const toServer: unknown[] = [];
    const toClient: Record<string, unknown>[] = [];
    const policy = new PolicyEngine(null, 'echo', '/', () => {}, parsePolicy(JSON.stringify({ rules: [{ name: 'deploys', tool: 'deploy', ask: 'Deploy?' }] }), '/'));
    const interceptor = new Interceptor({
      mocks: null,
      policy,
      toServer: (line) => toServer.push(JSON.parse(line)),
      toClient: (line) => toClient.push(JSON.parse(line) as Record<string, unknown>),
      recordReply: () => {},
      warn: () => {},
      askTimeoutMs,
    });
    const send = (message: object) => interceptor.fromClient(JSON.stringify({ jsonrpc: '2.0', ...message }));
    send({ id: 0, method: 'initialize', params: { capabilities: { elicitation: {} } } });
    send({ id: 7, method: 'tools/call', params: { name: 'deploy', arguments: {} } });
    return { toServer, toClient, send, interceptor };
  };

  it('drops a held call the agent cancels, so a later accept runs nothing', () => {
    const { toServer, toClient, send } = setup();
    send({ method: 'notifications/cancelled', params: { requestId: 7, reason: 'user hit stop' } });
    expect(toClient.at(-1)).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'mcpspy-ask-1', reason: 'the agent cancelled it' } });
    send({ id: 'mcpspy-ask-1', result: { action: 'accept' } });
    // Only initialize reached the server; the held call got no reply, as cancelled requests don't.
    expect(toServer).toEqual([expect.objectContaining({ method: 'initialize' })]);
    expect(toClient.some((message) => message.id === 7)).toBe(false);
    // Cancelling something that isn't held goes to the server as usual.
    send({ method: 'notifications/cancelled', params: { requestId: 99 } });
    send({ method: 'notifications/cancelled' });
    expect(toServer).toHaveLength(3);
  });

  it('tells the agent when an ask times out, and drops a late answer', async () => {
    const { toServer, toClient, send } = setup(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(toClient.slice(-2)).toEqual([
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'mcpspy-ask-1', reason: 'no answer in time' } },
      expect.objectContaining({ id: 7, result: expect.objectContaining({ isError: true }) }),
    ]);
    send({ id: 'mcpspy-ask-1', result: { action: 'accept' } });
    expect(toServer).toHaveLength(1);
    // Dropped once: the same id again is someone else's to answer.
    send({ id: 'mcpspy-ask-1', result: {} });
    expect(toServer).toHaveLength(2);
  });
});
