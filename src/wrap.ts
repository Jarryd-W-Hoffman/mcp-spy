import { basename } from 'node:path';

/**
 * Puts mcpspy in front of the stdio servers in an agent's MCP config, and takes
 * it out again. Works on any JSON config that lists servers under `mcpServers`
 * (Claude Code, Cursor, Claude Desktop, Windsurf) or `servers` (VS Code).
 */
export interface WrapOptions {
  /** Only these servers (by name); all of them when empty. */
  only?: string[];
  /** What the agent should run for mcpspy, when `mcpspy` isn't on its PATH. */
  command?: string;
  db?: string;
  mocks?: string;
}

export interface WrapChange {
  name: string;
  outcome: 'wrapped' | 'unwrapped' | 'skipped';
  /** Why a server was skipped. */
  reason?: string;
}

type Entry = Record<string, unknown>;

const SERVER_KEYS = ['mcpServers', 'servers'] as const;

export function wrapConfig(config: unknown, options: WrapOptions = {}): { config: unknown; changes: WrapChange[] } {
  return transform(config, options, (name, entry) => {
    if (!isStdio(entry)) return skip(name, `reached over HTTP: run mcpspy proxy ${remoteUrl(entry) ?? '<url>'} and point the agent at it`);
    if (isWrapped(entry)) return skip(name, 'already wrapped');
    const args = [
      'run',
      '--name',
      name,
      ...(options.db !== undefined ? ['--db', options.db] : []),
      ...(options.mocks !== undefined ? ['--mocks', options.mocks] : []),
      '--',
      entry.command as string,
      ...stringArgs(entry),
    ];
    return { entry: withCommand(entry, options.command ?? 'mcpspy', args), change: { name, outcome: 'wrapped' } };
  });
}

export function unwrapConfig(config: unknown, options: Pick<WrapOptions, 'only'> = {}): { config: unknown; changes: WrapChange[] } {
  return transform(config, options, (name, entry) => {
    if (!isStdio(entry) || !isWrapped(entry)) return skip(name, 'not wrapped');
    const args = entry.args as string[];
    const separator = args.indexOf('--');
    return {
      entry: withCommand(entry, args[separator + 1]!, args.slice(separator + 2)),
      change: { name, outcome: 'unwrapped' },
    };
  });
}

function transform(
  config: unknown,
  options: Pick<WrapOptions, 'only'>,
  change: (name: string, entry: Entry) => { entry: Entry | null; change: WrapChange },
): { config: unknown; changes: WrapChange[] } {
  if (!isObject(config) || !SERVER_KEYS.some((key) => isObject(config[key]))) {
    throw new Error('no MCP servers here: expected an "mcpServers" or "servers" object');
  }
  const only = new Set(options.only ?? []);
  const changes: WrapChange[] = [];
  const result: Entry = { ...config };

  for (const key of SERVER_KEYS) {
    const servers = config[key];
    if (!isObject(servers)) continue;
    const updated: Entry = {};
    for (const [name, entry] of Object.entries(servers)) {
      if ((only.size > 0 && !only.has(name)) || !isObject(entry)) {
        updated[name] = entry;
        continue;
      }
      const outcome = change(name, entry);
      updated[name] = outcome.entry ?? entry;
      changes.push(outcome.change);
    }
    result[key] = updated;
  }

  for (const name of only) {
    if (!changes.some((c) => c.name === name)) throw new Error(`no server named "${name}"`);
  }
  return { config: result, changes };
}

function skip(name: string, reason: string): { entry: null; change: WrapChange } {
  return { entry: null, change: { name, outcome: 'skipped', reason } };
}

/** The entry with a new command and args, keeping its other keys where they were. */
function withCommand(entry: Entry, command: string, args: string[]): Entry {
  const result: Entry = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'command') {
      result.command = command;
      // An entry without args gets them right after its command.
      if (!('args' in entry) && args.length > 0) result.args = args;
    } else if (key === 'args') {
      if (args.length > 0) result.args = args;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isStdio(entry: Entry): boolean {
  return typeof entry.command === 'string' && (entry.type === undefined || entry.type === 'stdio');
}

/** Whether the entry already runs its server through mcpspy run. */
function isWrapped(entry: Entry): boolean {
  const args = stringArgs(entry);
  return /^mcpspy(\.cmd|\.exe)?$/i.test(basename(entry.command as string)) && args[0] === 'run' && args.indexOf('--') >= 0 && args.indexOf('--') < args.length - 1;
}

function stringArgs(entry: Entry): string[] {
  return Array.isArray(entry.args) ? entry.args.map(String) : [];
}

function remoteUrl(entry: Entry): string | null {
  const url = entry.url ?? entry.serverUrl;
  return typeof url === 'string' ? url : null;
}

function isObject(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
