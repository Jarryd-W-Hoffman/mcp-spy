import { describe, expect, it } from 'vitest';
import { classifyFrame, requestsLaterPage } from '../src/jsonrpc.js';

describe('classifyFrame', () => {
  it('classifies requests', () => {
    const [message] = classifyFrame('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(message).toMatchObject({ kind: 'request', method: 'tools/list', rpcId: '1' });
  });

  it('keeps numeric and string ids distinct', () => {
    const [message] = classifyFrame('{"jsonrpc":"2.0","id":"1","method":"ping"}');
    expect(message?.rpcId).toBe('"1"');
  });

  it('classifies notifications', () => {
    const [message] = classifyFrame('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(message).toMatchObject({ kind: 'notification', rpcId: null });
  });

  it('classifies results and errors', () => {
    expect(classifyFrame('{"jsonrpc":"2.0","id":1,"result":{}}')[0]?.kind).toBe('response');
    expect(classifyFrame('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"x"}}')[0]?.kind).toBe('error');
  });

  it('expands batches', () => {
    const messages = classifyFrame('[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","method":"b"}]');
    expect(messages.map((m) => m.kind)).toEqual(['request', 'notification']);
    expect(messages[0]?.json).toBe('{"jsonrpc":"2.0","id":1,"method":"a"}');
  });

  it('flags non-JSON and malformed messages', () => {
    expect(classifyFrame('Server started on stdio')[0]).toMatchObject({ kind: 'invalid' });
    expect(classifyFrame('{"id":1,"method":"x"}')[0]?.problem).toMatch(/jsonrpc/);
    expect(classifyFrame('{"jsonrpc":"2.0","id":{},"method":"x"}')[0]?.problem).toMatch(/id/);
    expect(classifyFrame('[]')[0]?.problem).toBe('empty batch');
  });
});

describe('more invalid messages', () => {
  it('rejects values that are not objects, and objects that are nothing', () => {
    expect(classifyFrame('5')[0]).toMatchObject({ kind: 'invalid', problem: 'message is not an object' });
    expect(classifyFrame('{"jsonrpc":"2.0","id":1}')[0]).toMatchObject({ kind: 'invalid', problem: 'neither a request, notification nor response' });
  });

  it('treats an unparseable request as asking for the first page', () => {
    expect(requestsLaterPage('{')).toBe(false);
    expect(requestsLaterPage(null)).toBe(false);
    expect(requestsLaterPage('{"params":{"cursor":"x"}}')).toBe(true);
  });
});
