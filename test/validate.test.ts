import { describe, expect, it } from 'vitest';
import { SessionValidator } from '../src/validate.js';

const search = {
  name: 'search',
  inputSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', maximum: 50 } },
    required: ['query'],
    additionalProperties: false,
  },
};
const weather = {
  name: 'weather',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  outputSchema: {
    type: 'object',
    properties: { temperature: { type: 'number' }, conditions: { type: 'string' } },
    required: ['temperature'],
  },
};

function validator(tools: object[] = [search, weather]) {
  const instance = new SessionValidator();
  instance.toolList({ tools });
  return instance;
}

describe('SessionValidator.toolList', () => {
  it('accepts a well-formed tool list', () => {
    expect(new SessionValidator().toolList({ tools: [search, weather] })).toEqual([]);
  });

  it('flags duplicate names, odd names, and missing or broken schemas', () => {
    const issues = new SessionValidator().toolList({
      tools: [
        search,
        search,
        { name: 'has space', inputSchema: { type: 'object' } },
        { name: 'noschema' },
        { name: 'array', inputSchema: { type: 'array' } },
        { name: 'broken', inputSchema: { type: 'object', properties: { a: { type: 'nope' } } } },
      ],
    });
    expect(issues.map((issue) => [issue.severity, issue.path])).toEqual([
      ['error', 'result.tools[name="search"]'],
      ['warning', 'result.tools[name="has space"].name'],
      ['error', 'result.tools[name="noschema"].inputSchema'],
      ['error', 'result.tools[name="array"].inputSchema'],
      ['error', 'result.tools[name="broken"].inputSchema'],
    ]);
    expect(issues.at(-1)!.message).toMatch(/invalid JSON Schema/);
    expect(new SessionValidator().toolList({})).toMatchObject([{ path: 'result.tools' }]);
  });
});

describe('SessionValidator.toolCall', () => {
  it('validates arguments against the input schema (draft-07 and 2020-12)', () => {
    const v = validator();
    expect(v.toolCall({ name: 'search', arguments: { query: 'rust', limit: 10 } })).toEqual([]);
    expect(v.toolCall({ name: 'search', arguments: { limit: 99, extra: true } })).toEqual([
      { severity: 'error', path: 'params.arguments', message: 'missing required property "query"' },
      { severity: 'error', path: 'params.arguments', message: 'unexpected property "extra"' },
      { severity: 'error', path: 'params.arguments.limit', message: 'must be <= 50' },
    ]);
    expect(v.toolCall({ name: 'weather', arguments: { city: 7 } })).toMatchObject([{ path: 'params.arguments.city', message: 'must be string' }]);
  });

  it('flags tools the server never listed, but only once a list was seen', () => {
    expect(validator().toolCall({ name: 'nope' })).toMatchObject([{ message: '"nope" is not in the server\'s tool list' }]);
    expect(new SessionValidator().toolCall({ name: 'nope' })).toEqual([]);
  });

  it('checks formats', () => {
    const v = validator([{ name: 'fetch', inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } } }]);
    expect(v.toolCall({ name: 'fetch', arguments: { url: 'https://example.com' } })).toEqual([]);
    expect(v.toolCall({ name: 'fetch', arguments: { url: 'not a url' } })).toMatchObject([{ path: 'params.arguments.url' }]);
  });
});

describe('SessionValidator.toolResult', () => {
  it('checks content blocks', () => {
    const v = validator();
    expect(v.toolResult('search', { content: [{ type: 'text', text: 'hi' }] })).toEqual([]);
    expect(
      v.toolResult('search', {
        content: [{ type: 'text' }, { type: 'image', data: 'AA' }, { type: 'resource', resource: { uri: 'a' } }, { type: 'video' }],
        isError: 'no',
      }).map((issue) => issue.path),
    ).toEqual(['result.content[0].text', 'result.content[1].mimeType', 'result.content[2].resource', 'result.content[3].type', 'result.isError']);
    expect(v.toolResult('search', {})).toMatchObject([{ path: 'result.content' }]);
  });

  it('requires structuredContent matching the output schema, except for errors', () => {
    const v = validator();
    const content = [{ type: 'text', text: '{}' }];
    expect(v.toolResult('weather', { content, structuredContent: { temperature: 21 } })).toEqual([]);
    expect(v.toolResult('weather', { content })).toMatchObject([{ path: 'result.structuredContent', message: expect.stringMatching(/outputSchema/) }]);
    expect(v.toolResult('weather', { content, structuredContent: { temperature: 'warm' } })).toMatchObject([
      { path: 'result.structuredContent.temperature', message: 'must be number' },
    ]);
    expect(v.toolResult('weather', { content, isError: true })).toEqual([]);
  });
});
