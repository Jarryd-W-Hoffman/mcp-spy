import { describe, expect, it } from 'vitest';
import { RpcClient, RpcError, StdioRpcClient, type ClientExit } from '../src/rpc-client.js';

/** A client whose wire is an array: tests read what it sent and feed it replies. */
class WireClient extends RpcClient {
  readonly sent: Record<string, unknown>[] = [];

  protected transmit(line: string): void {
    this.sent.push(JSON.parse(line) as Record<string, unknown>);
  }

  async close(): Promise<ClientExit> {
    return { code: 0, signal: null };
  }

  deliver(line: string): void {
    this.receive(line);
  }

  refuse(id: unknown, error: Error): void {
    this.failRequest(id, error);
  }

  break(error: Error): void {
    this.fail(error);
  }
}

describe('RpcClient', () => {
  it('omits missing params and sends notification params', async () => {
    const client = new WireClient({});
    const reply = client.request('ping', undefined);
    client.notify('notifications/progress', { progress: 1 });
    client.notify('notifications/initialized');
    expect(client.sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    client.deliver('not json');
    client.deliver('{"jsonrpc":"2.0","id":"1","result":{}}'); // a string id matches nothing
    client.deliver('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect((await reply).message).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(client.pid).toBeUndefined();
  });

  it('answers server requests: not handled by default, errors when the handler throws', async () => {
    const plain = new WireClient({});
    plain.deliver('{"jsonrpc":"2.0","id":5,"method":"sampling/createMessage"}');
    plain.deliver('{"jsonrpc":"2.0","method":"notifications/message"}');
    await new Promise((resolve) => setImmediate(resolve));
    expect(plain.sent).toEqual([{ jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'mcpspy replay does not handle sampling/createMessage' } }]);

    const throwing = new WireClient({
      onServerRequest: () => {
        throw new Error('no roots today');
      },
    });
    throwing.deliver('{"jsonrpc":"2.0","id":6,"method":"roots/list"}');
    await new Promise((resolve) => setImmediate(resolve));
    expect(throwing.sent).toEqual([{ jsonrpc: '2.0', id: 6, error: { code: -32603, message: 'no roots today' } }]);
  });

  it('fails one request, ignores unknown ones, and fails everything after a failure', async () => {
    const client = new WireClient({});
    const first = client.request('a', {});
    client.refuse(1, new RpcError('HTTP 500'));
    client.refuse(99, new RpcError('nobody'));
    client.refuse('1', new RpcError('nobody'));
    await expect(first).rejects.toThrow('HTTP 500');

    const second = client.request('b', {});
    client.break(new RpcError('gone'));
    await expect(second).rejects.toThrow('gone');
    await expect(client.request('c', {})).rejects.toThrow('gone');
  });

  it('times out without extra detail', async () => {
    const client = new WireClient({});
    await expect(client.request('slow', {}, 10)).rejects.toThrow(/^slow timed out after 10ms$/);
  });
});

describe('StdioRpcClient extras', () => {
  it('keeps the server stderr and stops writing once stdin is closed', async () => {
    const client = new StdioRpcClient({ command: process.execPath, args: ['-e', "console.error('booting'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"] });
    await expect.poll(() => client.stderr).toContain('booting');
    const exit = client.close();
    client.notify('late');
    expect(await exit).toEqual({ code: 0, signal: null });
  });

  it('ignores errors writing to a server that went away', async () => {
    const client = new StdioRpcClient({ command: process.execPath, args: ['-e', 'process.stdin.destroy()'] });
    for (let i = 0; i < 50; i++) client.notify('spam', { data: 'x'.repeat(10_000) });
    expect((await client.close()).code).toBe(0);
  });
});
