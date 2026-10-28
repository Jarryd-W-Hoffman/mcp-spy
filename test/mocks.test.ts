import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containsSubset, interpolate, MockEngine, parseMockFile, type MockFile } from '../src/mocks.js';

const engine = (file: MockFile, server: string | null = 'docs', random = () => 0) => new MockEngine(null, server, () => {}, file, random);

describe('MockEngine.decide', () => {
  it('answers matching tool calls and forwards everything else', () => {
    const mocks = engine({ rules: [{ match: { tool: 'search' }, text: 'mocked' }] });
    expect(mocks.decide('tools/call', { name: 'search', arguments: {} })).toEqual({
      action: 'respond',
      rule: 'rules[0]',
      delayMs: 0,
      reply: { result: { content: [{ type: 'text', text: 'mocked' }] } },
    });
    expect(mocks.decide('tools/call', { name: 'fetch' })).toBeNull();
    expect(mocks.decide('tools/list', {})).toBeNull();
  });

  it('matches on method, tool globs, argument subsets and server name, first rule wins', () => {
    const mocks = engine({
      rules: [
        { name: 'rust', match: { tool: 'search*', arguments: { query: 'rust', filters: { lang: 'en' } } }, text: 'rust results' },
        { name: 'other server', match: { tool: 'search', server: 'github' }, text: 'never' },
        { name: 'any search', match: { tool: 'search*' }, toolError: 'down' },
        { name: 'resources', match: { method: 'resources/read' }, error: { code: -32002, message: 'not found' } },
      ],
    });
    expect(mocks.decide('tools/call', { name: 'search_docs', arguments: { query: 'rust', filters: { lang: 'en', x: 1 }, limit: 5 } })).toMatchObject({ rule: 'rust' });
    expect(mocks.decide('tools/call', { name: 'search', arguments: { query: 'go' } })).toMatchObject({
      rule: 'any search',
      reply: { result: { isError: true, content: [{ text: 'down' }] } },
    });
    expect(mocks.decide('resources/read', { uri: 'x' })).toMatchObject({ reply: { error: { code: -32002 } } });
    const byUri = engine({ rules: [{ match: { method: 'resources/read', params: { uri: 'file:///a' } }, result: { contents: [] } }] });
    expect(byUri.decide('resources/read', { uri: 'file:///a' })).not.toBeNull();
    expect(byUri.decide('resources/read', { uri: 'file:///b' })).toBeNull();
  });

  it('supports passthrough with delay, drop, times and probability', () => {
    const mocks = engine({
      rules: [
        { name: 'slow', match: { tool: 'slow' }, passthrough: true, delayMs: 500 },
        { name: 'hang', match: { tool: 'hang' }, drop: true },
        { name: 'once', match: { tool: 'once' }, text: 'first', times: 1 },
        { name: 'flaky', match: { tool: 'flaky' }, toolError: 'boom', probability: 0.3 },
      ],
    });
    expect(mocks.decide('tools/call', { name: 'slow' })).toEqual({ action: 'passthrough', rule: 'slow', delayMs: 500 });
    expect(mocks.decide('tools/call', { name: 'hang' })).toEqual({ action: 'drop', rule: 'hang' });
    expect(mocks.decide('tools/call', { name: 'once' })).toMatchObject({ rule: 'once' });
    expect(mocks.decide('tools/call', { name: 'once' })).toBeNull();

    let roll = 0.5;
    const flaky = engine({ rules: [{ match: { tool: 'flaky' }, toolError: 'boom', probability: 0.3 }] }, null, () => roll);
    expect(flaky.decide('tools/call', { name: 'flaky' })).toBeNull();
    roll = 0.1;
    expect(flaky.decide('tools/call', { name: 'flaky' })).not.toBeNull();
  });

  it('fills {{…}} templates from the request', () => {
    const mocks = engine({ rules: [{ match: { tool: 'weather' }, result: { content: [{ type: 'text', text: 'Sunny in {{arguments.city}}' }], structuredContent: { city: '{{arguments.city}}', raw: '{{params}}' } } }] });
    expect(mocks.decide('tools/call', { name: 'weather', arguments: { city: 'Perth' } })).toMatchObject({
      reply: { result: { content: [{ text: 'Sunny in Perth' }], structuredContent: { city: 'Perth', raw: '{"name":"weather","arguments":{"city":"Perth"}}' } } },
    });
  });
});

describe('MockEngine tools', () => {
  it('adds mock tools to a tool list, replacing real ones with the same name', () => {
    const mocks = engine({ tools: [{ name: 'search', inputSchema: { type: 'object' }, description: 'mocked' }, { name: 'extra', inputSchema: { type: 'object' } }] });
    const patched = mocks.patchToolList({ tools: [{ name: 'search', description: 'real' }, { name: 'fetch' }], _meta: { x: 1 } }) as { tools: { name: string; description?: string }[]; _meta: unknown };
    expect(patched.tools.map((tool) => [tool.name, tool.description])).toEqual([
      ['fetch', undefined],
      ['search', 'mocked'],
      ['extra', undefined],
    ]);
    expect(patched._meta).toEqual({ x: 1 });
  });
});

describe('mock files', () => {
  it('rejects rules without exactly one action and other mistakes', () => {
    expect(() => parseMockFile('{"rules":[{"match":{}}]}')).toThrow(/exactly one of/);
    expect(() => parseMockFile('{"rules":[{"name":"x","match":{},"text":"a","drop":true}]}')).toThrow(/rule "x" needs exactly one.*has text, drop/);
    expect(() => parseMockFile('{"rules":[{"text":"a"}]}')).toThrow(/needs a "match"/);
    expect(() => parseMockFile('{"rules":[{"match":{},"error":{"message":"x"}}]}')).toThrow(/numeric code/);
    expect(() => parseMockFile('{"tools":[{"name":"t"}]}')).toThrow(/inputSchema/);
    expect(() => parseMockFile('{"rules":[{"match":{},"text":"a","probability":2}]}')).toThrow(/probability/);
    expect(parseMockFile('{"rules":[{"match":{"tool":"a"},"passthrough":true,"delayMs":10}]}').rules).toHaveLength(1);
  });

  it('reloads when the file changes and keeps the old rules if the new ones are broken', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mcpspy-mocks-')), 'mocks.json');
    writeFileSync(path, JSON.stringify({ rules: [{ match: { tool: 'a' }, text: 'one' }] }));
    const warnings: string[] = [];
    const mocks = new MockEngine(path, null, (message) => warnings.push(message));
    expect(mocks.decide('tools/call', { name: 'a' })).toMatchObject({ reply: { result: { content: [{ text: 'one' }] } } });

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(path, JSON.stringify({ rules: [{ match: { tool: 'a' }, text: 'two' }] }));
    expect(mocks.decide('tools/call', { name: 'a' })).toMatchObject({ reply: { result: { content: [{ text: 'two' }] } } });
    expect(warnings.at(-1)).toMatch(/reloaded/);

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(path, '{ not json');
    expect(mocks.decide('tools/call', { name: 'a' })).toMatchObject({ reply: { result: { content: [{ text: 'two' }] } } });
    expect(warnings.at(-1)).toMatch(/kept previous mock rules/);

    expect(() => new MockEngine(join(path, '..', 'missing.json'), null)).toThrow(/missing\.json/);
  });
});

describe('helpers', () => {
  it('matches subsets', () => {
    expect(containsSubset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(containsSubset({ a: [1, 2] }, { a: [1] })).toBe(false);
    expect(containsSubset({ a: null }, { a: null })).toBe(true);
    expect(containsSubset('x', { a: 1 })).toBe(false);
  });

  it('leaves unknown template paths alone', () => {
    expect(interpolate('{{arguments.nope}} and {{ arguments.city }}', { arguments: { city: 'Oslo' } })).toBe('{{arguments.nope}} and Oslo');
  });
});

describe('rulesFromRecording', () => {
  it('turns a recorded tool call into a rule that reproduces it', async () => {
    const { rulesFromRecording } = await import('../src/mocks.js');
    const { rule, tool } = rulesFromRecording(
      { id: 7, method: 'tools/call', payload: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"q":"x"}}}' },
      { payload: '{"jsonrpc":"2.0","id":1,"result":{"content":[]}}' },
      { name: 'search', inputSchema: { type: 'object' } },
    );
    expect(rule).toEqual({ name: 'search (recorded #7)', match: { tool: 'search', arguments: { q: 'x' } }, result: { content: [] } });
    expect(tool?.name).toBe('search');
    expect(engine({ rules: [rule] }).decide('tools/call', { name: 'search', arguments: { q: 'x' } })).toMatchObject({ reply: { result: { content: [] } } });

    const other = rulesFromRecording(
      { id: 8, method: 'resources/read', payload: '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"file:///a"}}' },
      { payload: '{"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"missing"}}' },
      undefined,
    );
    expect(other.rule).toEqual({ name: 'resources/read (recorded #8)', match: { method: 'resources/read', params: { uri: 'file:///a' } }, error: { code: -32002, message: 'missing' } });
  });
});
