import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { comparableBody, diffJson, type JsonChange } from './diff.js';
import { requestSubject } from './format.js';
import { RpcError, StdioRpcClient, type JsonRpcReply } from './rpc-client.js';
import type { Store } from './store.js';

/**
 * A replay suite: recorded requests and the responses they produced, saved
 * as JSON next to a project so a server's behaviour can be checked again
 * later (or in CI) without an agent.
 */
export interface Suite {
  version: 1;
  servers: Record<string, SuiteServer>;
  cases: SuiteCase[];
}

export interface SuiteServer {
  command: string[];
  /** Relative to the suite file when the server lives below it. */
  cwd: string;
  /** The initialize params the agent sent. */
  initialize: unknown;
  /** The agent's replies to requests the server makes (roots/list, …). */
  clientReplies?: Record<string, JsonRpcReply>;
}

export interface SuiteCase {
  name: string;
  server: string;
  method: string;
  params?: unknown;
  /** The response's result, or { error } — compared after removing ignored paths. */
  expect: unknown;
  /** Paths whose values may change between runs, e.g. "structuredContent.now" or "content[*].text". */
  ignore?: string[];
}

export function emptySuite(): Suite {
  return { version: 1, servers: {}, cases: [] };
}

/** Adds recorded requests (by message id) to a suite, creating server entries as needed. */
export function addCases(suite: Suite, suitePath: string, store: Store, messageIds: number[], name?: string): SuiteCase[] {
  const added: SuiteCase[] = [];
  for (const messageId of messageIds) {
    const request = store.getMessage(messageId);
    if (!request || request.kind !== 'request' || request.direction !== 'client' || request.method === null) {
      throw new Error(`message ${messageId} is not a request from the agent`);
    }
    if (request.method === 'initialize') throw new Error(`message ${messageId} is an initialize; add a later request`);
    const response = store.responseTo(request.id);
    if (!response) throw new Error(`message ${messageId} has no recorded response to expect`);

    const session = store.getSession(request.session_id)!;
    const origin = session.replay_of !== null ? store.getSession(session.replay_of)! : session;
    const serverKey = serverEntry(suite, suitePath, store, origin.id, origin.name, origin.command, origin.cwd);

    const subject = requestSubject(request.method, request.payload);
    const base = name && messageIds.length === 1 ? name : [request.method, subject].filter(Boolean).join(' ');
    const testCase: SuiteCase = {
      name: uniqueName(base, new Set(suite.cases.map((existing) => existing.name))),
      server: serverKey,
      method: request.method,
      params: (JSON.parse(request.payload) as { params?: unknown }).params,
      expect: comparableBody(response.payload),
    };
    suite.cases.push(testCase);
    added.push(testCase);
  }
  return added;
}

function serverEntry(
  suite: Suite,
  suitePath: string,
  store: Store,
  sessionId: number,
  sessionName: string | null,
  command: string,
  cwd: string,
): string {
  const commandList = JSON.parse(command) as string[];
  const suiteDir = dirname(resolve(suitePath));
  const relativeCwd = relative(suiteDir, cwd);
  const storedCwd = relativeCwd === '' ? '.' : relativeCwd.startsWith('..') || isAbsolute(relativeCwd) ? cwd : relativeCwd;

  for (const [key, server] of Object.entries(suite.servers)) {
    if (JSON.stringify(server.command) === JSON.stringify(commandList) && server.cwd === storedCwd) return key;
  }

  const initialize = store.firstRequest(sessionId, 'initialize');
  const clientReplies: Record<string, JsonRpcReply> = {};
  for (const method of ['roots/list']) {
    const reply = store.clientReplyTo(sessionId, method);
    if (!reply) continue;
    const message = JSON.parse(reply.payload) as Record<string, unknown>;
    clientReplies[method] = 'result' in message ? { result: message.result } : { error: message.error as { code: number; message: string } };
  }

  const key = uniqueName(sessionName ?? commandList[0] ?? 'server', new Set(Object.keys(suite.servers)));
  suite.servers[key] = {
    command: commandList,
    cwd: storedCwd,
    initialize: initialize ? (JSON.parse(initialize.payload) as { params?: unknown }).params : {},
    ...(Object.keys(clientReplies).length > 0 ? { clientReplies } : {}),
  };
  return key;
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index++) {
    if (!taken.has(`${base} (${index})`)) return `${base} (${index})`;
  }
}

/** Turns an ignore pattern into a test for diff paths at or below it. */
export function ignoreMatcher(patterns: string[] = []): (path: string) => boolean {
  const regexes = patterns.map((pattern) => {
    const escaped = pattern
      .split(/(\[\*\]|\*)/)
      .map((part) => (part === '[*]' ? '\\[[^\\]]+\\]' : part === '*' ? '[^.\\[]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    return new RegExp(`^${escaped}(?:$|[.\\[])`);
  });
  return (path) => regexes.some((regex) => regex.test(path));
}

export interface CaseResult {
  name: string;
  server: string;
  status: 'pass' | 'fail' | 'error';
  latencyMs: number | null;
  changes: JsonChange[];
  /** The body received, for --update and for showing diffs. */
  actual: unknown;
  error?: string;
}

export interface RunOptions {
  /** Only run cases whose name contains this text. */
  filter?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onResult?(result: CaseResult): void;
}

/** Runs every case, starting each server once and sending its cases in order. */
export async function runSuite(suite: Suite, suitePath: string, options: RunOptions = {}): Promise<CaseResult[]> {
  const suiteDir = dirname(resolve(suitePath));
  const results: CaseResult[] = [];
  const cases = suite.cases.filter((testCase) => !options.filter || testCase.name.includes(options.filter));

  for (const [key, server] of Object.entries(suite.servers)) {
    const serverCases = cases.filter((testCase) => testCase.server === key);
    if (serverCases.length === 0) continue;

    const report = (result: CaseResult) => {
      results.push(result);
      options.onResult?.(result);
    };
    const [command, ...args] = server.command as [string, ...string[]];
    const client = new StdioRpcClient({
      command,
      args,
      cwd: isAbsolute(server.cwd) ? server.cwd : resolve(suiteDir, server.cwd),
      env: options.env ?? process.env,
      onServerRequest: (method) =>
        server.clientReplies?.[method] ?? (method === 'ping' ? { result: {} } : { error: { code: -32601, message: `no reply to ${method}` } }),
    });

    try {
      const init = await client.request('initialize', server.initialize, options.timeoutMs);
      if ('error' in init.message) throw new RpcError(`initialize failed: ${JSON.stringify(init.message.error)}`);
      client.notify('notifications/initialized');
    } catch (error) {
      for (const testCase of serverCases) {
        report({ name: testCase.name, server: key, status: 'error', latencyMs: null, changes: [], actual: undefined, error: (error as Error).message });
      }
      await client.close();
      continue;
    }

    for (const testCase of serverCases) {
      try {
        const reply = await client.request(testCase.method, testCase.params, options.timeoutMs);
        const actual = comparableBody(JSON.stringify(reply.message));
        const ignored = ignoreMatcher(testCase.ignore);
        const changes = diffJson(testCase.expect, actual).filter((change) => !ignored(change.path));
        report({ name: testCase.name, server: key, status: changes.length === 0 ? 'pass' : 'fail', latencyMs: reply.latencyMs, changes, actual });
      } catch (error) {
        report({ name: testCase.name, server: key, status: 'error', latencyMs: null, changes: [], actual: undefined, error: (error as Error).message });
      }
    }
    await client.close();
  }

  return results;
}

/** Accepts the received responses as the new expectations (snapshot update). */
export function updateExpectations(suite: Suite, results: CaseResult[]): number {
  let updated = 0;
  for (const result of results) {
    if (result.status !== 'fail') continue;
    const testCase = suite.cases.find((existing) => existing.name === result.name);
    if (testCase) {
      testCase.expect = result.actual;
      updated++;
    }
  }
  return updated;
}

export function parseSuite(text: string): Suite {
  const suite = JSON.parse(text) as Suite;
  if (suite.version !== 1 || typeof suite.servers !== 'object' || !Array.isArray(suite.cases)) {
    throw new Error('not an mcpspy suite (expected version 1 with servers and cases)');
  }
  for (const testCase of suite.cases) {
    if (!suite.servers[testCase.server]) throw new Error(`case "${testCase.name}" refers to unknown server "${testCase.server}"`);
  }
  return suite;
}
