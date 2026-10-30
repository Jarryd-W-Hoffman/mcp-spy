import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replay, ReplayError, withArguments } from '../src/replay.js';
import { Store } from '../src/store.js';
import { recordSession } from './helpers.js';

describe('replay', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  it('replays a request in a new linked session and gets the same response', async () => {
    const recorded = await recordSession(store);
    const result = await replay({ store, messageId: recorded.echo });

    expect(result.original).toEqual({ requestId: recorded.echo, responseId: store.responseTo(recorded.echo)!.id, method: 'tools/call' });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.response).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hello' }] } });
    expect(result.startupMs).toBeGreaterThan(0);

    const session = store.getSession(result.sessionId)!;
    expect(session).toMatchObject({ name: 'echo', transport: 'replay', replay_of: recorded.sessionId, exit_code: 0 });
    // The agent's initialize is reused.
    const init = store.firstRequest(result.sessionId, 'initialize')!;
    expect(JSON.parse(init.payload).params.clientInfo).toEqual({ name: 'agent', version: '9' });
    // The replayed request and response are recorded and paired.
    expect(store.getMessage(result.runs[0]!.responseId!)).toMatchObject({ request_id: result.runs[0]!.requestId, method: 'tools/call' });
  });

  it('replays with edited arguments and repeats', async () => {
    const recorded = await recordSession(store);
    const params = withArguments(store.getMessage(recorded.echo)!, { text: 'edited' });
    const result = await replay({ store, messageId: recorded.echo, params, repeat: 3 });
    expect(result.runs).toHaveLength(3);
    expect(result.runs.map((run) => (run.response.result as { content: { text: string }[] }).content[0]!.text)).toEqual([
      'edited',
      'edited',
      'edited',
    ]);
  });

  it("validates replayed calls against the original session's tool list", async () => {
    const recorded = await recordSession(store);
    // recordSession never lists tools, so record a list in the original session first.
    store.insertMessage({
      session_id: recorded.sessionId, ts: 0, direction: 'server', kind: 'response', method: 'tools/list', rpc_id: '99',
      payload: JSON.stringify({ jsonrpc: '2.0', id: 99, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } }),
      size: 0, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null,
    });
    const result = await replay({ store, messageId: recorded.echo, params: { name: 'echo', arguments: { text: 5 } } });
    expect(JSON.parse(store.getMessage(result.runs[0]!.requestId!)!.issues!)).toEqual([
      { severity: 'error', path: 'params.arguments.text', message: 'must be string' },
    ]);
  });

  it("answers the server's requests with the agent's recorded replies", async () => {
    const recorded = await recordSession(store);
    const result = await replay({ store, messageId: recorded.roots });
    expect(result.runs[0]!.response).toMatchObject({
      result: { content: [{ text: '{"roots":[{"uri":"file:///work","name":"work"}]}' }] },
    });
  });

  it('points out config-like variables the original server had', async () => {
    const recorded = await recordSession(store, { ...process.env, MY_API_KEY: 'secret' });
    delete process.env.MY_API_KEY;

    const without = await replay({ store, messageId: recorded.env });
    expect(without.missingEnv).toEqual(['MY_API_KEY']);
    expect(without.runs[0]!.response).toMatchObject({ result: { content: [{ text: '(unset)' }] } });

    const withKey = await replay({ store, messageId: recorded.env, env: { MY_API_KEY: 'secret' } });
    expect(withKey.missingEnv).toEqual([]);
    expect(withKey.runs[0]!.response).toMatchObject({ result: { content: [{ text: 'secret' }] } });
    // Values are never stored, only names.
    expect(store.getSession(recorded.sessionId)!.env_keys).not.toContain('secret');
  });

  it('refuses messages that cannot be replayed', async () => {
    const recorded = await recordSession(store);
    await expect(replay({ store, messageId: 9999 })).rejects.toThrow(/no message/);
    await expect(replay({ store, messageId: recorded.initialize })).rejects.toThrow(/initialize is sent automatically/);
    await expect(replay({ store, messageId: store.responseTo(recorded.echo)!.id })).rejects.toThrow(ReplayError);
  });

  it('reports a failed replay with the session it recorded', async () => {
    const recorded = await recordSession(store);
    // Point the session at a server that exits immediately.
    const broken = store.createSession({ name: 'broken', transport: 'stdio', command: JSON.stringify([process.execPath, '-e', 'process.exit(3)']), cwd: '/', pid: null, started_at: 0 });
    const { id: _id, ...original } = store.getMessage(recorded.echo)!;
    const copy = store.insertMessage({ ...original, session_id: broken });
    const error = await replay({ store, messageId: copy }).catch((reason: ReplayError) => reason);
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).message).toMatch(/exited \(code 3\)/);
    expect(store.getSession((error as ReplayError).sessionId!)).toMatchObject({ exit_code: 3, replay_of: broken });
  });
});

describe('replay edge cases', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  const asking = new URL('./fixtures/asking-server.mjs', import.meta.url).pathname;
  const session = (fields: { transport?: string; command: string[]; replay_of?: number }) =>
    store.createSession({ name: 's', transport: fields.transport ?? 'stdio', command: JSON.stringify(fields.command), cwd: process.cwd(), pid: null, started_at: 1, replay_of: fields.replay_of ?? null });
  const request = (sessionId: number, method = 'tools/call', payload = `{"jsonrpc":"2.0","id":1,"method":"${method}","params":{"name":"ask"}}`) =>
    store.insertMessage({ session_id: sessionId, ts: 1, direction: 'client', kind: 'request', method, rpc_id: '1', payload, size: 1, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });

  it('refuses transports it cannot reach, including replays whose origin was pruned', async () => {
    await expect(replay({ store, messageId: request(session({ transport: 'carrier-pigeon', command: [] })) })).rejects.toThrow('replaying carrier-pigeon sessions is not supported');
    const orphan = session({ transport: 'replay', command: ['node'], replay_of: 9999 });
    await expect(replay({ store, messageId: request(orphan) })).rejects.toThrow('replaying replay sessions is not supported');
  });

  it('explains a URL that held a secret', async () => {
    const id = request(session({ transport: 'http', command: ['https://x.example/mcp?key=[REDACTED]'] }));
    await expect(replay({ store, messageId: id })).rejects.toThrow("the server's URL held a secret, which mcpspy didn't record, so it can't be reached again. Pass the secret in a header (-H) instead");
  });

  it('fails when initialize does', async () => {
    const id = request(session({ command: [process.execPath, asking, '--fail-initialize'] }));
    await expect(replay({ store, messageId: id })).rejects.toThrow('initialize failed: {"code":-1,"message":"not today"}');
  });

  it('answers ping itself, replays recorded errors and refuses what it has no answer for', async () => {
    const origin = session({ command: [process.execPath, asking] });
    const id = request(origin);
    const first = await replay({ store, messageId: id });
    const text = (result: typeof first) => JSON.parse(((result.runs[0]!.response.result as { content: { text: string }[] }).content[0]!.text)) as Record<string, { result?: unknown; error?: unknown }>;
    expect(text(first)).toMatchObject({ ping: { result: {} }, roots: { error: { code: -32601, message: 'no recorded reply to roots/list to replay' } } });

    const ask = store.insertMessage({ session_id: origin, ts: 2, direction: 'server', kind: 'request', method: 'roots/list', rpc_id: '"r"', payload: '{"jsonrpc":"2.0","id":"r","method":"roots/list"}', size: 1, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
    store.insertMessage({ session_id: origin, ts: 3, direction: 'client', kind: 'error', method: 'roots/list', rpc_id: '"r"', payload: '{"jsonrpc":"2.0","id":"r","error":{"code":7,"message":"private"}}', size: 1, problem: null, request_id: ask, latency_ms: null, tokens: null, token_detail: null, issues: null });
    expect(text(await replay({ store, messageId: id }))).toMatchObject({ roots: { error: { code: 7, message: 'private' } } });

    // A recorded reply with neither result nor error counts as no reply.
    const odd = session({ command: [process.execPath, asking] });
    const oddAsk = store.insertMessage({ session_id: odd, ts: 2, direction: 'server', kind: 'request', method: 'roots/list', rpc_id: '"r"', payload: '{}', size: 1, problem: null, request_id: null, latency_ms: null, tokens: null, token_detail: null, issues: null });
    store.insertMessage({ session_id: odd, ts: 3, direction: 'client', kind: 'response', method: 'roots/list', rpc_id: '"r"', payload: '{"jsonrpc":"2.0","id":"r"}', size: 1, problem: null, request_id: oddAsk, latency_ms: null, tokens: null, token_detail: null, issues: null });
    expect(text(await replay({ store, messageId: request(odd) }))).toMatchObject({ roots: { error: { code: -32601 } } });
  });

  it('records a server that had to be killed', async () => {
    const killable = `require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const m = JSON.parse(line);
        if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n');
      });
      process.stdin.on('end', () => setInterval(() => {}, 1000));`;
    const id = request(session({ command: [process.execPath, '-e', killable] }), 'ping', '{"jsonrpc":"2.0","id":1,"method":"ping"}');
    const result = await replay({ store, messageId: id });
    expect(store.getSession(result.sessionId)).toMatchObject({ exit_code: null, exit_signal: 'SIGTERM' });
  });

  it('replaces arguments of a request without params', () => {
    const id = request(session({ command: [] }), 'tools/call', '{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
    expect(withArguments(store.getMessage(id)!, { a: 1 })).toEqual({ arguments: { a: 1 } });
  });
});
