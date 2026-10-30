import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import AnthropicSdk from '@anthropic-ai/sdk';
import { describeApiError, ExactCounter, toResultContent } from '../src/exact.js';

/** A fake client whose count is the length of the request's JSON, so differences are predictable. */
function fakeClient() {
  const calls: Anthropic.MessageCountTokensParams[] = [];
  const client = {
    messages: {
      countTokens: async (params: Anthropic.MessageCountTokensParams) => {
        calls.push(params);
        const tools = (params.tools ?? []) as Anthropic.Tool[];
        // 100 tokens of preamble whenever tools are present, plus 10 per character of tool names.
        const toolTokens = tools.length > 0 ? 100 + tools.reduce((sum, tool) => sum + tool.name.length * 10, 0) : 0;
        return { input_tokens: 5 + toolTokens + JSON.stringify(params.messages).length };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('ExactCounter', () => {
  it('measures each tool by leaving it out and reports the shared overhead', async () => {
    const { client, calls } = fakeClient();
    const counter = new ExactCounter('claude-opus-5-5', client);
    const result = await counter.toolDefinitions([
      { name: 'ab', inputSchema: { type: 'object' } },
      { name: 'abcd', inputSchema: { type: 'object' } },
    ]);
    expect(result).toEqual({ total: 160, overhead: 100, tools: [{ name: 'ab', tokens: 20 }, { name: 'abcd', tokens: 40 }] });
    expect(calls.every((call) => call.model === 'claude-opus-5-5')).toBe(true);
    expect(calls[1]!.tools).toEqual([
      { name: 'ab', input_schema: { type: 'object' } },
      { name: 'abcd', input_schema: { type: 'object' } },
    ]);
  });

  it('measures a tool result as the difference from an empty result', async () => {
    const { client, calls } = fakeClient();
    const counter = new ExactCounter('claude-opus-5-5', client);
    const tokens = await counter.toolResult('search', [{ type: 'text', text: 'hello' }]);
    expect(tokens).toBe(JSON.stringify(calls[1]!.messages).length - JSON.stringify(calls[0]!.messages).length);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('toResultContent', () => {
  it('converts MCP content blocks to tool_result content', () => {
    expect(
      toResultContent([
        { type: 'text', text: 'hi' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'image', mimeType: 'image/bmp', data: 'AAAA' },
        { type: 'resource', resource: { uri: 'file:///a', text: 'body' } },
        null,
      ]),
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: '{"type":"image","mimeType":"image/bmp","data":"AAAA"}' },
      { type: 'text', text: 'body' },
    ]);
  });
});

describe('ExactCounter edge cases', () => {
  it('uses the baseline for a single tool, and builds its own client by default', async () => {
    const { client } = fakeClient();
    const result = await new ExactCounter('m', client).toolDefinitions([{ name: 'only' }]);
    expect(result.tools).toEqual([{ name: 'only', tokens: 140 }]);
    expect(new ExactCounter('m')).toBeInstanceOf(ExactCounter);
  });

  it('converts text without text and resources without text', () => {
    expect(toResultContent([{ type: 'text' }, { type: 'resource', resource: { blob: 'AA==' } }])).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: '{"type":"resource","resource":{"blob":"AA=="}}' },
    ]);
  });
});

describe('describeApiError', () => {
  const api = (status: number | undefined) => AnthropicSdk.APIError.generate(status, { error: { message: 'nope' } }, 'nope', new Headers());

  it('explains each kind of failure', () => {
    expect(describeApiError(api(401))).toBe('authentication failed: set ANTHROPIC_API_KEY or run `ant auth login`');
    expect(describeApiError(api(404))).toMatch(/^model not found: /);
    expect(describeApiError(api(429))).toBe('rate limited by the count_tokens endpoint; try again shortly');
    expect(describeApiError(api(500))).toMatch(/^API error 500: /);
    expect(describeApiError(new AnthropicSdk.APIError(undefined, undefined, 'offline', undefined))).toBe('API error : offline');
    expect(describeApiError(new AnthropicSdk.AnthropicError('no key'))).toBe('no key\nSet ANTHROPIC_API_KEY or run `ant auth login`.');
    expect(describeApiError(new Error('plain'))).toBe('plain');
    expect(describeApiError('text')).toBe('text');
  });
});
