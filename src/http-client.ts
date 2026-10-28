import { RpcClient, RpcError, type BaseRpcClientOptions, type ClientExit } from './rpc-client.js';
import { SseParser } from './sse.js';

export interface HttpRpcClientOptions extends BaseRpcClientOptions {
  url: string;
  /** 'http' is Streamable HTTP; 'sse' is the older HTTP+SSE transport. */
  transport: 'http' | 'sse';
  /** Sent with every request, e.g. Authorization (never recorded). */
  headers?: Record<string, string>;
}

/** Replays against a server reached over HTTP. */
export class HttpRpcClient extends RpcClient {
  private readonly aborter = new AbortController();
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  /** Legacy transport: where to POST, once the event stream has said. */
  private readonly endpoint: Promise<string>;
  /** Sends in order, so notifications/initialized can't overtake initialize's follow-ups. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: HttpRpcClientOptions) {
    super(options);
    this.endpoint = options.transport === 'sse' ? this.openLegacyStream() : Promise.resolve(options.url);
    this.endpoint.catch((error: Error) => this.fail(error));
  }

  async close(): Promise<ClientExit> {
    await this.queue;
    if (this.options.transport === 'http' && this.sessionId !== null) {
      await fetch(this.options.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(2000) }).catch(() => {});
    }
    this.aborter.abort();
    return { code: null, signal: null };
  }

  protected transmit(line: string, message: object): void {
    this.queue = this.queue.then(() => this.post(line, message)).catch(() => {});
  }

  private async post(line: string, message: object): Promise<void> {
    const id = (message as { id?: unknown }).id;
    const isRequest = 'method' in message && id !== undefined;
    let response: Response;
    try {
      response = await fetch(await this.endpoint, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: line,
        signal: this.aborter.signal,
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
      this.fail(new RpcError(`could not reach ${this.options.url}: ${cause}`));
      return;
    }

    const assigned = response.headers.get('mcp-session-id');
    if (assigned) this.sessionId = assigned;
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).trim().slice(0, 300);
      const hint = response.status === 401 || response.status === 403 ? ' (headers such as Authorization are not recorded; pass them with -H)' : '';
      const error = new RpcError(`HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ''}${hint}`);
      if (isRequest) this.failRequest(id, error);
      return;
    }

    const type = response.headers.get('content-type') ?? '';
    if (type.startsWith('text/event-stream')) {
      // Don't hold up later sends while this stream stays open (it may be waiting on our answer).
      void this.readEvents(response);
      return;
    }
    const text = await response.text();
    if (text.trim() !== '' && type.includes('json')) {
      this.receive(text);
      this.noteProtocolVersion(text);
    }
  }

  private async openLegacyStream(): Promise<string> {
    const response = await fetch(this.options.url, {
      headers: { ...this.options.headers, accept: 'text/event-stream' },
      signal: this.aborter.signal,
    }).catch((error: Error & { cause?: { code?: string } }) => {
      throw new RpcError(`could not reach ${this.options.url}: ${error.cause?.code ?? error.message}`);
    });
    if (!response.ok) throw new RpcError(`HTTP ${response.status} ${response.statusText} opening ${this.options.url}`);
    return new Promise((resolve, reject) => {
      void this.readEvents(response, (endpoint) => resolve(new URL(endpoint, this.options.url).href)).then(() =>
        reject(new RpcError('the server closed its event stream before naming an endpoint')),
      );
    });
  }

  private async readEvents(response: Response, onEndpoint?: (endpoint: string) => void): Promise<void> {
    const parser = new SseParser((event) => {
      if (event.event === 'endpoint' && event.data !== null) onEndpoint?.(event.data);
      else if (event.event === 'message' && event.data !== null && event.data.trim() !== '') {
        this.receive(event.data);
        this.noteProtocolVersion(event.data);
      }
    });
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) parser.push(chunk);
    } catch {
      // Aborted on close, or the connection dropped; pending requests time out.
    }
    if (this.options.transport === 'sse' && !this.aborter.signal.aborted) this.fail(new RpcError('the server closed its event stream'));
  }

  /** Streamable HTTP wants the negotiated version on every request after initialize. */
  private noteProtocolVersion(text: string): void {
    if (this.protocolVersion !== null) return;
    try {
      const version = (JSON.parse(text) as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
      if (typeof version === 'string') this.protocolVersion = version;
    } catch {
      // not JSON; already recorded as invalid
    }
  }

  private headers(): Record<string, string> {
    return {
      ...this.options.headers,
      ...(this.sessionId !== null ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion !== null && this.options.transport === 'http' ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    };
  }
}
