import { describe, expect, it } from 'vitest';
import { parsePolicy, PolicyEngine } from '../src/policy.js';
import { suggestPolicy, type RecordedCall } from '../src/policy-suggest.js';

describe('suggestPolicy', () => {
  const calls: RecordedCall[] = [
    { name: 'read_file', arguments: { path: '/work/app/src/a.ts', encoding: 'utf8' } },
    { name: 'read_file', arguments: { path: './src/lib/b.ts', encoding: 'utf8' } },
    { name: 'read_file', arguments: { path: 'file:///work/app/docs/c.md', encoding: 'utf8' } },
    { name: 'search', arguments: { query: 'needle', root: '/work/app' } },
    { name: 'list', arguments: { dir: '../app/x/' } },
    { name: 'mixed', arguments: { target: '/a/b' } },
    { name: 'mixed', arguments: { target: 'relative/c' } },
    { name: 'rooted', arguments: { path: '/etc/hosts' } },
    { name: 'rooted', arguments: { path: '/srv/x' } },
    { name: 'odd', arguments: [1] },
    { name: 'odd', arguments: undefined },
    { name: 'web', arguments: { url: 'file://remote-host/share/x' } },
    { name: 'sometimes', arguments: { path: '/work/a' } },
    { name: 'sometimes', arguments: {} },
  ];

  it('allows each called tool, keeping path arguments under the directories seen', () => {
    expect(suggestPolicy(calls, '/work/app')).toEqual({
      default: 'deny',
      rules: [
        { name: 'list (1 recorded call)', tool: 'list', where: { dir: { under: '/work/app' } }, allow: true },
        { name: 'mixed (2 recorded calls)', tool: 'mixed', allow: true },
        { name: 'odd (2 recorded calls)', tool: 'odd', allow: true },
        { name: 'read_file (3 recorded calls)', tool: 'read_file', where: { path: { under: '/work/app' } }, allow: true },
        { name: 'rooted (2 recorded calls)', tool: 'rooted', allow: true },
        { name: 'search (1 recorded call)', tool: 'search', where: { root: { under: '/work' } }, allow: true },
        { name: 'sometimes (2 recorded calls)', tool: 'sometimes', allow: true },
        { name: 'web (1 recorded call)', tool: 'web', allow: true },
      ],
    });
  });

  it('suggests a policy that parses and allows every recorded call', () => {
    const file = suggestPolicy(calls, '/work/app');
    const policy = new PolicyEngine(null, null, '/work/app', () => {}, parsePolicy(JSON.stringify(file), '/'));
    for (const call of calls) expect(policy.check('tools/call', { name: call.name, arguments: call.arguments }).allow).toBe(true);
    expect(policy.check('tools/call', { name: 'read_file', arguments: { path: '/etc/passwd' } }).allow).toBe(false);
    expect(policy.check('tools/call', { name: 'delete', arguments: {} }).allow).toBe(false);
    expect(suggestPolicy([], '/')).toEqual({ default: 'deny', rules: [] });
  });
});
