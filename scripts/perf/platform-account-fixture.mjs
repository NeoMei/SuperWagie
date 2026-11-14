import { createHash, generateKeyPair, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { z } from 'zod';

const createKeys = promisify(generateKeyPair);
const opaque = () => randomBytes(32).toString('base64url');
const clientId = 'superwagie-local-acceptance';
const subject = 'local-acceptance-subject';
const user = { id: 'local-acceptance-user', name: 'Local acceptance', email: '' };
const account = { id: 'local-acceptance-account', kind: 'personal', name: 'Local acceptance', role: 'owner' };
const alternateAccount = { id: 'local-acceptance-team', kind: 'team', name: 'Local alternate account', role: 'owner' };
const otherUser = { id: 'local-acceptance-outsider', name: 'Other local actor', email: '' };
const otherAccount = { id: 'local-acceptance-outsider-account', kind: 'personal', name: 'Other local actor', role: 'owner' };
const pkce = (value) => createHash('sha256').update(value).digest('base64url');
const equal = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const reply = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const readJson = async (req) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) throw new Error('fixture_request_invalid');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

/** Synthetic account authority for local acceptance. It owns no product data or model route. */
export async function startPlatformAccountFixture() {
  const { privateKey, publicKey } = await createKeys('rsa', { modulusLength: 2048 });
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: opaque(), alg: 'RS256', use: 'sig' };
  const username = 'local-acceptance';
  const password = `A9!${randomBytes(24).toString('base64url')}`;
  const otherUsername = 'local-outsider';
  const otherPassword = `A9!${randomBytes(24).toString('base64url')}`;
  const grants = new Map();
  const accessTokens = new Map();
  const counters = { authorizations: 0, tokens: 0, authenticatedReads: 0, rejected: 0 };
  let origin;
  let redirectUri;
  let stopped = false;
  const authorizationSchema = z.object({
    client_id: z.literal(clientId), redirect_uri: z.string(), scope: z.literal('openid profile email'),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal('S256'), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    username: z.string().max(64), password: z.string().max(128),
  }).strict();
  const tokenSchema = z.object({
    grant_type: z.literal('authorization_code'), authorization_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    client_id: z.literal(clientId), redirect_uri: z.string(), code: z.string().regex(/^[0-9a-f]{64}$/),
    code_verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  }).strict();
  const jwt = (payload, actorSubject) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(JSON.stringify({ ...payload, iss: origin, sub: actorSubject, aud: clientId, iat: now, exp: now + 7200, jti: opaque() })).toString('base64url');
    const input = `${header}.${claims}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  };
  const reject = (res, status, error) => {
    counters.rejected += 1;
    reply(res, status, { error });
  };
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) return reject(res, 400, 'fixture_host_invalid');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') return reply(res, 200, {
        issuer: origin, authorization_endpoint: `${origin}/v1/identity/authorize/password`,
        token_endpoint: `${origin}/v1/identity/token`, jwks_uri: `${origin}/keys`,
      });
      if (req.method === 'GET' && url.pathname === '/keys') return reply(res, 200, { keys: [publicJwk] });
      if (req.method === 'POST' && url.pathname === '/v1/identity/authorize/password') {
        const parsed = authorizationSchema.safeParse(await readJson(req));
        if (!parsed.success || parsed.data.redirect_uri !== redirectUri) return reject(res, 400, 'invalid_request');
        const input = parsed.data;
        const owner = equal(input.username, username) && equal(input.password, password);
        const other = equal(input.username, otherUsername) && equal(input.password, otherPassword);
        if (!owner && !other) return reject(res, 401, 'invalid_credentials');
        for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(id);
        if (grants.size >= 32) return reject(res, 429, 'fixture_capacity');
        const authorizationId = opaque();
        const code = randomBytes(32).toString('hex');
        grants.set(authorizationId, {
          code, nonce: input.nonce, challenge: input.code_challenge, expiresAt: Date.now() + 300_000,
          user: owner ? user : otherUser, accounts: owner ? [account, alternateAccount] : [otherAccount],
          subject: owner ? subject : `${subject}-other`,
        });
        counters.authorizations += 1;
        return reply(res, 200, { authorization_id: authorizationId, code, state: input.state });
      }
      if (req.method === 'POST' && url.pathname === '/v1/identity/token') {
        const parsed = tokenSchema.safeParse(await readJson(req));
        if (!parsed.success || parsed.data.redirect_uri !== redirectUri) return reject(res, 400, 'invalid_grant');
        const input = parsed.data;
        const grant = grants.get(input.authorization_id);
        grants.delete(input.authorization_id);
        if (!grant || grant.expiresAt <= Date.now() || !equal(input.code, grant.code) || !equal(pkce(input.code_verifier), grant.challenge)) return reject(res, 400, 'invalid_grant');
        if (accessTokens.size >= 32) return reject(res, 429, 'fixture_capacity');
        const accessToken = jwt({ tokenType: 'access-token', scope: 'openid profile email' }, grant.subject);
        accessTokens.set(`Bearer ${accessToken}`, { user: grant.user, accounts: grant.accounts });
        counters.tokens += 1;
        return reply(res, 200, {
          access_token: accessToken, id_token: jwt({ tokenType: 'id-token', nonce: grant.nonce }, grant.subject),
          token_type: 'Bearer', scope: 'openid profile email', expires_in: 7200,
        });
      }
      const principal = accessTokens.get(req.headers.authorization);
      if (!principal) return reject(res, 401, 'unauthenticated');
      if (req.method === 'GET' && url.pathname === '/v1/me') { counters.authenticatedReads += 1; return reply(res, 200, principal.user); }
      if (req.method === 'GET' && url.pathname === '/v1/accounts') { counters.authenticatedReads += 1; return reply(res, 200, principal.accounts); }
      if (req.method === 'GET' && principal.accounts.some(item => [`/v1/accounts/${item.id}/subscriptions`, `/v1/accounts/${item.id}/credits`].includes(url.pathname))) { counters.authenticatedReads += 1; return reply(res, 200, []); }
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') { counters.authenticatedReads += 1; return reply(res, 200, { sandbox: true }); }
      return reject(res, 404, 'fixture_route_unavailable');
    } catch {
      if (!res.headersSent) reject(res, 400, 'fixture_request_invalid');
      else res.destroy();
    }
  });
  await new Promise((resolve, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  redirectUri = `${origin}/api/platform-account/callback`;
  return {
    origin, username, password, accountId: account.id, alternateAccountId: alternateAccount.id,
    otherUsername, otherPassword, otherAccountId: otherAccount.id,
    env: {
      OPENCHAMBER_UNIHUB_ISSUER: origin, OPENCHAMBER_UNIHUB_API_URL: origin,
      OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID: clientId, OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI: redirectUri,
      OPENCHAMBER_UNIHUB_CONSOLE_URL: `${origin}/console`, OPENCHAMBER_UNIHUB_GATEWAY_URL: `${origin}/platform/v1`,
    },
    counts: () => ({ ...counters }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      grants.clear(); accessTokens.clear();
      server.closeAllConnections();
      await new Promise((resolve, rejectStop) => server.close(error => error ? rejectStop(error) : resolve()));
    },
  };
}
