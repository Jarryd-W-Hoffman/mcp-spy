import { errorSummary, requestSubject } from './format.js';
import type { Store } from './store.js';
import type { ToolCost } from './tokens.js';
import type { ToolsReport, ToolCallStats, ToolChange } from './types.js';

/**
 * What a session's tools cost in context and how they behaved: per-tool
 * definition costs from the latest tools/list, call statistics, and how the
 * tool list differs from the previous session of the same server.
 */
export function toolsReport(store: Store, sessionId: number): ToolsReport {
  const list = store.latestReply(sessionId, 'tools/list');
  const previous = store.previousSession(sessionId);
  const previousList = previous ? store.latestReply(previous.id, 'tools/list') : undefined;

  return {
    sessionId,
    definitions: list
      ? {
          messageId: list.id,
          total: list.tokens ?? 0,
          tools: list.token_detail ? (JSON.parse(list.token_detail) as ToolCost[]) : [],
        }
      : null,
    calls: callStats(store, sessionId),
    previousSessionId: previousList ? previous!.id : null,
    changes: list && previousList ? toolListChanges(previousList.payload, list.payload, previousList.token_detail, list.token_detail) : null,
  };
}

function callStats(store: Store, sessionId: number): ToolCallStats[] {
  const byName = new Map<string, ToolCallStats & { latencySum: number; latencyCount: number }>();

  for (const reply of store.toolCalls(sessionId)) {
    const name = (reply.request_payload && requestSubject('tools/call', reply.request_payload)) ?? '(unknown)';
    let stats = byName.get(name);
    if (!stats) {
      stats = { name, calls: 0, errors: 0, avgLatency: null, maxLatency: null, totalTokens: 0, maxTokens: 0, latencySum: 0, latencyCount: 0 };
      byName.set(name, stats);
    }
    stats.calls++;
    if (errorSummary(reply)) stats.errors++;
    if (reply.latency_ms !== null) {
      stats.latencySum += reply.latency_ms;
      stats.latencyCount++;
      stats.maxLatency = Math.max(stats.maxLatency ?? 0, reply.latency_ms);
    }
    stats.totalTokens += reply.tokens ?? 0;
    stats.maxTokens = Math.max(stats.maxTokens, reply.tokens ?? 0);
  }

  return [...byName.values()]
    .map(({ latencySum, latencyCount, ...stats }) => ({
      ...stats,
      avgLatency: latencyCount > 0 ? latencySum / latencyCount : null,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);
}

interface McpTool {
  name: string;
  [field: string]: unknown;
}

/** Tools added, removed or changed between two tools/list responses. */
export function toolListChanges(
  beforePayload: string,
  afterPayload: string,
  beforeCosts: string | null,
  afterCosts: string | null,
): ToolChange[] {
  const tools = (payload: string) =>
    new Map(
      ((JSON.parse(payload) as { result?: { tools?: McpTool[] } }).result?.tools ?? []).map((tool) => [tool.name, tool]),
    );
  const costs = (detail: string | null) =>
    new Map(((detail ? JSON.parse(detail) : []) as ToolCost[]).map((cost) => [cost.name, cost.tokens]));

  const before = tools(beforePayload);
  const after = tools(afterPayload);
  const beforeTokens = costs(beforeCosts);
  const afterTokens = costs(afterCosts);
  const changes: ToolChange[] = [];

  for (const [name, tool] of after) {
    const old = before.get(name);
    const tokenDelta = (afterTokens.get(name) ?? 0) - (beforeTokens.get(name) ?? 0);
    if (!old) {
      changes.push({ name, change: 'added', fields: [], tokenDelta });
      continue;
    }
    const fields = [...new Set([...Object.keys(old), ...Object.keys(tool)])]
      .filter((field) => stableStringify(old[field]) !== stableStringify(tool[field]))
      .sort();
    if (fields.length > 0) changes.push({ name, change: 'changed', fields, tokenDelta });
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changes.push({ name, change: 'removed', fields: [], tokenDelta: -(beforeTokens.get(name) ?? 0) });
  }

  return changes;
}

/** JSON with object keys sorted, so key order never counts as a change. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  ) ?? 'undefined';
}
