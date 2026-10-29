import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compilePatterns, REDACTED, Redactor } from '../src/redact.js';
import { Recorder } from '../src/recorder.js';
import { replay } from '../src/replay.js';
import { Store } from '../src/store.js';

const redactor = new Redactor();

describe('Redactor', () => {
  it.each([
    ['a GitHub token', 'ghp_0123456789abcdefghijABCDEFGHIJ012345'],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
    ['an Anthropic key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'],
    ['an OpenAI key', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123'],
    ['an AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['a Slack token', 'xoxb-1234567890-abcdefghij'],
    ['a Stripe key', 'sk_live_abcdefghijklmnop1234'],
    ['a Google API key', 'AIzaSyA-0123456789abcdefghijklmnopqrstu'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ])('removes %s from text', (_label, secret) => {
    const redacted = redactor.text(`before ${secret} after`);
    expect(redacted).toBe(`before ${REDACTED} after`);
  });

  it('keeps the parts around a secret that explain it', () => {
    expect(redactor.text('Authorization: Bearer abc123def456ghi789')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactor.text('postgres://app:hunter2@db.internal/app')).toBe(`postgres://app:${REDACTED}@db.internal/app`);
    expect(redactor.text('https://x.dev/mcp?team=core&api_key=abc123&page=2')).toBe(`https://x.dev/mcp?team=core&api_key=${REDACTED}&page=2`);
    expect(redactor.text('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    const prose = 'Basic authentication and Bearer instruments; a task-runner; progressToken 5; https://example.com/a?page=2';
    expect(redactor.text(prose)).toBe(prose);
  });

  it('replaces the values of secret keys in JSON, and nothing else', () => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'login',
        arguments: { username: 'ada', password: 'hunter2', API_KEY: 12345, 'client-secret': 's', token: '', max_tokens: 50 },
        _meta: { progressToken: 'p1' },
      },
    });
    expect(JSON.parse(redactor.json(payload)).params).toEqual({
      name: 'login',
      arguments: { username: 'ada', password: REDACTED, API_KEY: REDACTED, 'client-secret': REDACTED, token: '', max_tokens: 50 },
      _meta: { progressToken: 'p1' },
    });
  });

  it('returns JSON without secrets byte for byte', () => {
    const payload = '{"jsonrpc": "2.0",  "id": 1, "result": {}}';
    expect(redactor.json(payload)).toBe(payload);
  });

  it('applies extra patterns, with or without the built-in ones', () => {
    const custom = new Redactor({ builtIn: false, patterns: compilePatterns(['acct-\\d+']) });
    expect(custom.text('acct-42 ghp_0123456789abcdefghijABCDEFGHIJ012345')).toBe(`${REDACTED} ghp_0123456789abcdefghijABCDEFGHIJ012345`);
    expect(JSON.parse(custom.json('{"password":"x","note":"acct-7"}'))).toEqual({ password: 'x', note: REDACTED });
    expect(new Redactor({ builtIn: false }).active).toBe(false);
    expect(() => compilePatterns(['('])).toThrow('--redact "(" is not a valid regular expression');
  });
});

describe('recording with redaction', () => {
  let store: Store;
  beforeEach(() => (store = new Store(':memory:')));
  afterEach(() => store.close());

  it('records requests, responses and stderr without their secrets', () => {
    const sessionId = store.createSession({ name: 's', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    const recorder = new Recorder(store, sessionId);
    recorder.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"apiKey":"k-123"}}}');
    recorder.frame('server', '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"token is ghp_0123456789abcdefghijABCDEFGHIJ012345"}]}}');
    recorder.stderr('using Authorization: Bearer abc123def456ghi789');
    const all = JSON.stringify(store.messagesAfter(0, { sessionId }));
    expect(all).not.toMatch(/k-123|ghp_0123|abc123def/);
    expect(store.messagesAfter(0, { sessionId })[1]!.request_id).not.toBeNull();
  });

  it('refuses to replay what it never recorded', async () => {
    const make = (command: string[]) => store.createSession({ name: 's', transport: 'stdio', command: JSON.stringify(command), cwd: '/', pid: null, started_at: 0 });
    const withSecretArg = new Recorder(store, make(['server', '--key', REDACTED]));
    const [first] = withSecretArg.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    await expect(replay({ store, messageId: first! })).rejects.toThrow("the server's command line held a secret");

    const withSecretParams = new Recorder(store, make(['node', 'server.js']));
    const [second] = withSecretParams.frame('client', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"password":"p"}}}');
    await expect(replay({ store, messageId: second! })).rejects.toThrow('pass its arguments with --args');
  });
});
