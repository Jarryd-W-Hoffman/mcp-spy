import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logIn, type Login } from '../src/proxy/oauth.js';
import { startHttpProxy } from '../src/proxy/http.js';
import { Store } from '../src/store.js';
import { startOAuthFixture, type OAuthFixture } from './fixtures/oauth-server.js';

describe('logging in with OAuth', () => {
  let fixture: OAuthFixture;
  let login: Login | undefined;
  const warnings: string[] = [];
  const opened: string[] = [];
  /** The user's browser: follows the login page's redirect back to mcpspy's callback. */
  const browser = (url: string) => {
    opened.push(url);
    void fetch(url).then((response) => response.text());
  };
  const start = (options: { open?: (url: string) => void; timeoutMs?: number; fetch?: typeof fetch } = {}) =>
    logIn(fixture.url, { open: browser, warn: (message) => warnings.push(message), ...options }).then((started) => (login = started));
  const requests = (path: string) => fixture.log.filter((request) => request.path.startsWith(path));
  const meta = (path: string) => fixture.documents[path] as Record<string, unknown>;

  beforeEach(async () => {
    fixture = await startOAuthFixture();
    warnings.length = 0;
    opened.length = 0;
  });
  afterEach(async () => {
    await login?.close();
    login = undefined;
    await fixture.close();
  });

  it('registers, logs in with PKCE for this server, and gives the token', async () => {
    await start();
    expect(login!.header()).toBe('Bearer token-1');

    const registered = JSON.parse(requests('/register')[0]!.body) as { redirect_uris: string[]; token_endpoint_auth_method: string };
    expect(registered).toMatchObject({ client_name: 'mcpspy', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    const callback = registered.redirect_uris[0]!;
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const query = new URL(opened[0]!).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      response_type: 'code',
      client_id: 'mcpspy-client',
      redirect_uri: callback,
      code_challenge_method: 'S256',
      resource: fixture.url,
      scope: 'notes:read', // from the 401, over the metadata's list
    });
    expect(warnings).toEqual([`log in to ${fixture.origin} in your browser; if it didn't open, visit ${opened[0]}`]);
    // The callback takes one answer: a stray or replayed one is turned away.
    const replay = await fetch(`${callback}?code=x&state=${query.get('state')}`);
    expect([replay.status, await replay.text()]).toEqual([400, 'mcpspy is not expecting this login.']);
  });

  it('refreshes before the token runs out, and renews when the server refuses it', async () => {
    fixture.expiresIn = 1;
    await start();
    await expect.poll(() => login!.header(), { timeout: 3000 }).toBe('Bearer token-2');
    const refresh = new URLSearchParams(requests('/token').at(-1)!.body);
    expect(Object.fromEntries(refresh)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'mcpspy-client', resource: fixture.url });

    // The kept refresh token still works for the next one; renewals at once share one request.
    fixture.expiresIn = undefined;
    login!.expired();
    login!.expired();
    await expect.poll(() => login!.header()).toBe('Bearer token-3');
    expect(new URLSearchParams(requests('/token').at(-1)!.body).get('refresh_token')).toBe('refresh-1');
    expect(requests('/token')).toHaveLength(3);
    expect(opened).toHaveLength(1);
  });

  it('logs in again when refreshing fails or there is no refresh token, and keeps the old token if that fails', async () => {
    await start();
    fixture.refreshFails = 400;
    login!.expired();
    await expect.poll(() => login!.header()).toBe('Bearer token-2');
    expect(warnings[1]).toBe("couldn't refresh the login (the login service refused mcpspy's token request: invalid_grant); log in again");
    expect(opened).toHaveLength(2);

    fixture.refreshTokens = false;
    fixture.refreshFails = null;
    login!.expired(); // refresh-2 still exists, so this refreshes
    await expect.poll(() => login!.header()).toBe('Bearer token-3');
    fixture.refreshTokens = true;
    login!.expired();
    await expect.poll(() => login!.header()).toBe('Bearer token-4');

    fixture.deny = 'access_denied';
    fixture.refreshFails = 400;
    login!.expired();
    await expect.poll(() => warnings.at(-1)).toBe('login failed: the login service said: access_denied');
    expect(login!.header()).toBe('Bearer token-4');

    // After closing, a refused token isn't followed by a login page.
    await login!.close();
    const pages = opened.length;
    login!.expired();
    await expect.poll(() => warnings.at(-1)).toMatch(/^couldn't refresh/);
    expect(opened).toHaveLength(pages);
  });

  it('renews without a refresh token by logging in again', async () => {
    fixture.refreshTokens = false;
    await start();
    login!.expired();
    await expect.poll(() => login!.header()).toBe('Bearer token-2');
    expect(opened).toHaveLength(2);
  });

  it('finds the metadata at the well-known URLs when the server says nothing', async () => {
    fixture.challenge = null;
    await start();
    expect(new URL(opened[0]!).searchParams.get('scope')).toBe('notes:read notes:write');

    // The path-less URL, and no scopes at all.
    await login!.close();
    fixture.unauthenticated = 200;
    fixture.documents['/.well-known/oauth-protected-resource'] = { resource: fixture.origin, authorization_servers: [fixture.origin] };
    fixture.documents['/.well-known/oauth-protected-resource/mcp'] = undefined;
    await start();
    expect(new URL(opened[1]!).searchParams.has('scope')).toBe(false);
    expect(new URL(opened[1]!).searchParams.get('resource')).toBe(fixture.origin);
  });

  it('finds an issuer with a path, through OpenID discovery', async () => {
    const issuer = `${fixture.origin}/tenant`;
    meta('/.well-known/oauth-protected-resource/mcp').authorization_servers = [issuer];
    fixture.documents['/tenant/.well-known/openid-configuration'] = meta('/.well-known/oauth-authorization-server');
    await start();
    expect(requests('/.well-known/oauth-authorization-server/tenant')).toHaveLength(1);
    expect(requests('/.well-known/openid-configuration/tenant')).toHaveLength(1);
    expect(login!.header()).toBe('Bearer token-1');

    // Path-less issuers fall back to OpenID too.
    await login!.close();
    meta('/.well-known/oauth-protected-resource/mcp').authorization_servers = [fixture.origin];
    fixture.documents['/.well-known/openid-configuration'] = fixture.documents['/.well-known/oauth-authorization-server'];
    fixture.documents['/.well-known/oauth-authorization-server'] = 'not json';
    await start();
    expect(login!.header()).toBe('Bearer token-2');
  });

  it('sends a client secret it was given', async () => {
    fixture.registration.body = { client_id: 'mcpspy-client', client_secret: 's3cret' };
    await start();
    expect(new URLSearchParams(requests('/token')[0]!.body).get('client_secret')).toBe('s3cret');
  });

  it.each([
    ['an unreachable server', (f: OAuthFixture) => void (f.url = 'http://127.0.0.1:1/mcp'), /^couldn't reach http:\/\/127\.0\.0\.1:1: /],
    ['no metadata', (f: OAuthFixture) => (f.challenge = null, f.documents['/.well-known/oauth-protected-resource/mcp'] = undefined), /doesn't say where to log in/],
    ['metadata for another server', (f: OAuthFixture) => (meta('/.well-known/oauth-protected-resource/mcp').resource = 'http://elsewhere.example/mcp'), /describes http:\/\/elsewhere\.example\/mcp, not/],
    ['metadata for a sibling path', (f: OAuthFixture) => (meta('/.well-known/oauth-protected-resource/mcp').resource = `${f.origin}/mc`), /describes .*\/mc, not/],
    ['a resource that is not a URL', () => (meta('/.well-known/oauth-protected-resource/mcp').resource = 'nope'), /describes nope, not/],
    ['no login service', () => (meta('/.well-known/oauth-protected-resource/mcp').authorization_servers = []), /names no login service/],
    ['a login service over plain http', () => (meta('/.well-known/oauth-protected-resource/mcp').authorization_servers = ['http://login.example']), /won't log in over http:\/\/login\.example\/: it isn't https/],
    ['an unreachable login service', () => (meta('/.well-known/oauth-protected-resource/mcp').authorization_servers = ['http://127.0.0.1:1']), /couldn't find http:\/\/127\.0\.0\.1:1\/'s login metadata/],
    ['no login metadata', (f: OAuthFixture) => (f.documents['/.well-known/oauth-authorization-server'] = undefined), /couldn't find .*'s login metadata/],
    ['no endpoints', (f: OAuthFixture) => (f.documents['/.well-known/oauth-authorization-server'] = {}), /gives no login endpoints/],
    ['no PKCE', () => delete meta('/.well-known/oauth-authorization-server').code_challenge_methods_supported, /doesn't support PKCE/],
    ['only plain PKCE', () => (meta('/.well-known/oauth-authorization-server').code_challenge_methods_supported = ['plain']), /doesn't support PKCE/],
    ['no registration', () => delete meta('/.well-known/oauth-authorization-server').registration_endpoint, /doesn't let mcpspy register itself; pass a token with -H instead/],
    ['a refused registration', (f: OAuthFixture) => (f.registration = { status: 400, body: { error_description: 'redirect not allowed' } }), /refused to register mcpspy: redirect not allowed/],
    ['a broken registration', (f: OAuthFixture) => (f.registration = { status: 500, body: 'oops' }), /refused to register mcpspy: 500 Internal Server Error/],
    ['a denied login', (f: OAuthFixture) => (f.deny = 'access_denied'), /the login service said: access_denied/],
    ['a refused code', (f: OAuthFixture) => (f.tokenReply = { status: 400, body: '{"error":"invalid_grant","error_description":"expired"}' }), /refused mcpspy's token request: expired/],
    ['a token reply without a token', (f: OAuthFixture) => (f.tokenReply = { status: 200, body: '{}' }), /refused mcpspy's token request: 200 OK/],
    ['a token reply that is not JSON', (f: OAuthFixture) => (f.tokenReply = { status: 502, body: 'bad gateway' }), /refused mcpspy's token request: 502 Bad Gateway/],
  ])('fails with %s', async (_what, breakIt, message) => {
    breakIt(fixture);
    await expect(start()).rejects.toThrow(message);
  });

  it('gives up when nobody logs in in time, or the login comes back without a code', async () => {
    await expect(start({ open: () => {}, timeoutMs: 50 })).rejects.toThrow('nobody logged in in time');
    const noCode = (url: string) => {
      const query = new URL(url).searchParams;
      void fetch(`${query.get('redirect_uri')}?state=${query.get('state')}`).then((response) => response.text());
    };
    await expect(start({ open: noCode })).rejects.toThrow('the login service said: no code');
    const described = (url: string) => {
      const query = new URL(url).searchParams;
      void fetch(`${query.get('redirect_uri')}?state=${query.get('state')}&error=x&error_description=went%20wrong`).then((response) => response.text());
    };
    await expect(start({ open: described })).rejects.toThrow('the login service said: went wrong');
  });

  it('allows loopback login services by name', async () => {
    const local = (input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace('//localhost:', '//127.0.0.1:'), init);
    for (const path of ['/.well-known/oauth-protected-resource/mcp']) meta(path).authorization_servers = [fixture.origin.replace('127.0.0.1', 'localhost')];
    await start({ fetch: local as typeof fetch, open: (url) => browser(url.replace('//localhost:', '//127.0.0.1:')) });
    expect(login!.header()).toBe('Bearer token-1');
  });
});

describe('mcpspy proxy with a login', () => {
  let fixture: OAuthFixture;
  let store: Store;
  beforeEach(async () => {
    fixture = await startOAuthFixture();
    store = new Store(':memory:');
  });
  afterEach(async () => {
    store.close();
    await fixture.close();
  });

  it('sends the token upstream in place of the agent’s, and renews it when the server refuses it', async () => {
    const login = await logIn(fixture.url, { open: (url) => void fetch(url).then((r) => r.text()), warn: () => {} });
    const proxy = await startHttpProxy({ upstream: fixture.url, store, port: 0, login, headers: { 'X-Team': 'a' } });
    try {
      const call = () =>
        fetch(proxy.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer agent' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
      expect(await (await call()).json()).toEqual({ jsonrpc: '2.0', id: 1, result: { token: 'token-1' } });
      expect(fixture.log.at(-1)!.headers['x-team']).toBe('a');

      fixture.revoke();
      expect((await call()).status).toBe(401);
      await expect.poll(() => login.header()).toBe('Bearer token-2');
      expect(await (await call()).json()).toEqual({ jsonrpc: '2.0', id: 1, result: { token: 'token-2' } });
    } finally {
      await proxy.close();
      await login.close();
    }
  });
});
