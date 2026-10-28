import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { addCases, emptySuite, ignoreMatcher, parseSuite, runSuite, updateExpectations, type Suite } from '../src/suite.js';
import { echoServer, recordSession } from './helpers.js';

describe('replay suites', () => {
  let store: Store;
  let suitePath: string;
  beforeEach(() => {
    store = new Store(':memory:');
    suitePath = join(mkdtempSync(join(tmpdir(), 'mcpspy-suite-')), 'mcp.suite.json');
  });
  afterEach(() => store.close());

  it('adds recorded calls with their server, initialize and client replies', async () => {
    const recorded = await recordSession(store);
    const suite = emptySuite();
    const added = addCases(suite, suitePath, store, [recorded.echo, recorded.roots]);

    expect(added.map((testCase) => testCase.name)).toEqual(['tools/call echo', 'tools/call roots']);
    expect(Object.keys(suite.servers)).toEqual(['echo']);
    expect(suite.servers.echo).toMatchObject({
      command: [process.execPath, echoServer],
      initialize: { clientInfo: { name: 'agent', version: '9' } },
      clientReplies: { 'roots/list': { result: { roots: [{ uri: 'file:///work', name: 'work' }] } } },
    });
    expect(suite.cases[0]).toMatchObject({ method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } }, expect: { content: [{ type: 'text', text: 'hello' }] } });

    // Adding the same call again reuses the server and gets a unique name.
    addCases(suite, suitePath, store, [recorded.echo]);
    expect(Object.keys(suite.servers)).toHaveLength(1);
    expect(suite.cases[2]!.name).toBe('tools/call echo (2)');
    expect(() => addCases(suite, suitePath, store, [recorded.initialize])).toThrow(/initialize/);
  });

  it('stores the working directory relative to the suite when it is below it', async () => {
    const recorded = await recordSession(store);
    const session = store.getSession(store.getMessage(recorded.echo)!.session_id)!;
    const suite = emptySuite();
    addCases(suite, join(session.cwd, 'suites', 'a.json'), store, [recorded.echo]);
    expect(suite.servers.echo!.cwd).toBe(session.cwd);
    const nested = emptySuite();
    addCases(nested, join(dirname(session.cwd), 'a.json'), store, [recorded.echo]);
    expect(nested.servers.echo!.cwd).toBe(basename(session.cwd));
    const deeper = emptySuite();
    addCases(deeper, join(dirname(dirname(session.cwd)), 'a.json'), store, [recorded.echo]);
    expect(deeper.servers.echo!.cwd).toBe(`${basename(dirname(session.cwd))}/${basename(session.cwd)}`);
  });

  it('passes when responses match, fails with changes when they do not, and can update', async () => {
    const recorded = await recordSession(store);
    const suite = emptySuite();
    addCases(suite, suitePath, store, [recorded.echo, recorded.roots, recorded.time]);

    // time returns a timestamp, so it differs until ignored.
    let results = await runSuite(suite, suitePath);
    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['tools/call echo', 'pass'],
      ['tools/call roots', 'pass'],
      ['tools/call time', 'fail'],
    ]);
    expect(results[2]!.changes).toMatchObject([{ path: 'structuredContent.now', type: 'changed' }]);

    suite.cases[2]!.ignore = ['structuredContent.now'];
    results = await runSuite(suite, suitePath);
    expect(results.every((result) => result.status === 'pass')).toBe(true);

    // A changed expectation fails, and --update accepts what the server returns now.
    (suite.cases[0]!.expect as { content: { text: string }[] }).content[0]!.text = 'goodbye';
    results = await runSuite(suite, suitePath, { filter: 'echo' });
    expect(results).toHaveLength(1);
    expect(results[0]!.changes).toEqual([{ path: 'content[0].text', type: 'changed', before: 'goodbye', after: 'hello' }]);
    expect(updateExpectations(suite, results)).toBe(1);
    expect((await runSuite(suite, suitePath, { filter: 'echo' }))[0]!.status).toBe('pass');
  });

  it('reports every case of a server that cannot start as an error', async () => {
    const suite: Suite = {
      version: 1,
      servers: { broken: { command: ['/no/such/binary'], cwd: '.', initialize: {} } },
      cases: [
        { name: 'a', server: 'broken', method: 'tools/call', expect: {} },
        { name: 'b', server: 'broken', method: 'tools/call', expect: {} },
      ],
    };
    const results = await runSuite(suite, suitePath);
    expect(results.map((result) => result.status)).toEqual(['error', 'error']);
    expect(results[0]!.error).toMatch(/failed to start/);
  });
});

describe('ignoreMatcher', () => {
  it('matches paths at or below a pattern, with wildcards', () => {
    const ignored = ignoreMatcher(['structuredContent.now', 'content[*].text', 'meta.*.id']);
    expect(ignored('structuredContent.now')).toBe(true);
    expect(ignored('structuredContent.nowish')).toBe(false);
    expect(ignored('structuredContent.now.ms')).toBe(true);
    expect(ignored('content[3].text')).toBe(true);
    expect(ignored('content[3].type')).toBe(false);
    expect(ignored('meta.request.id')).toBe(true);
    expect(ignored('tools[name="x"]')).toBe(false);
    expect(ignoreMatcher(['tools[*]'])('tools[name="x"].description')).toBe(true);
  });
});

describe('parseSuite', () => {
  it('validates the file', () => {
    expect(() => parseSuite('{"version":2}')).toThrow(/not an mcpspy suite/);
    expect(() => parseSuite(JSON.stringify({ version: 1, servers: {}, cases: [{ name: 'x', server: 'nope' }] }))).toThrow(/unknown server/);
    expect(parseSuite(JSON.stringify(emptySuite()))).toEqual(emptySuite());
  });
});
