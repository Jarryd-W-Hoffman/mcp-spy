export type MessageKind = 'request' | 'notification' | 'response' | 'error' | 'invalid';

export interface ClassifiedMessage {
  kind: MessageKind;
  /** The JSON text of this single message (batches are expanded). */
  json: string;
  method: string | null;
  /** JSON-encoded id, so 1 and "1" stay distinct. Null for notifications. */
  rpcId: string | null;
  /** Parse or shape problem, set when kind is "invalid". */
  problem: string | null;
}

/**
 * Parses one stdio frame into one or more classified JSON-RPC messages.
 * Batches (arrays) are expanded so each element is tracked on its own.
 */
export function classifyFrame(line: string): ClassifiedMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return [invalid(line, `not JSON: ${(error as Error).message}`)];
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return [invalid(line, 'empty batch')];
    return parsed.map((item) => classifyValue(item, JSON.stringify(item)));
  }

  return [classifyValue(parsed, line)];
}

function classifyValue(value: unknown, json: string): ClassifiedMessage {
  if (typeof value !== 'object' || value === null) {
    return invalid(json, 'message is not an object');
  }

  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') {
    return invalid(json, 'missing jsonrpc: "2.0"');
  }

  const hasId = 'id' in message && message.id !== undefined;
  if (hasId && typeof message.id !== 'string' && typeof message.id !== 'number' && message.id !== null) {
    return invalid(json, 'id must be a string or number');
  }
  const rpcId = hasId ? JSON.stringify(message.id) : null;

  if (typeof message.method === 'string') {
    return {
      kind: hasId ? 'request' : 'notification',
      json,
      method: message.method,
      rpcId,
      problem: null,
    };
  }

  if (hasId && 'error' in message) {
    return { kind: 'error', json, method: null, rpcId, problem: null };
  }
  if (hasId && 'result' in message) {
    return { kind: 'response', json, method: null, rpcId, problem: null };
  }

  return invalid(json, 'neither a request, notification nor response');
}

function invalid(json: string, problem: string): ClassifiedMessage {
  return { kind: 'invalid', json, method: null, rpcId: null, problem };
}
