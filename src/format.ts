import type { MessageRow, SessionRow } from './store.js';
import { formatTokens } from './tokens.js';

export interface Style {
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
}

const ansi = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
export const colors: Style = {
  dim: ansi(2),
  red: ansi(31),
  green: ansi(32),
  yellow: ansi(33),
  cyan: ansi(36),
  magenta: ansi(35),
};
const identity = (text: string) => text;
export const plain: Style = { dim: identity, red: identity, green: identity, yellow: identity, cyan: identity, magenta: identity };

export function styleFor(stream: { isTTY?: boolean }): Style {
  return stream.isTTY && !process.env.NO_COLOR ? colors : plain;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatClock(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * A short label for what a request is about: the tool, prompt or resource
 * it names. Returns null when the method has no obvious subject.
 */
export function requestSubject(method: string | null, payload: string): string | null {
  if (method === null) return null;
  let params: Record<string, unknown> | undefined;
  try {
    params = (JSON.parse(payload) as { params?: Record<string, unknown> }).params;
  } catch {
    return null;
  }
  if (!params) return null;

  switch (method) {
    case 'tools/call':
    case 'prompts/get':
      return typeof params.name === 'string' ? params.name : null;
    case 'resources/read':
    case 'resources/subscribe':
    case 'resources/unsubscribe':
      return typeof params.uri === 'string' ? params.uri : null;
    default:
      return null;
  }
}

/** The error message from a JSON-RPC error, or a tool result flagged isError. */
export function errorSummary(message: MessageRow): string | null {
  try {
    const parsed = JSON.parse(message.payload) as {
      error?: { code?: number; message?: string };
      result?: { isError?: boolean; content?: { type?: string; text?: string }[] };
    };
    if (parsed.error) return `${parsed.error.code ?? '?'} ${parsed.error.message ?? ''}`.trim();
    if (parsed.result?.isError) {
      const text = parsed.result.content?.find((part) => part.type === 'text')?.text;
      return `tool error${text ? `: ${text}` : ''}`;
    }
  } catch {
    // Unparseable payloads are reported as invalid elsewhere.
  }
  return null;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * One line of `mcpspy tail`. `subject` is the tool/prompt/resource name of
 * the request (for responses, of the request they answer).
 */
export function formatMessageLine(
  message: MessageRow,
  session: Pick<SessionRow, 'id' | 'name'> | undefined,
  subject: string | null,
  style: Style,
): string {
  const label = session?.name ?? `#${message.session_id}`;
  const prefix = `${style.dim(formatClock(message.ts))} ${style.cyan(label.padEnd(10).slice(0, 10))} ${style.dim(`#${message.id}`)}`;
  const what = [message.method ?? '', subject ? style.magenta(subject) : ''].filter(Boolean).join(' ');
  const id = message.rpc_id !== null ? style.dim(`id=${message.rpc_id}`) : '';
  const size = style.dim(formatBytes(message.size));
  const issueCount = message.issues ? (JSON.parse(message.issues) as unknown[]).length : 0;
  const issues = issueCount > 0 ? style.yellow(`⚠ ${issueCount} issue${issueCount === 1 ? '' : 's'}`) : '';
  const mock = message.mock !== null ? style.magenta(`[mock: ${message.mock}]`) : '';

  switch (message.kind) {
    case 'log':
      return `${prefix} ${style.dim('stderr')} ${style.dim(truncate(message.payload, 160))}`;
    case 'invalid':
      return `${prefix} ${arrow(message, style)} ${style.yellow('invalid')} ${message.problem ?? ''} ${style.dim(truncate(message.payload, 80))}`;
    case 'request':
    case 'notification':
      return [prefix, arrow(message, style), message.kind === 'notification' ? style.dim(what) : what, issues, id, size]
        .filter(Boolean)
        .join(' ');
    case 'response':
    case 'error': {
      const failure = errorSummary(message);
      const status = failure ? style.red(`✗ ${truncate(failure, 80)}`) : style.green('✓');
      const latency = message.latency_ms !== null ? formatDuration(message.latency_ms) : style.yellow('unmatched');
      const tokens = message.tokens ? style.yellow(`≈${formatTokens(message.tokens)} tok`) : '';
      return [prefix, arrow(message, style), what, status, mock, issues, latency, tokens, id, size].filter(Boolean).join(' ');
    }
  }
}

function arrow(message: MessageRow, style: Style): string {
  return message.direction === 'client' ? style.dim('→') : style.dim('←');
}

/** Pretty-prints a stored payload, falling back to the raw text. */
export function prettyPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}
