import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStdioProxy } from '../src/proxy/stdio.js';
import { replay, ReplayError, withArguments } from '../src/replay.js';
import { Store } from '../src/store.js';

const server = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

/** Records a session as an agent would, through the proxy. Returns message ids by request id. */
async function recordSession(store: Store, env: NodeJS.ProcessEnv = process.env) {
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
  const done = runStdioProxy({ command: process.execPath, args: [server], store, name: 'echo', env, input, output, errorOutput: new PassThrough(), forwardSignals: [] });

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
  await waitFor((line) => line.id === 3);
  input.end();
  const { sessionId } = await done;

  const requests = store.messagesAfter(0, { sessionId }).filter((m) => m.kind === 'request' && m.direction === 'client');
  const byRpcId = (id: number) => requests.find((m) => m.rpc_id === String(id))!.id;
  return { sessionId, echo: byRpcId(1), roots: byRpcId(2), env: byRpcId(3), initialize: byRpcId(0) };
}

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
