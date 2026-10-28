/** One server-sent event, with the exact text it arrived as. */
export interface SseEvent {
  /** Everything from the event's first line through its terminating blank line. */
  raw: string;
  /** The `event:` field, or "message" when absent. */
  event: string;
  /** `data:` lines joined with "\n", or null when the block had none (comments, retry hints). */
  data: string | null;
  id: string | null;
}

/**
 * Splits a text/event-stream into events as bytes arrive. Each block is
 * handed back with its raw text so a proxy can forward it untouched, or
 * rewrite just the events it needs to.
 */
export class SseParser {
  private buffer = '';
  private readonly decoder = new TextDecoder();

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    for (;;) {
      // A blank line ends the block: \n\n, \r\n\r\n, \r\r, or mixes of them.
      // A trailing \r may be the first half of \r\n, so it waits for the next chunk.
      const end = /(\r\n|\r(?!\n|$)|\n)(\r\n|\r(?!\n|$)|\n)/.exec(this.buffer);
      if (!end) break;
      const raw = this.buffer.slice(0, end.index + end[0].length);
      this.buffer = this.buffer.slice(raw.length);
      this.onEvent(parseBlock(raw));
    }
  }

  /** Whatever is left when the stream ends (an unterminated block is not an event). */
  rest(): string {
    const rest = this.buffer + this.decoder.decode();
    this.buffer = '';
    return rest;
  }
}

function parseBlock(raw: string): SseEvent {
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  return { raw, event, data: data.length > 0 ? data.join('\n') : null, id };
}

/** Serialises an event; multi-line data becomes several data: lines. */
export function formatSseEvent(event: { event?: string; data: string; id?: string | null }): string {
  let text = '';
  if (event.event && event.event !== 'message') text += `event: ${event.event}\n`;
  if (event.id) text += `id: ${event.id}\n`;
  for (const line of event.data.split(/\r\n|\r|\n/)) text += `data: ${line}\n`;
  return `${text}\n`;
}
