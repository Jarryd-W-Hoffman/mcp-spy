/**
 * Splits a byte stream into newline-delimited frames, as used by the MCP
 * stdio transport. Bytes are buffered until a "\n" arrives; a trailing
 * "\r" is stripped so CRLF-emitting servers parse cleanly.
 */
export class LineSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);

    let start = 0;
    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a, start)) !== -1) {
      this.emit(this.buffer.subarray(start, newline));
      start = newline + 1;
    }
    this.buffer = this.buffer.subarray(start);
  }

  /** Emits whatever is left in the buffer (a final frame with no newline). */
  flush(): void {
    if (this.buffer.length > 0) {
      this.emit(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
  }

  private emit(bytes: Buffer): void {
    let line = bytes.toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim() !== '') this.onLine(line);
  }
}
