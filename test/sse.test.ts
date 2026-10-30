import { describe, expect, it } from 'vitest';
import { formatSseEvent, SseParser, type SseEvent } from '../src/sse.js';

function parse(chunks: string[]): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const parser = new SseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(Buffer.from(chunk));
  return { events, rest: parser.rest() };
}

describe('SseParser', () => {
  it('parses events split across chunks, keeping their raw text', () => {
    const { events, rest } = parse(['event: endpoint\ndata: /messages?s', 'essionId=1\n\nid: 7\nda', 'ta: {"a":1}\n\n: keep-alive\n\ndata: partial']);
    expect(events).toEqual([
      { raw: 'event: endpoint\ndata: /messages?sessionId=1\n\n', event: 'endpoint', data: '/messages?sessionId=1', id: null },
      { raw: 'id: 7\ndata: {"a":1}\n\n', event: 'message', data: '{"a":1}', id: '7' },
      { raw: ': keep-alive\n\n', event: 'message', data: null, id: null },
    ]);
    expect(rest).toBe('data: partial');
  });

  it('handles CRLF and CR line endings, multi-line data and fields without a space', () => {
    const { events } = parse(['data:one\r\ndata: two\r\n\r\n', 'data: three\r', '\r', 'event\ndata\n\n']);
    expect(events.map((event) => event.data)).toEqual(['one\ntwo', 'three', '']);
    expect(events[1]!.raw).toBe('data: three\r\r');
    expect(events[2]!.event).toBe('');
  });

  it('decodes UTF-8 split across chunks', () => {
    const bytes = Buffer.from('data: héllo\n\n');
    const events: SseEvent[] = [];
    const parser = new SseParser((event) => events.push(event));
    parser.push(bytes.subarray(0, 8));
    parser.push(bytes.subarray(8));
    expect(events[0]!.data).toBe('héllo');
  });
});

describe('formatSseEvent', () => {
  it('round-trips through the parser', () => {
    const text = formatSseEvent({ event: 'endpoint', id: '3', data: 'a\nb' });
    expect(text).toBe('event: endpoint\nid: 3\ndata: a\ndata: b\n\n');
    expect(parse([text]).events[0]).toMatchObject({ event: 'endpoint', id: '3', data: 'a\nb' });
  });
});

describe('bytes and ids', () => {
  it('decodes byte chunks and reads event ids', () => {
    const events: SseEvent[] = [];
    const parser = new SseParser((event) => events.push(event));
    parser.push(new TextEncoder().encode('id: 7\ndata: {"a":1}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: '7', data: '{"a":1}' });
  });
});

describe('text and other fields', () => {
  it('accepts string chunks and ignores fields it does not use', () => {
    const events: SseEvent[] = [];
    const parser = new SseParser((event) => events.push(event));
    parser.push('retry: 1000\ndata: x\n\n');
    expect(events[0]).toMatchObject({ data: 'x' });
  });
});
