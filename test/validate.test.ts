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

describe('more validation', () => {
  it('unwraps CommonJS default exports', async () => {
    const { interopDefault } = await import('../src/validate.js');
    const fn = () => {};
    expect(interopDefault({ default: fn })).toBe(fn);
    expect(interopDefault(fn)).toBe(fn);
  });

  it('flags malformed tools and skips argument checks it cannot do', () => {
    const validator = new SessionValidator();
    expect(validator.toolList({ tools: ['nope', { name: 'a', inputSchema: 'x' }, { name: 'b', inputSchema: { type: 'object', properties: 5 } }] })).toEqual([
      { severity: 'error', path: 'result.tools[0]', message: 'tool must be an object with a string name' },
      { severity: 'error', path: 'result.tools[name="a"].inputSchema', message: 'schema must be a JSON Schema object with type "object"' },
      { severity: 'error', path: 'result.tools[name="b"].inputSchema', message: expect.stringMatching(/^invalid JSON Schema: /) },
    ]);
    expect(validator.toolCall({ name: 'a', arguments: { anything: 1 } })).toEqual([]);
    expect(validator.toolCall({ name: 'b' })).toEqual([]);
  });

  it('checks every kind of content block', () => {
    const validator = new SessionValidator();
    expect(validator.toolResult(null, 'x')).toEqual([{ severity: 'error', path: 'result', message: 'tools/call result must be an object' }]);
    const issues = validator.toolResult(null, {
      content: [
        7,
        { type: 'resource_link', uri: 'file:///a' },
        { type: 'resource', resource: 'x' },
        { type: 'resource', resource: { uri: 'file:///b' } },
        { type: 'resource', resource: { text: 'hi' } },
        { type: 'resource', resource: { uri: 'file:///c', blob: 'AA==' } },
      ],
    });
    expect(issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
      'result.content[0]: content block must be an object',
      'result.content[1].name: resource_link content needs a string "name"',
      'result.content[2].resource: resource content needs a object "resource"',
      'result.content[3].resource: embedded resource needs text or blob',
      'result.content[4].resource.uri: embedded resource needs a uri',
    ]);
  });

  it('points into arrays by index', () => {
    const validator = new SessionValidator();
    validator.toolList({ tools: [{ name: 'list', inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } } }] });
    expect(validator.toolCall({ name: 'list', arguments: { items: ['a', 2] } })).toEqual([
      { severity: 'error', path: 'params.arguments.items[1]', message: 'must be string' },
    ]);
  });

  it('ignores unreadable payloads', async () => {
    const { calledTool, checkMessage } = await import('../src/validate.js');
    expect(checkMessage(new SessionValidator(), { direction: 'client', kind: 'request', method: 'tools/call', payload: '{' }, null)).toEqual([]);
    expect(calledTool('{')).toBeNull();
  });
});

describe('protocol checks', () => {
  type Sent = { from: 'client' | 'server'; kind: string; method: string; body?: object };
  /** Runs messages through checkMessage, returning each one's issues as "path: message". */
  const run = async (messages: Sent[]) => {
    const { checkMessage } = await import('../src/validate.js');
    const validator = new SessionValidator();
    return messages.map(({ from, kind, method, body = {} }) =>
      checkMessage(validator, { direction: from, kind, method, payload: JSON.stringify({ jsonrpc: '2.0', ...body }) }, null).map(
        (issue) => `${issue.severity} ${issue.path}: ${issue.message}`,
      ),
    );
  };
  const initialize = (capabilities?: object): Sent => ({ from: 'client', kind: 'request', method: 'initialize', body: { params: capabilities ? { capabilities } : {} } });
  const initialized = (capabilities: object = {}): Sent => ({
    from: 'server',
    kind: 'response',
    method: 'initialize',
    body: { result: { protocolVersion: '2025-06-18', capabilities, serverInfo: { name: 's', version: '1' } } },
  });

  it('checks the initialize result', async () => {
    const result = (result: unknown): Sent => ({ from: 'server', kind: 'response', method: 'initialize', body: { result } });
    expect(await run([result('x'), result({}), result({ protocolVersion: '1', capabilities: {}, serverInfo: { name: 1 } }), initialized()])).toEqual([
      ['error result: initialize result must be an object'],
      [
        'error result.protocolVersion: initialize result needs a protocolVersion string',
        'error result.capabilities: initialize result needs a capabilities object',
        'error result.serverInfo: initialize result needs serverInfo with a name and version',
      ],
      ['error result.serverInfo.name: serverInfo needs a string name', 'error result.serverInfo.version: serverInfo needs a string version'],
      [],
    ]);
  });

  it('warns about requests sent before initialize was answered, pings aside', async () => {
    const request = (method: string): Sent => ({ from: 'client', kind: 'request', method });
    expect(await run([request('tools/list'), initialize(), request('ping'), request('tools/list'), initialized({ tools: {} }), request('tools/list')])).toEqual([
      [],
      [],
      [],
      ['warning method: tools/list was sent before the server answered initialize'],
      [],
      [],
    ]);
  });

  it('checks requests against the capabilities the other side declared', async () => {
    const client = (method: string): Sent => ({ from: 'client', kind: 'request', method });
    const server = (method: string): Sent => ({ from: 'server', kind: 'request', method });
    const issues = await run([
      initialize({ roots: {} }),
      initialized({ tools: {}, logging: {} }),
      client('tools/list'),
      client('logging/setLevel'),
      client('resources/read'),
      client('prompts/get'),
      client('completion/complete'),
      client('custom/thing'),
      server('roots/list'),
      server('sampling/createMessage'),
      server('elicitation/create'),
      server('ping'),
    ]);
    expect(issues.slice(2)).toEqual([
      [],
      [],
      ['warning method: resources/read needs the "resources" capability, which the server didn\'t declare in initialize'],
      ['warning method: prompts/get needs the "prompts" capability, which the server didn\'t declare in initialize'],
      ['warning method: completion/complete needs the "completions" capability, which the server didn\'t declare in initialize'],
      [],
      [],
      ['error method: sampling/createMessage needs the "sampling" capability, which the client didn\'t declare in initialize'],
      ['error method: elicitation/create needs the "elicitation" capability, which the client didn\'t declare in initialize'],
      [],
    ]);
  });

  it('holds completion requests to the completions capability only from the version that added it', async () => {
    const answer = (protocolVersion?: string): Sent => ({ from: 'server', kind: 'response', method: 'initialize', body: { result: { protocolVersion, capabilities: {} } } });
    const complete: Sent = { from: 'client', kind: 'request', method: 'completion/complete' };
    const issues = async (protocolVersion?: string) => (await run([initialize(), answer(protocolVersion), complete]))[2];
    expect(await issues('2024-11-05')).toEqual([]);
    expect(await issues(undefined)).toEqual([]);
    expect(await issues('2025-03-26')).toEqual([expect.stringContaining('needs the "completions" capability')]);
  });

  it('checks notifications against the capabilities their sender declared', async () => {
    const notify = (from: 'client' | 'server', method: string): Sent => ({ from, kind: 'notification', method });
    const issues = await run([
      notify('server', 'notifications/tools/list_changed'),
      initialize({ roots: { listChanged: true } }),
      initialized({ tools: { listChanged: true }, resources: { subscribe: true }, prompts: 'x' }),
      notify('server', 'notifications/tools/list_changed'),
      notify('server', 'notifications/resources/updated'),
      notify('server', 'notifications/resources/list_changed'),
      notify('server', 'notifications/prompts/list_changed'),
      notify('client', 'notifications/roots/list_changed'),
      notify('server', 'notifications/message'),
    ]);
    expect(issues).toEqual([
      [],
      [],
      [],
      [],
      [],
      ['warning method: notifications/resources/list_changed needs "resources": { "listChanged": true } in the server\'s capabilities, which it didn\'t declare'],
      ['warning method: notifications/prompts/list_changed needs "prompts": { "listChanged": true } in the server\'s capabilities, which it didn\'t declare'],
      [],
      [],
    ]);
  });

  it("treats a malformed initialize as declaring nothing, and judges nothing of sessions it joined midway", async () => {
    expect(
      await run([
        { from: 'client', kind: 'request', method: 'tools/call', body: { params: { name: 'x' } } },
        { from: 'server', kind: 'request', method: 'sampling/createMessage' },
        { from: 'client', kind: 'request', method: 'initialize', body: { params: { capabilities: 'x' } } },
        { from: 'server', kind: 'response', method: 'initialize', body: { result: { capabilities: [] } } },
        { from: 'server', kind: 'request', method: 'roots/list' },
        { from: 'client', kind: 'request', method: 'prompts/list' },
      ]),
    ).toEqual([
      [],
      [],
      [],
      expect.arrayContaining(['error result.capabilities: initialize result needs a capabilities object']),
      ['error method: roots/list needs the "roots" capability, which the client didn\'t declare in initialize'],
      ['warning method: prompts/list needs the "prompts" capability, which the server didn\'t declare in initialize'],
    ]);
  });

  it('checks resource and prompt results', async () => {
    const reply = (method: string, result: unknown): Sent => ({ from: 'server', kind: 'response', method, body: { result } });
    expect(
      await run([
        reply('resources/list', { resources: [{ uri: 'file:///a', name: 'a' }, { uri: 1 }, 'x'] }),
        reply('resources/templates/list', { resourceTemplates: [{ uriTemplate: 'file:///{p}' }] }),
        reply('resources/read', { contents: [{ uri: 'file:///a', text: 'hi' }, { uri: 'file:///b', blob: 'AA==' }, { uri: 'file:///c' }] }),
        reply('prompts/list', { prompts: [{ name: 'p' }, {}] }),
        reply('prompts/get', { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }, { role: 'system', content: { type: 'text' } }] }),
        reply('prompts/get', null),
        reply('ping', {}),
      ]),
    ).toEqual([
      ['error result.resources[1].uri: needs a string "uri"', 'error result.resources[1].name: needs a string "name"', 'error result.resources[2]: resources entries must be objects'],
      ['error result.resourceTemplates[0].name: needs a string "name"'],
      ['error result.contents[2]: resource contents need text or blob'],
      ['error result.prompts[1].name: needs a string "name"'],
      ['error result.messages[1].role: role must be "user" or "assistant"', 'error result.messages[1].content.text: text content needs a string "text"'],
      ['error result.messages: prompts/get result must have a messages array'],
      [],
    ]);
  });

  it('skips stderr, and payloads that are not JSON objects', async () => {
    const { checkMessage } = await import('../src/validate.js');
    const validator = new SessionValidator();
    expect(checkMessage(validator, { direction: 'stderr', kind: 'log', method: 'x', payload: '{}' }, null)).toEqual([]);
    expect(checkMessage(validator, { direction: 'client', kind: 'request', method: 'x', payload: '[]' }, null)).toEqual([]);
  });
});
