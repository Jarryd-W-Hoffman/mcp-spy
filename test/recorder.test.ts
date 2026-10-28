import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Recorder } from '../src/recorder.js';
import { Store } from '../src/store.js';

describe('Recorder', () => {
  let store: Store;
  let clock: number;
  let recorder: Recorder;

  beforeEach(() => {
    store = new Store(':memory:');
    const sessionId = store.createSession({
      name: 'test',
      transport: 'stdio',
      command: '["server"]',
      cwd: '/',
      pid: null,
      started_at: 0,
    });
    clock = 1000;
    recorder = new Recorder(store, sessionId, () => clock);
  });

  afterEach(() => store.close());

  it('pairs a server response with the client request and measures latency', () => {
    const [requestId] = recorder.frame('client', '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{}}');
    clock += 42;
    const [responseId] = recorder.frame('server', '{"jsonrpc":"2.0","id":7,"result":{"content":[]}}');

    expect(store.getMessage(responseId!)).toMatchObject({
      kind: 'response',
      method: 'tools/call',
      request_id: requestId,
      latency_ms: 42,
    });
    expect(recorder.unanswered()).toBe(0);
  });

  it('pairs server-initiated requests separately from client ones with the same id', () => {
    const [clientRequest] = recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
    const [serverRequest] = recorder.frame('server', '{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage"}');
    const [clientReply] = recorder.frame('client', '{"jsonrpc":"2.0","id":1,"result":{}}');
    const [serverReply] = recorder.frame('server', '{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"x"}}');

    expect(store.getMessage(clientReply!)).toMatchObject({ request_id: serverRequest, method: 'sampling/createMessage' });
    expect(store.getMessage(serverReply!)).toMatchObject({ request_id: clientRequest, method: 'tools/call', kind: 'error' });
  });

  it('records unmatched responses, invalid frames and stderr', () => {
    const [orphan] = recorder.frame('server', '{"jsonrpc":"2.0","id":99,"result":{}}');
    const [junk] = recorder.frame('server', 'listening...');
    const log = recorder.stderr('debug: ready');

    expect(store.getMessage(orphan!)).toMatchObject({ request_id: null, latency_ms: null });
    expect(store.getMessage(junk!)).toMatchObject({ kind: 'invalid', problem: expect.stringMatching(/not JSON/) });
    expect(store.getMessage(log)).toMatchObject({ direction: 'stderr', kind: 'log', payload: 'debug: ready' });
  });

  it('counts requests still awaiting a response', () => {
    recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
    recorder.frame('client', '{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(recorder.unanswered()).toBe(1);
  });
});
