import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Logging in to an MCP server with OAuth, as the MCP authorization spec
 * describes, so `mcpspy proxy --login` can add the token itself: the agent
 * can't log in through the proxy, since a token is issued for one URL.
 *
 * Protected resource metadata (RFC 9728) names the login service; its
 * metadata (RFC 8414, or OpenID discovery) gives the endpoints. mcpspy
 * registers itself (RFC 7591), sends the user's browser to log in with PKCE,
 * and takes the code on a loopback callback. Every request names the server
 * as the token's `resource` (RFC 8707). Tokens are kept in memory only.
 */

export interface LoginOptions {
  /** Opens the login page in the user's browser. */
  open: (url: string) => void;
  warn: (message: string) => void;
  /** How long to wait for the user to log in. Five minutes by default. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface Login {
  /** The Authorization header to send upstream. */
  header(): string;
  /** The server refused the token: refresh it, or log in again. */
  expired(): void;
  close(): Promise<void>;
}

interface Tokens {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

interface Endpoints {
  authorization: URL;
  token: URL;
  registration?: URL;
}

/** Refresh this long before the token runs out. */
const EARLY_MS = 60_000;

export async function logIn(upstream: string, options: LoginOptions): Promise<Login> {
  const http = options.fetch ?? fetch;
  const server = new URL(upstream);
  const { resource, scope, issuer } = await protectedResource(server, http);
  const endpoints = await authorizationServer(issuer, http);
  const callback = await callbackServer();
  const fail = async (error: unknown): Promise<never> => {
    await callback.close();
    throw error;
  };
  const client = await register(endpoints, callback.url, http).catch(fail);

  let tokens: Tokens = await authorize().catch(fail);
  let timer: NodeJS.Timeout | undefined;
  let renewing: Promise<void> | null = null;
  let closed = false;
  schedule();

  /** Sends the user to log in and trades the code they come back with for tokens. */
  async function authorize(): Promise<Tokens> {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const url = new URL(endpoints.authorization);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.id,
      redirect_uri: callback.url,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      resource,
      ...(scope !== undefined ? { scope } : {}),
    }).toString();
    const code = callback.next(state, options.timeoutMs ?? 300_000);
    options.warn(`log in to ${server.origin} in your browser; if it didn't open, visit ${url.href}`);
    options.open(url.href);
    return token({ grant_type: 'authorization_code', code: await code, redirect_uri: callback.url, code_verifier: verifier });
  }

  async function token(grant: Record<string, string>): Promise<Tokens> {
    const body = new URLSearchParams({ ...grant, client_id: client.id, resource });
    if (client.secret !== undefined) body.set('client_secret', client.secret);
    const response = await http(endpoints.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
    const reply = (await response.json().catch(() => ({}))) as Partial<Tokens> & { error?: string; error_description?: string };
    if (!response.ok || typeof reply.access_token !== 'string') {
      throw new Error(`the login service refused mcpspy's token request: ${reply.error_description ?? reply.error ?? `${response.status} ${response.statusText}`}`);
    }
    return reply as Tokens;
  }

  /** Refreshes the token shortly before it runs out. */
  function schedule(): void {
    clearTimeout(timer);
    if (tokens.expires_in === undefined) return;
    timer = setTimeout(() => void renew(), Math.max(tokens.expires_in * 1000 - EARLY_MS, 1000)).unref();
  }

  /** A new token, by refreshing if possible and logging in again if not. One renewal at a time. */
  function renew(): Promise<void> {
    renewing ??= (async () => {
      try {
        if (tokens.refresh_token !== undefined) {
          try {
            const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
            tokens = { refresh_token: tokens.refresh_token, ...refreshed };
            return;
          } catch (error) {
            options.warn(`couldn't refresh the login (${(error as Error).message}); log in again`);
          }
        }
        if (!closed) tokens = await authorize();
      } catch (error) {
        options.warn(`login failed: ${(error as Error).message}`);
      } finally {
        renewing = null;
        schedule();
      }
    })();
    return renewing;
  }

  return {
    header: () => `Bearer ${tokens.access_token}`,
    expired: () => void renew(),
    close: async () => {
      closed = true;
      clearTimeout(timer);
      await callback.close();
    },
  };
}

/** Where to log in for a server, from its protected resource metadata. */
async function protectedResource(server: URL, http: typeof fetch): Promise<{ resource: string; scope?: string; issuer: URL }> {
  // An unauthenticated request may say where the metadata is, and which scope to ask for.
  const probe = await http(server, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'mcpspy-login', method: 'ping' }),
  }).catch((error: Error) => {
    throw new Error(`couldn't reach ${server.origin}: ${error.message}`);
  });
  await probe.arrayBuffer();
  const challenge = probe.status === 401 ? (probe.headers.get('www-authenticate') ?? '') : '';
  const param = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1];
  const named = param('resource_metadata');
  const path = server.pathname.replace(/\/$/, '');
  const candidates = named !== undefined ? [new URL(named, server)] : [new URL(`/.well-known/oauth-protected-resource${path}`, server), new URL('/.well-known/oauth-protected-resource', server)];

  for (const url of candidates) {
    const metadata = await json(http, url);
    if (metadata === null) continue;
    const { resource, authorization_servers: servers, scopes_supported: scopes } = metadata as { resource?: unknown; authorization_servers?: unknown; scopes_supported?: unknown };
    // The metadata must be for this server, or a token for it could be sent here.
    if (typeof resource !== 'string' || !covers(resource, server)) throw new Error(`${url.href} describes ${String(resource)}, not ${server.href}`);
    if (!Array.isArray(servers) || typeof servers[0] !== 'string') throw new Error(`${url.href} names no login service`);
    const scope = param('scope') ?? (Array.isArray(scopes) && scopes.length > 0 ? scopes.join(' ') : undefined);
    return { resource, scope, issuer: secure(new URL(servers[0])) };
  }
  throw new Error(`${server.origin} doesn't say where to log in (no OAuth protected resource metadata)`);
}

/** A login service's endpoints, from its metadata. */
async function authorizationServer(issuer: URL, http: typeof fetch): Promise<Endpoints> {
  const path = issuer.pathname.replace(/\/$/, '');
  const candidates =
    path === ''
      ? ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']
      : [`/.well-known/oauth-authorization-server${path}`, `/.well-known/openid-configuration${path}`, `${path}/.well-known/openid-configuration`];
  for (const candidate of candidates) {
    const metadata = (await json(http, new URL(candidate, issuer))) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      code_challenge_methods_supported?: unknown;
    } | null;
    if (metadata === null) continue;
    if (typeof metadata.authorization_endpoint !== 'string' || typeof metadata.token_endpoint !== 'string') throw new Error(`${issuer.href} gives no login endpoints`);
    if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) {
      throw new Error(`${issuer.href} doesn't support PKCE, which mcpspy requires`);
    }
    return {
      authorization: secure(new URL(metadata.authorization_endpoint)),
      token: secure(new URL(metadata.token_endpoint)),
      registration: metadata.registration_endpoint !== undefined ? secure(new URL(metadata.registration_endpoint)) : undefined,
    };
  }
  throw new Error(`couldn't find ${issuer.href}'s login metadata`);
}

/** Registers mcpspy with the login service, for this run's callback URL. */
async function register(endpoints: Endpoints, redirect: string, http: typeof fetch): Promise<{ id: string; secret?: string }> {
  if (endpoints.registration === undefined) throw new Error("the login service doesn't let mcpspy register itself; pass a token with -H instead");
  const response = await http(endpoints.registration, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'mcpspy',
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const reply = (await response.json().catch(() => ({}))) as { client_id?: unknown; client_secret?: unknown; error_description?: string };
  if (!response.ok || typeof reply.client_id !== 'string') {
    throw new Error(`the login service refused to register mcpspy: ${reply.error_description ?? `${response.status} ${response.statusText}`}`);
  }
  return { id: reply.client_id, secret: typeof reply.client_secret === 'string' ? reply.client_secret : undefined };
}

/** The loopback page the login service sends the browser back to, with a code. */
async function callbackServer(): Promise<{ url: string; next(state: string, timeoutMs: number): Promise<string>; close(): Promise<void> }> {
  let waiting: { state: string; resolve(code: string): void; reject(error: Error): void } | null = null;
  const server: Server = createServer((req, res) => {
    const query = new URL(req.url!, 'http://127.0.0.1').searchParams;
    const page = (status: number, text: string) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
    if (waiting === null || query.get('state') !== waiting.state) return page(400, 'mcpspy is not expecting this login.');
    const { resolve, reject } = waiting;
    waiting = null;
    const code = query.get('code');
    if (code === null) {
      page(400, 'The login failed. You can close this tab.');
      return reject(new Error(`the login service said: ${query.get('error_description') ?? query.get('error') ?? 'no code'}`));
    }
    page(200, 'mcpspy is logged in. You can close this tab.');
    resolve(code);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/callback`,
    next: (state, timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null;
          reject(new Error('nobody logged in in time'));
        }, timeoutMs);
        waiting = {
          state,
          resolve: (code) => (clearTimeout(timer), resolve(code)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        };
      }),
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/** A JSON document, or null if there isn't one at the URL. */
async function json(http: typeof fetch, url: URL): Promise<unknown> {
  const response = await http(url, { headers: { accept: 'application/json' } }).catch(() => null);
  if (response === null) return null;
  if (!response.ok) {
    await response.arrayBuffer();
    return null;
  }
  return response.json().catch(() => null);
}

/** Whether a protected resource identifier covers the server's URL: same origin, and a path prefix. */
function covers(resource: string, server: URL): boolean {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  const prefix = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url.origin === server.origin && (server.pathname === url.pathname || server.pathname.startsWith(prefix));
}

/** Login traffic carries secrets, so it must be encrypted, unless it stays on this machine. */
function secure(url: URL): URL {
  if (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) return url;
  throw new Error(`mcpspy won't log in over ${url.href}: it isn't https`);
}
