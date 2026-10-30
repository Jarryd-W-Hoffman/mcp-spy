import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRpcClient } from '../src/http-client.js';

/** A response whose body is written by the test, for event streams. */
function stream(headers: Record<string, string> = { 'content-type': 'text/event-stream' }) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    error: () => controller.error(new Error('dropped')),
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });

afterEach(() => vi.restoreAllMocks());

describe('HttpRpcClient over Streamable HTTP', () => {
  it('explains refused, failed and unauthorised posts', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockRejectedValueOnce(new Error('socket hang up'));
    const client = new HttpRpcClient({ url: 'http://127.0.0.1:1/mcp', transport: 'http' });
    await expect(client.request('ping', {})).rejects.toThrow('could not reach http://127.0.0.1:1/mcp: socket hang up');

    fetch.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const refused = new HttpRpcClient({ url: 'http://127.0.0.1:1/mcp', transport: 'http' });
    await expect(refused.request('ping', {})).rejects.toThrow('could not reach http://127.0.0.1:1/mcp: ECONNREFUSED');

    const unauthorised = new HttpRpcClient({ url: 'http://x/mcp', transport: 'http' });
    fetch.mockResolvedValueOnce(new Response('login first', { status: 401, statusText: 'Unauthorized' }));
    await expect(unauthorised.request('ping', {})).rejects.toThrow(
      'HTTP 401 Unauthorized: login first (headers such as Authorization are not recorded; pass them with -H)',
    );
    fetch.mockResolvedValueOnce(new Response('', { status: 500, statusText: 'Server Error' }));
    await expect(unauthorised.request('ping', {})).rejects.toThrow(/^HTTP 500 Server Error$/);
    const unreadable = { ok: false, status: 502, statusText: 'Bad Gateway', headers: new Headers(), text: () => Promise.reject(new Error('reset')) };
    fetch.mockResolvedValueOnce(unreadable as unknown as Response);
    await expect(unauthorised.request('ping', {})).rejects.toThrow(/^HTTP 502 Bad Gateway$/);

    // A refused notification fails nothing.
    fetch.mockResolvedValueOnce(new Response('', { status: 400 }));
    unauthorised.notify('notifications/initialized');
    await unauthorised.close();
  });

  it('reads JSON and event-stream replies, sends its session, and ends it on close', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const client = new HttpRpcClient({ url: 'http://x/mcp', transport: 'http', headers: { authorization: 'Bearer t' } });

    fetch.mockResolvedValueOnce(json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }, { headers: { 'mcp-session-id': 's1' } }));
    expect((await client.request('initialize', {})).message).toMatchObject({ result: { protocolVersion: '2025-06-18' } });

    fetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
    client.notify('notifications/initialized');

    const events = stream();
    fetch.mockResolvedValueOnce(events.response);
    const call = client.request('tools/call', {});
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    events.send('event: ping\ndata: x\n\n');
    events.send('data: \n\n');
    events.send('data: {"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"ignored"}}\n\n');
    expect((await call).message).toMatchObject({ id: 2 });
    events.end();

    fetch.mockResolvedValueOnce(new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    const garbled = client.request('ping', {}, 50);
    await expect(garbled).rejects.toThrow('timed out');

    const unreadable = { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: () => Promise.reject(new Error('reset')) };
    fetch.mockResolvedValueOnce(unreadable as unknown as Response);
    await expect(client.request('ping', {}, 50)).rejects.toThrow('timed out');

    fetch.mockRejectedValueOnce(new Error('already gone'));
    await client.close();
    const [, init] = fetch.mock.calls.at(-1)!;
    expect(init).toMatchObject({ method: 'DELETE', headers: { authorization: 'Bearer t', 'mcp-session-id': 's1', 'mcp-protocol-version': '2025-06-18' } });
  });

  it('closes without a session and ignores a dropped stream', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const client = new HttpRpcClient({ url: 'http://x/mcp', transport: 'http' });
    const events = stream({});
    fetch.mockResolvedValueOnce(new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }));
    client.notify('a');
    fetch.mockResolvedValueOnce(stream().response);
    client.notify('b');
    void events;
    await client.close();
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
  });

  it('stops reading a stream that drops', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const client = new HttpRpcClient({ url: 'http://x/mcp', transport: 'http' });
    const events = stream();
    fetch.mockResolvedValueOnce(events.response);
    const call = client.request('slow', {}, 100);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    events.error();
    await expect(call).rejects.toThrow('timed out');
  });
});

describe('HttpRpcClient over legacy HTTP+SSE', () => {
  it('posts to the endpoint the stream names, and fails when the stream closes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 202 }));
    const events = stream();
    fetch.mockResolvedValueOnce(events.response);
    const client = new HttpRpcClient({ url: 'http://x/sse', transport: 'sse' });
    const call = client.request('ping', {});
    events.send('event: endpoint\ndata: /messages?session=1\n\n');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1]![0]).toBe('http://x/messages?session=1');
    expect(fetch.mock.calls[1]![1]!.headers).not.toHaveProperty('mcp-protocol-version');
    events.send('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    await call;
    const later = client.request('ping', {});
    events.end();
    await expect(later).rejects.toThrow('the server closed its event stream');
  });

  it('closes cleanly', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const events = stream();
    fetch.mockResolvedValueOnce(events.response);
    const client = new HttpRpcClient({ url: 'http://x/sse', transport: 'sse' });
    events.send('event: endpoint\ndata: /messages\n\n');
    await client.close();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('explains a stream that cannot be opened or names no endpoint', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    const unreachable = new HttpRpcClient({ url: 'http://nowhere/sse', transport: 'sse' });
    await expect(unreachable.request('ping', {})).rejects.toThrow('could not reach http://nowhere/sse: ENOTFOUND');

    fetch.mockRejectedValueOnce(new Error('bad url'));
    const broken = new HttpRpcClient({ url: 'http://x/sse', transport: 'sse' });
    await expect(broken.request('ping', {})).rejects.toThrow('could not reach http://x/sse: bad url');

    fetch.mockResolvedValueOnce(new Response('', { status: 404, statusText: 'Not Found' }));
    const missing = new HttpRpcClient({ url: 'http://x/sse', transport: 'sse' });
    await expect(missing.request('ping', {})).rejects.toThrow('HTTP 404 Not Found opening http://x/sse');

    const events = stream();
    fetch.mockResolvedValueOnce(events.response);
    const silent = new HttpRpcClient({ url: 'http://x/sse', transport: 'sse' });
    events.end();
    await expect(silent.request('ping', {})).rejects.toThrow(/closed its event stream/);
  });
});
