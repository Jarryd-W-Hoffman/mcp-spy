import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An MCP server behind an OAuth login, with its own login service on the same
 * origin. Its metadata and behaviour are plain fields, so each test can break
 * the part it's about. Every request is kept in `log`.
 */
export async function startOAuthFixture() {
  const log: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const codes = new Map<string, { challenge: string; redirect: string; resource: string; client: string }>();
  const valid = new Set<string>();
  let issued = 0;
  let origin = '';

  const fixture = {
    url: '',
    origin: '',
    log,
    /** What the MCP endpoint's 401 says, or null for no WWW-Authenticate. */
    challenge: null as string | null,
    /** The status the MCP endpoint gives an unauthenticated request. */
    unauthenticated: 401,
    /** Documents served by path; set one to undefined to remove it. */
    documents: {} as Record<string, unknown>,
    registration: { status: 201, body: { client_id: 'mcpspy-client' } as unknown },
    /** What /authorize does: redirect with a code, or with this error. */
    deny: null as string | null,
    /** Tokens' lifetime in seconds, if any. */
    expiresIn: undefined as number | undefined,
    refreshTokens: true,
    /** Refreshes fail with this status. */
    refreshFails: null as number | null,
    /** The token endpoint answers with this instead. */
    tokenReply: null as { status: number; body: string } | null,
    /** Revokes every token issued so far. */
    revoke: () => valid.clear(),
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  const tokens = () => {
    const access = `token-${++issued}`;
    valid.add(access);
    return { access_token: access, token_type: 'Bearer', ...(fixture.expiresIn !== undefined ? { expires_in: fixture.expiresIn } : {}), ...(fixture.refreshTokens ? { refresh_token: `refresh-${issued}` } : {}) };
  };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url!, origin);
      log.push({ method: req.method!, path: url.pathname + url.search, headers: req.headers, body });

      if (url.pathname === '/mcp') {
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        if (token === undefined || !valid.has(token)) {
          return send(res, fixture.unauthenticated, { error: 'unauthorized' }, fixture.challenge !== null ? { 'www-authenticate': fixture.challenge } : {});
        }
        const message = JSON.parse(body) as { id?: unknown };
        if (message.id === undefined) return void res.writeHead(202).end();
        return send(res, 200, { jsonrpc: '2.0', id: message.id, result: { token } });
      }
      if (url.pathname in fixture.documents) {
        const document = fixture.documents[url.pathname];
        if (document === undefined) return send(res, 404, {});
        return typeof document === 'string' ? res.writeHead(200).end(document) : send(res, 200, document);
      }
      if (url.pathname === '/register') {
        const { status, body: reply } = fixture.registration;
        return typeof reply === 'string' ? void res.writeHead(status).end(reply) : send(res, status, reply);
      }
      if (url.pathname === '/authorize') {
        const query = url.searchParams;
        const redirect = new URL(query.get('redirect_uri')!);
        redirect.searchParams.set('state', query.get('state')!);
        if (fixture.deny !== null) {
          redirect.searchParams.set('error', fixture.deny);
        } else {
          const code = `code-${codes.size + 1}`;
          codes.set(code, { challenge: query.get('code_challenge')!, redirect: query.get('redirect_uri')!, resource: query.get('resource')!, client: query.get('client_id')! });
          redirect.searchParams.set('code', code);
        }
        return void res.writeHead(302, { location: redirect.href }).end();
      }
      if (url.pathname === '/token') {
        if (fixture.tokenReply !== null) return void res.writeHead(fixture.tokenReply.status).end(fixture.tokenReply.body);
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'refresh_token') {
          if (fixture.refreshFails !== null) return send(res, fixture.refreshFails, { error: 'invalid_grant' });
          // Refreshes keep the refresh token, so the reply has none.
          const { refresh_token: _kept, ...rest } = tokens();
          return send(res, 200, rest);
        }
        const grant = codes.get(form.get('code')!);
        codes.delete(form.get('code')!);
        const verified = createHash('sha256').update(form.get('code_verifier')!).digest('base64url') === grant?.challenge;
        if (!grant || !verified || grant.redirect !== form.get('redirect_uri') || grant.resource !== form.get('resource') || grant.client !== form.get('client_id')) {
          return send(res, 400, { error: 'invalid_grant', error_description: 'the code does not match' });
        }
        return send(res, 200, tokens());
      }
      send(res, 404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.origin = origin;
  fixture.url = `${origin}/mcp`;
  fixture.challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="notes:read"`;
  fixture.documents = {
    '/.well-known/oauth-protected-resource/mcp': { resource: fixture.url, authorization_servers: [origin], scopes_supported: ['notes:read', 'notes:write'] },
    '/.well-known/oauth-authorization-server': {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      code_challenge_methods_supported: ['S256'],
    },
  };
  return fixture;
}

export type OAuthFixture = Awaited<ReturnType<typeof startOAuthFixture>>;
