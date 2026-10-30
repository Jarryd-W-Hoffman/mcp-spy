import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyFile, PolicyRule } from './policy.js';

export interface RecordedCall {
  name: string;
  arguments: unknown;
}

/**
 * A starting policy from recorded tool calls: deny by default, allow each
 * tool that was called, and keep path arguments under the deepest directory
 * that held every path seen. It allows what the session did and nothing it
 * didn't, so it is a draft to review, not a verdict.
 */
export function suggestPolicy(calls: RecordedCall[], cwd: string): PolicyFile {
  const byTool = new Map<string, Record<string, unknown>[]>();
  for (const call of calls) {
    const args = typeof call.arguments === 'object' && call.arguments !== null && !Array.isArray(call.arguments) ? (call.arguments as Record<string, unknown>) : {};
    byTool.set(call.name, [...(byTool.get(call.name) ?? []), args]);
  }

  const rules: PolicyRule[] = [...byTool.keys()].sort().map((tool) => {
    const seen = byTool.get(tool)!;
    const where: NonNullable<PolicyRule['where']> = {};
    // Arguments present in every call whose values are all paths.
    for (const key of Object.keys(seen[0]!).sort()) {
      const paths = seen.map((args) => asPath(args[key], cwd));
      if (paths.some((path) => path === null)) continue;
      const root = commonDirectory(paths.map((path) => dirname(path!)));
      if (root !== null) where[key] = { under: root };
    }
    return {
      name: `${tool} (${seen.length} recorded ${seen.length === 1 ? 'call' : 'calls'})`,
      tool,
      ...(Object.keys(where).length > 0 ? { where } : {}),
      allow: true as const,
    };
  });
  return { default: 'deny', rules };
}

/** An absolute path for path-like strings (absolute, ./ or ../ relative, or file: URIs), else null. */
function asPath(value: unknown, cwd: string): string | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('file:')) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (isAbsolute(value)) return resolve(value);
  if (value.startsWith('./') || value.startsWith('../')) return resolve(cwd, value);
  return null;
}

/** The deepest directory containing all of `dirs`, or null when that's the filesystem root. */
function commonDirectory(dirs: string[]): string | null {
  let common = dirs[0]!.split(sep);
  for (const dir of dirs.slice(1)) {
    const parts = dir.split(sep);
    let same = 0;
    while (same < common.length && same < parts.length && common[same] === parts[same]) same++;
    common = common.slice(0, same);
  }
  const joined = common.join(sep);
  return joined === '' ? null : joined;
}
