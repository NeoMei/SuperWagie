import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { writeFileAtomic } from '../opencode/atomic-write.js';
import { isEnterpriseMode } from '../enterprise-mode.js';

const userSchema = z.object({ id: z.string().min(1), name: z.string(), email: z.string() });
const runtimeIdentitySchema = z.object({ type: z.enum(['session', 'client']), token: z.string().min(1) });
const accessScopeSchema = z.string().refine((value) => value.split(/\s+/).includes('openid'));
const accountSchema = z.object({ id: z.string().min(1), kind: z.enum(['personal', 'team']), name: z.string(), role: z.string() });
const subscriptionsSchema = z.array(z.object({ id: z.string(), product_id: z.string(), status: z.string(), paid_through: z.string(), offer: z.object({ name: z.string() }) }));
const creditsSchema = z.array(z.object({ id: z.string(), available: z.string().regex(/^\d+$/), reserved: z.string().regex(/^\d+$/), expires_at: z.string(), starts_at: z.string(), frozen: z.boolean() }));
const registrationSchema = z.object({ username: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/), password: z.string().max(512).optional(), email: z.string().max(254).optional(), displayName: z.string().max(160).refine((value) => [...value].length <= 80).optional(), idempotencyKey: z.string().min(1).max(128).refine((value) => value.trim() === value) }).strict();
const passwordLoginSchema = z.object({ username: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/), password: z.string().min(1).max(512) }).strict();
const registrationResultSchema = z.object({ registration_id: z.string().min(1), status: z.enum(['CREATED', 'UNKNOWN']), retry_after: z.number().int().nonnegative().optional() });
const tokenSchema = z.object({ access_token: z.string().min(1), id_token: z.string().min(1), token_type: z.string(), expires_in: z.number().int().positive() });
const upstreamErrorSchema = z.object({ error: z.enum(['invalid_request', 'invalid_password', 'invalid_credentials', 'invalid_client', 'invalid_grant', 'client_not_enabled', 'origin_not_allowed', 'authorization_conflict', 'idempotency_conflict', 'registration_conflict', 'interaction_required', 'rate_limited', 'invalid_identity_response', 'authorization_result_unknown', 'identity_policy_unavailable', 'identity_unavailable', 'registration_policy_unavailable', 'service_unavailable', 'forbidden', 'unauthenticated', 'not_found', 'conflict', 'operation_pending', 'insufficient_credits', 'insufficient_funds', 'unsupported_plan_change', 'refund_requires_review', 'payment_not_configured']), interaction: z.object({ kind: z.enum(['mfa', 'mfa_enrollment', 'password_change', 'consent', 'captcha', 'email_verification', 'provider_policy', 'registration_policy']) }).optional() });
const allowedApiPaths = new Map([
  ['GET', [/^\/v1\/me$/, /^\/v1\/me\/profile$/, /^\/v1\/me\/avatar$/, /^\/v1\/(?:accounts|capabilities|catalog|products)$/, /^\/v1\/accounts\/[A-Za-z0-9_-]+\/(?:subscriptions|credits|resources|wallets|orders|operations)$/, /^\/v1\/accounts\/[A-Za-z0-9_-]+\/(?:recharges|operations)\/[A-Za-z0-9_-]+$/]],
  ['POST', [/^\/v1\/me\/password$/, /^\/v1\/accounts\/[A-Za-z0-9_-]+\/(?:model-credentials|recharges|orders)$/, /^\/v1\/accounts\/[A-Za-z0-9_-]+\/recharges\/[A-Za-z0-9_-]+\/sandbox-settle$/]],
  ['PATCH', [/^\/v1\/me\/profile$/]],
  ['PUT', [/^\/v1\/me\/avatar$/]],
]);
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = (value) => crypto.createHash('sha256').update(value).digest('base64url');
export const PUBLIC_UNIHUB_DEFAULTS = Object.freeze({
  issuer: 'https://unihub.quukk.com',
  apiUrl: 'https://unihub.quukk.com',
  consoleUrl: 'https://unihub.quukk.com',
  headlessClientId: 'superwagie-headless',
  headlessRedirectUri: 'http://127.0.0.1:57991/api/platform-account/callback',
});
const platformSessionStoreVersion = 1;
const platformSessionStoreFile = 'platform-account-sessions.json';
const maxPlatformSessionStoreBytes = 1_048_576;
const persistedSessionSchema = z.object({
  expiresAt: z.number().finite(),
  ownerKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sealed: z.object({ iv: z.string().min(1), tag: z.string().min(1), data: z.string().min(1) }).strict(),
}).strict();
const persistedSessionStoreSchema = z.object({
  version: z.literal(platformSessionStoreVersion),
  sessions: z.record(z.string(), persistedSessionSchema),
}).strict();
const persistedSessionPayloadSchema = z.object({
  accessToken: z.string().min(1),
  api: z.string().min(1),
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  generation: z.string().min(1).optional(),
  expiresAt: z.number().finite(),
  accountId: z.string().nullable(),
  accountVersion: z.number().int().nonnegative(),
  selectedOnce: z.boolean().optional(),
  user: userSchema,
}).strict();
export class PlatformAccountError extends Error {
  constructor(code, status = 400, interaction) { super(code); this.code = code; this.status = status; this.interaction = interaction; }
}
const reject = (code, status) => { throw new PlatformAccountError(code, status); };
const parseInput = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) reject('invalid_request', 400);
  return result.data;
};
const serviceUrl = (value) => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) reject('platform_configuration_invalid', 503);
  return url;
};

/** Identity is a validated runtime auth context. Session credentials stay encrypted in the managed data directory. */
export const createPlatformAccountRuntime = ({ env = process.env, fetchImpl = fetch, now = Date.now, isManaged = () => true, isModelAvailable = () => false, isModelHistoryAvailable = () => false, dataDir = null, usePublicDefaults = env === process.env, enterprise = isEnterpriseMode } = {}) => {
  const salt = random();
  const sessions = new Map();
  const sessionPersistenceKeys = new Map();
  const accountMutationVersions = new Map();
  const pendingAccountSelections = new Map();
  const publicSessionReads = new Map();
  const sessionStorePath = typeof dataDir === 'string' && dataDir.trim() ? path.join(dataDir, platformSessionStoreFile) : null;
  const persistedSessions = new Map();
  const invalidatedSessionKeys = new Set();
  const invalidatedPersistedKeys = new Set();
  const transactions = new Map();
  const starts = new Map();
  const activeLogins = new Map();
  if (sessionStorePath) {
    try {
      if (fs.statSync(sessionStorePath).size > maxPlatformSessionStoreBytes) throw new Error('session store too large');
      const parsed = persistedSessionStoreSchema.parse(JSON.parse(fs.readFileSync(sessionStorePath, 'utf8')));
      for (const [key, entry] of Object.entries(parsed.sessions)) if (entry.expiresAt > now()) persistedSessions.set(key, entry);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[platform-account] Ignoring unreadable session store');
    }
  }
  const config = () => {
    const disabled = env.OPENCHAMBER_UNIHUB_DISABLED === '1' || env.OPENCHAMBER_UNIHUB_MODE === 'off';
    if (disabled) return null;
    const issuerValue = env.OPENCHAMBER_UNIHUB_ISSUER || (usePublicDefaults ? PUBLIC_UNIHUB_DEFAULTS.issuer : '');
    const apiValue = env.OPENCHAMBER_UNIHUB_API_URL || (usePublicDefaults ? PUBLIC_UNIHUB_DEFAULTS.apiUrl : '');
    const headlessClientId = env.OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID || (usePublicDefaults ? PUBLIC_UNIHUB_DEFAULTS.headlessClientId : '');
    const headlessRedirectUri = env.OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI || (usePublicDefaults ? PUBLIC_UNIHUB_DEFAULTS.headlessRedirectUri : env.OPENCHAMBER_UNIHUB_REDIRECT_URI);
    if (!issuerValue || !apiValue) return null;
    const issuer = serviceUrl(issuerValue).toString().replace(/\/$/, '');
    const client = (clientId, redirectUri, browserCallback) => {
      if (!clientId || !redirectUri) return null;
      const redirect = serviceUrl(redirectUri);
      if (browserCallback && redirect.pathname !== '/api/platform-account/callback') reject('platform_configuration_invalid', 503);
      return { clientId, redirect: redirect.toString() };
    };
    const browser = client(env.OPENCHAMBER_UNIHUB_CLIENT_ID, env.OPENCHAMBER_UNIHUB_REDIRECT_URI, true);
    const headless = client(headlessClientId, headlessRedirectUri, false);
    if (!browser && !headless) return null;
    const consoleValue = env.OPENCHAMBER_UNIHUB_CONSOLE_URL || (usePublicDefaults ? PUBLIC_UNIHUB_DEFAULTS.consoleUrl : '');
    return { issuer, browser, headless, api: serviceUrl(apiValue), console: consoleValue ? serviceUrl(consoleValue) : null };
  };
  const namespace = (identity) => {
    const parsed = runtimeIdentitySchema.safeParse(identity);
    if (!parsed.success) reject('platform_runtime_auth_required', 401);
    return crypto.createHmac('sha256', salt).update(`${parsed.data.type}:${parsed.data.token}`).digest('hex');
  };
  const persistenceKey = (identity) => digest(`openchamber-platform-session-v1:${identity.type}:${identity.token}`);
  const ownerKey = (session) => digest(`openchamber-platform-owner-v1:${session.issuer}:${session.user.id}`);
  const beginAccountMutation = (key) => {
    const version = (accountMutationVersions.get(key) ?? 0) + 1;
    accountMutationVersions.set(key, version);
    return version;
  };
  const assertAccountMutation = (key, version) => {
    if ((accountMutationVersions.get(key) ?? 0) !== version) reject('platform_session_changed', 409);
  };
  const sealSession = (identity, session) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(`openchamber-platform-session-key-v1:${identity.type}:${identity.token}`).digest(), iv);
    const payload = {
      accessToken: session.accessToken,
      api: session.api,
      issuer: session.issuer,
      clientId: session.clientId,
      expiresAt: session.expiresAt,
      accountId: session.accountId,
      accountVersion: session.accountVersion,
      user: session.user,
    };
    if (session.generation !== undefined) payload.generation = session.generation;
    if (session.selectedOnce !== undefined) payload.selectedOnce = session.selectedOnce;
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
  };
  const unsealSession = (identity, sealed) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(`openchamber-platform-session-key-v1:${identity.type}:${identity.token}`).digest(), Buffer.from(sealed.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
    const raw = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64url')), decipher.final()]).toString('utf8');
    return persistedSessionPayloadSchema.parse(JSON.parse(raw));
  };
  const persistStore = () => {
    if (!sessionStorePath) return true;
    try {
      fs.mkdirSync(path.dirname(sessionStorePath), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(sessionStorePath, 'a', 0o600);
      fs.closeSync(descriptor);
      if (process.platform !== 'win32') fs.chmodSync(sessionStorePath, 0o600);
      const writableSessions = Object.fromEntries([...persistedSessions].filter(([key]) => !invalidatedPersistedKeys.has(key)));
      writeFileAtomic(sessionStorePath, `${JSON.stringify({ version: platformSessionStoreVersion, sessions: writableSessions }, null, 2)}\n`);
      return true;
    } catch {
      console.warn('[platform-account] Unable to persist session state');
      return false;
    }
  };
  const failPersistence = () => reject('platform_session_persistence_failed', 503);
  const removePersisted = (persistedKey, strict = false) => {
    const previous = persistedSessions.get(persistedKey);
    if (!previous) return true;
    invalidatedPersistedKeys.add(persistedKey);
    persistedSessions.delete(persistedKey);
    if (persistStore()) return true;
    persistedSessions.set(persistedKey, previous);
    if (strict) failPersistence();
    return false;
  };
  const removeSessionByKey = (key) => {
    const persistedKey = sessionPersistenceKeys.get(key);
    invalidatedSessionKeys.add(key);
    if (persistedKey) invalidatedPersistedKeys.add(persistedKey);
    try {
      if (persistedKey) removePersisted(persistedKey, true);
    } catch (error) {
      sessions.delete(key);
      sessionPersistenceKeys.delete(key);
      throw error;
    }
    sessions.delete(key);
    sessionPersistenceKeys.delete(key);
    accountMutationVersions.delete(key);
    pendingAccountSelections.delete(key);
  };
  const removeSession = (identity) => {
    const key = namespace(identity);
    const persistedKey = persistenceKey(identity);
    let persistenceError = null;
    try {
      removePersisted(persistedKey, true);
    } catch (error) {
      persistenceError = error;
    }
    sessions.delete(key);
    sessionPersistenceKeys.delete(key);
    invalidatedSessionKeys.add(key);
    invalidatedPersistedKeys.add(persistedKey);
    accountMutationVersions.delete(key);
    if (persistenceError) throw persistenceError;
  };
  const persistSession = (identity, session) => {
    const key = namespace(identity);
    const persistedKey = persistenceKey(identity);
    const previousSession = sessions.get(key);
    const previousPersistenceKey = sessionPersistenceKeys.get(key);
    const previousPersisted = persistedSessions.get(persistedKey);
    const wasInvalidated = invalidatedPersistedKeys.has(persistedKey);
    invalidatedPersistedKeys.delete(persistedKey);
    sessions.set(key, session);
    sessionPersistenceKeys.set(key, persistedKey);
    if (sessionStorePath) {
      persistedSessions.set(persistedKey, { expiresAt: session.expiresAt, ownerKey: ownerKey(session), sealed: sealSession(identity, session) });
      if (!persistStore()) {
        if (previousPersisted) persistedSessions.set(persistedKey, previousPersisted);
        else persistedSessions.delete(persistedKey);
        if (wasInvalidated) invalidatedPersistedKeys.add(persistedKey);
        if (previousSession) sessions.set(key, previousSession);
        else sessions.delete(key);
        if (previousPersistenceKey) sessionPersistenceKeys.set(key, previousPersistenceKey);
        else sessionPersistenceKeys.delete(key);
        failPersistence();
      }
    }
    invalidatedSessionKeys.delete(key);
    invalidatedPersistedKeys.delete(persistedKey);
  };
  const restoreSession = (identity) => {
    const key = namespace(identity);
    const inMemory = sessions.get(key);
    if (inMemory) return inMemory;
    const persistedKey = persistenceKey(identity);
    if (invalidatedSessionKeys.has(key) || invalidatedPersistedKeys.has(persistedKey)) return null;
    const stored = persistedSessions.get(persistedKey);
    if (!stored) return null;
    if (stored.expiresAt <= now()) {
      removePersisted(persistedKey);
      return null;
    }
    try {
    const session = unsealSession(identity, stored.sealed);
      if (session.expiresAt <= now()) throw new Error('expired');
      sessions.set(key, session);
      sessionPersistenceKeys.set(key, persistedKey);
      return session;
    } catch {
      removePersisted(persistedKey);
      return null;
    }
  };
  const supported = () => { if (!isManaged()) reject('platform_runtime_unsupported', 409); };
  const readJson = async (url, init, uncertainCode) => {
    let response;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { reject(uncertainCode || 'platform_unavailable', 502); }
    if (response.status === 204) return null;
    let body;
    try { body = await response.json(); }
    catch { reject(response.status === 401 ? 'platform_session_expired' : uncertainCode || (response.ok ? 'platform_response_invalid' : 'platform_unavailable'), response.status === 401 ? 401 : 502); }
    if (!response.ok) {
      const error = upstreamErrorSchema.safeParse(body);
      if (error.success) throw new PlatformAccountError(error.data.error === 'unauthenticated' ? 'platform_session_expired' : error.data.error, response.status, error.data.error === 'interaction_required' ? error.data.interaction : undefined);
      reject(response.status === 401 ? 'platform_session_expired' : uncertainCode || 'platform_unavailable', response.status === 401 ? 401 : 502);
    }
    return body;
  };
  const sessionMatchesConfig = (session, c) => session.api === c.api.toString() && session.issuer === c.issuer && [c.browser?.clientId, c.headless?.clientId].includes(session.clientId);
  const getSession = (identity) => {
    supported();
    const c = config();
    if (!c) reject('platform_unconfigured', 503);
    const key = namespace(identity);
    const session = restoreSession(identity);
    if (!session || session.expiresAt <= now()) { removeSessionByKey(key); reject('platform_session_expired', 401); }
    if (!sessionMatchesConfig(session, c)) {
      removeSessionByKey(key); reject('platform_session_changed', 409);
    }
    return session;
  };
  const apiRequest = async (session, path, init = {}) => {
    const c = config();
    if (!c || !allowedApiPaths.get(init.method || 'GET')?.some((pattern) => pattern.test(path))) reject('platform_request_forbidden', 403);
    if (session.api !== c.api.toString() || session.issuer !== c.issuer || ![c.browser?.clientId, c.headless?.clientId].includes(session.clientId)) reject('platform_session_changed', 409);
    return readJson(new URL(path, c.api), { ...init, headers: { ...init.headers, Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' } });
  };
  const apiBinaryRequest = async (session, path) => {
    const c = config();
    if (!c || !allowedApiPaths.get('GET')?.some((pattern) => pattern.test(path))) reject('platform_request_forbidden', 403);
    if (session.api !== c.api.toString() || session.issuer !== c.issuer || ![c.browser?.clientId, c.headless?.clientId].includes(session.clientId)) reject('platform_session_changed', 409);
    let response;
    try { response = await fetchImpl(new URL(path, c.api), { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'image/png,image/jpeg' } }); }
    catch { reject('platform_unavailable', 502); }
    if (!response.ok) reject(response.status === 401 ? 'platform_session_expired' : 'platform_unavailable', response.status === 401 ? 401 : 502);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? '';
    if (!['image/png', 'image/jpeg'].includes(contentType)) { await response.body?.cancel(); reject('platform_response_invalid', 502); }
    const reader = response.body?.getReader();
    if (!reader) reject('platform_response_invalid', 502);
    let size = 0; const chunks = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 524288) { await reader.cancel(); reject('platform_response_invalid', 502); }
        chunks.push(result.value);
      }
    } catch (error) { if (error instanceof PlatformAccountError) throw error; reject('platform_unavailable', 502); }
    return { contentType, bytes: Buffer.concat(chunks) };
  };
  const revokeSessionOnAuthFailure = async (key, session, operation) => {
    try { return await operation(); }
    catch (error) {
      // A late response from an older session must never revoke a newer login
      // that reused the same runtime identity namespace.
      if (error instanceof PlatformAccountError && (error.status === 401 || error.code === 'platform_session_expired' || error.code === 'platform_session_changed') && sameLoginSession(sessions.get(key), session)) removeSessionByKey(key);
      throw error;
    }
  };
  const sessionRequest = (key, session, path, init) => revokeSessionOnAuthFailure(key, session, () => apiRequest(session, path, init));
  const sessionBinaryRequest = (key, session, path) => revokeSessionOnAuthFailure(key, session, () => apiBinaryRequest(session, path));
  const sameLoginSession = (current, session) => Boolean(current
    && current.accessToken === session.accessToken
    && current.generation === session.generation
    && current.expiresAt === session.expiresAt
    && current.issuer === session.issuer
    && current.clientId === session.clientId
    && current.user.id === session.user.id);
  const assertCurrentIdentity = (key, session) => {
    const current = sessions.get(key);
    if (!sameLoginSession(current, session) || session.expiresAt <= now()) reject('platform_session_changed', 409);
    return current;
  };
  const assertCurrentSession = (key, session, accountVersion) => {
    const current = assertCurrentIdentity(key, session);
    if (current.accountVersion !== accountVersion || current.accountId !== session.accountId) reject('platform_session_changed', 409);
    return current;
  };
  const accountProjection = async (key, session, c, accounts, accountId) => {
    const account = accounts.find((item) => item.id === accountId);
    let membership = [];
    let available = '0';
    let reserved = '0';
    if (account) {
      const [subscriptions, credits] = await Promise.all([
        sessionRequest(key, session, `/v1/accounts/${encodeURIComponent(account.id)}/subscriptions`),
        sessionRequest(key, session, `/v1/accounts/${encodeURIComponent(account.id)}/credits`),
      ]);
      membership = subscriptionsSchema.parse(subscriptions).filter((item) => item.product_id === 'superwagie');
      for (const batch of creditsSchema.parse(credits)) {
        if (!batch.frozen && Date.parse(batch.starts_at) <= now() && Date.parse(batch.expires_at) > now()) available = String(BigInt(available) + BigInt(batch.available));
        reserved = String(BigInt(reserved) + BigInt(batch.reserved));
      }
    }
    const consoleUrl = c.console ? new URL(c.console) : null;
    if (account) consoleUrl?.searchParams.set('account', account.id);
    consoleUrl?.searchParams.set('product', 'superwagie');
    return { status: 'signed-in', user: session.user, accounts, accountId, expiresAt: new Date(session.expiresAt).toISOString(), membership, credits: { available, reserved }, consoleUrl: consoleUrl?.toString() ?? null, modelService: isModelAvailable() ? 'available' : 'unavailable', modelRecoveryAvailable: isModelHistoryAvailable() };
  };
  const readPublicSession = async (identity) => {
    const c = config();
    if (!isManaged()) return { status: 'unsupported' };
    if (!c) return { status: 'unconfigured' };
    const key = namespace(identity);
    const session = restoreSession(identity);
    if (!session) return { status: 'signed-out' };
    if (session.expiresAt <= now()) { removeSessionByKey(key); return { status: 'expired' }; }
    if (!sessionMatchesConfig(session, c)) { removeSessionByKey(key); reject('platform_session_changed', 409); }
    const mutationVersion = accountMutationVersions.get(key) ?? 0;
    const accountVersion = session.accountVersion;
    const selectedAccountId = session.accountId;
    const accounts = z.array(accountSchema).parse(await sessionRequest(key, session, '/v1/accounts'));
    assertCurrentSession(key, session, accountVersion);
    const accountId = !session.selectedOnce ? accounts.find((account) => account.kind === 'personal')?.id ?? accounts[0]?.id ?? null
      : accounts.some((account) => account.id === selectedAccountId) ? selectedAccountId : null;
    const projection = await accountProjection(key, session, c, accounts, accountId);
    assertCurrentSession(key, session, accountVersion);
    assertAccountMutation(key, mutationVersion);
    if (!session.selectedOnce || session.accountId !== accountId) {
      if (pendingAccountSelections.has(key)) reject('platform_session_changed', 409);
      persistSession(identity, { ...assertCurrentSession(key, session, accountVersion), accountId, selectedOnce: true, accountVersion: accountVersion + 1 });
    }
    return { ...projection, user: assertCurrentIdentity(key, session).user };
  };
  const publicSession = (identity) => {
    if (!isManaged()) return Promise.resolve({ status: 'unsupported' });
    if (!config()) return Promise.resolve({ status: 'unconfigured' });
    const key = namespace(identity);
    const current = restoreSession(identity);
    const previous = publicSessionReads.get(key);
    const mutationVersion = accountMutationVersions.get(key) ?? 0;
    if (previous && sameLoginSession(current, previous.session) && current.accountVersion === previous.session.accountVersion && previous.mutationVersion === mutationVersion) return previous.promise;
    const entry = { session: current, mutationVersion, promise: readPublicSession(identity) };
    publicSessionReads.set(key, entry);
    void entry.promise.then(() => { if (publicSessionReads.get(key) === entry) publicSessionReads.delete(key); }, () => { if (publicSessionReads.get(key) === entry) publicSessionReads.delete(key); });
    return entry.promise;
  };
  const identitySession = async (identity) => {
    if (!isManaged()) return { status: 'unsupported' };
    const c = config();
    if (!c) return { status: 'unconfigured' };
    const key = namespace(identity);
    const session = restoreSession(identity);
    if (!session) return { status: 'signed-out' };
    if (session.expiresAt <= now()) { removeSessionByKey(key); return { status: 'expired' }; }
    getSession(identity);
    const user = userSchema.parse(await sessionRequest(key, session, '/v1/me'));
    const current = assertCurrentIdentity(key, session);
    if (user.id !== session.user.id) { if (sameLoginSession(sessions.get(key), session)) removeSessionByKey(key); reject('platform_session_changed', 409); }
    persistSession(identity, { ...current, user });
    return { status: 'signed-in', user, expiresAt: new Date(current.expiresAt).toISOString() };
  };
  const captureIdentitySession = (identity) => {
    const session = getSession(identity);
    const key = namespace(identity);
    return {
      userId: session.user.id,
      expiresAt: session.expiresAt,
      request: async (path, init) => {
        assertCurrentIdentity(key, session);
        const result = await sessionRequest(key, session, path, init);
        try {
          assertCurrentIdentity(key, session);
        } catch {
          reject('platform_session_changed_after_request', 409);
        }
        return result;
      },
      readAvatar: async () => {
        assertCurrentIdentity(key, session);
        const result = await sessionBinaryRequest(key, session, '/v1/me/avatar');
        assertCurrentIdentity(key, session);
        return result;
      },
      invalidate: () => {
        const persistedOwnerKey = ownerKey(session);
        const removedPersistedEntries = [];
        for (const [sessionKey, candidate] of sessions) if (candidate.user.id === session.user.id && candidate.issuer === session.issuer) {
          sessions.delete(sessionKey);
          sessionPersistenceKeys.delete(sessionKey);
          accountMutationVersions.delete(sessionKey);
          invalidatedSessionKeys.add(sessionKey);
        }
        for (const [persistedKey, candidate] of persistedSessions) if (candidate.ownerKey === persistedOwnerKey) {
          removedPersistedEntries.push([persistedKey, candidate]);
          persistedSessions.delete(persistedKey);
          invalidatedPersistedKeys.add(persistedKey);
        }
        if (removedPersistedEntries.length > 0 && !persistStore()) {
          for (const [persistedKey, candidate] of removedPersistedEntries) persistedSessions.set(persistedKey, candidate);
          failPersistence();
        }
      },
    };
  };
  const prepareLogin = (identity) => {
    const key = namespace(identity);
    activeLogins.delete(key);
    for (const [sessionKey, session] of sessions) if (session.expiresAt <= now()) removeSessionByKey(sessionKey);
    for (const [loginKey, login] of activeLogins) if (login.expiresAt <= now()) activeLogins.delete(loginKey);
    if (sessions.size >= 1000 && !sessions.has(key)) reject('platform_login_busy', 429);
    for (const [state, transaction] of transactions) if (transaction.expiresAt <= now() || transaction.key === key) transactions.delete(state);
    for (const [ticket, transaction] of starts) if (transaction.expiresAt <= now() || transaction.key === key) starts.delete(ticket);
    if (transactions.size >= 100 || starts.size >= 100 || activeLogins.size >= 100) reject('platform_login_busy', 429);
    return key;
  };
  const discovery = async (c) => {
    const value = z.object({ issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(), jwks_uri: z.string() }).parse(await readJson(`${c.issuer}/.well-known/openid-configuration`));
    if (value.issuer !== c.issuer) reject('platform_issuer_invalid', 400);
    for (const endpoint of [value.authorization_endpoint, value.token_endpoint, value.jwks_uri]) if (serviceUrl(endpoint).origin !== new URL(c.issuer).origin) reject('platform_issuer_invalid', 400);
    return value;
  };
  const begin = async (identity) => {
    supported();
    const c = config();
    if (!c?.browser) reject('platform_unconfigured', 503);
    const key = prepareLogin(identity);
    const ticket = random();
    const transaction = { key, identity, expiresAt: now() + 5 * 60_000, client: c.browser, config: c };
    starts.set(digest(ticket), transaction);
    activeLogins.set(key, transaction);
    const login = new URL('/api/platform-account/start', c.browser.redirect);
    login.searchParams.set('ticket', ticket);
    return { authorizationUrl: login.toString() };
  };
  const start = async (ticket) => {
    supported();
    const c = config();
    if (!c) reject('platform_unconfigured', 503);
    const transaction = starts.get(digest(ticket));
    starts.delete(digest(ticket));
    if (!transaction || transaction.expiresAt <= now()) reject('platform_login_expired', 400);
    const endpoints = await discovery(transaction.config);
    if (activeLogins.get(transaction.key) !== transaction || transaction.expiresAt <= now()) reject('platform_login_expired', 400);
    const state = random(); const nonce = random(); const verifier = random(); const browser = random();
    const pending = { ...transaction, nonce, verifier, browser: digest(browser), discovery: endpoints };
    transactions.set(state, pending);
    activeLogins.set(transaction.key, pending);
    const url = new URL(endpoints.authorization_endpoint);
    for (const [key, value] of Object.entries({ client_id: transaction.client.clientId, response_type: 'code', redirect_uri: transaction.client.redirect, scope: 'openid profile email', state, nonce, code_challenge: digest(verifier), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return { url: url.toString(), browser, state };
  };
  const completeLogin = async (transaction, token, strictAudience = false) => {
    const c = transaction.config;
    const { clientId } = transaction.client;
    if (token.token_type.toLowerCase() !== 'bearer') reject('platform_token_invalid', 400);
    let claims; let accessClaims;
    try {
      const keys = createRemoteJWKSet(new URL(transaction.discovery.jwks_uri));
      const options = { issuer: c.issuer, audience: clientId, algorithms: ['RS256', 'ES256'], clockTolerance: 30 };
      ({ payload: claims } = await jwtVerify(token.id_token, keys, options));
      ({ payload: accessClaims } = await jwtVerify(token.access_token, keys, options));
    }
    catch { reject('platform_token_invalid', 400); }
    if (claims.nonce !== transaction.nonce || !claims.sub || !claims.exp || (claims.azp && claims.azp !== clientId) || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId)) reject('platform_token_invalid', 400);
    if (accessClaims.sub !== claims.sub || !accessClaims.exp || accessClaims.tokenType !== 'access-token' || !accessScopeSchema.safeParse(accessClaims.scope).success) reject('platform_token_invalid', 400);
    if (Math.min(claims.exp, accessClaims.exp) * 1000 <= now()) reject('platform_token_invalid', 400);
    if (strictAudience) {
      const exactAudience = (audience) => audience === clientId || (Array.isArray(audience) && audience.length === 1 && audience[0] === clientId);
      if (!exactAudience(claims.aud) || !exactAudience(accessClaims.aud) || claims.tokenType !== 'id-token' || accessClaims.scope !== 'openid profile email' || (accessClaims.azp && accessClaims.azp !== clientId)) reject('platform_token_invalid', 400);
      if (claims.at_hash && claims.at_hash !== crypto.createHash('sha256').update(token.access_token).digest().subarray(0, 16).toString('base64url')) reject('platform_token_invalid', 400);
    }
    const session = { accessToken: token.access_token, api: c.api.toString(), issuer: c.issuer, clientId, generation: random(), expiresAt: Math.min(now() + 3_600_000, now() + token.expires_in * 1000, claims.exp * 1000, accessClaims.exp * 1000), accountId: null, accountVersion: 0 };
    session.user = userSchema.parse(await apiRequest(session, '/v1/me'));
    if (activeLogins.get(transaction.key) !== transaction || transaction.expiresAt <= now()) reject('platform_login_expired', 400);
    activeLogins.delete(transaction.key);
    persistSession(transaction.identity, session);
  };
  const callback = async ({ state, code, browser }) => {
    supported();
    const transaction = transactions.get(state);
    transactions.delete(state);
    if (!transaction || transaction.expiresAt <= now() || transaction.browser !== digest(browser) || activeLogins.get(transaction.key) !== transaction) reject('platform_login_expired', 400);
    const token = tokenSchema.parse(await readJson(transaction.discovery.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: transaction.client.clientId, redirect_uri: transaction.client.redirect, code, code_verifier: transaction.verifier }).toString() }, 'authorization_result_unknown'));
    await completeLogin(transaction, token);
  };
  const authMethods = (identity) => {
    namespace(identity);
    const c = isManaged() ? config() : null;
    return {
      passwordLogin: Boolean(c?.headless),
      registration: Boolean(c?.headless),
      browserLogin: Boolean(c?.browser),
      // Casdoor owns password recovery. Keep the link in the same configured
      // issuer so the UI never guesses an identity endpoint or stores a password.
      passwordRecoveryUrl: c ? new URL('/forget', c.issuer).toString() : null,
    };
  };
  const headlessConfig = (identity) => {
    supported(); namespace(identity);
    const c = config();
    if (!c?.headless) reject('platform_headless_unconfigured', 503);
    return c;
  };
  const register = async (identity, input) => {
    const c = headlessConfig(identity);
    const body = parseInput(registrationSchema, input);
    if (body.password !== undefined && ([...body.password].length < 12 || Buffer.byteLength(body.password, 'utf8') > 72)) reject('invalid_password', 400);
    let raw;
    try {
      raw = await readJson(new URL('/v1/identity/registrations', c.api), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': body.idempotencyKey }, body: JSON.stringify({ client_id: c.headless.clientId, username: body.username, password: body.password, email: body.email, display_name: body.displayName }) }, 'platform_registration_unknown');
    } catch (error) {
      // UniHub checks the original key before password policy. No row was
      // visible at that lookup; a concurrent original request may still win
      // the same key, so recovery must keep the key and metadata unchanged.
      if (body.password === undefined && error instanceof PlatformAccountError && error.status < 500 && error.code === 'invalid_password') reject('platform_registration_password_required', 400);
      // A failed persistence response can follow a committed identity insert.
      if (error instanceof PlatformAccountError && error.status >= 500 && error.code !== 'registration_policy_unavailable') reject('platform_registration_unknown', 502);
      throw error;
    }
    const result = registrationResultSchema.safeParse(raw);
    if (!result.success) reject('platform_registration_unknown', 502);
    const value = result.data;
    return { registrationId: value.registration_id, status: value.status, loginRequired: value.status === 'CREATED', ...(value.retry_after === undefined ? {} : { retryAfter: value.retry_after }) };
  };
  const passwordLogin = async (identity, input) => {
    const c = headlessConfig(identity);
    const body = parseInput(passwordLoginSchema, input);
    const key = prepareLogin(identity);
    const transaction = { key, identity, expiresAt: now() + 5 * 60_000, config: c, client: c.headless, nonce: random(), verifier: random() };
    activeLogins.set(key, transaction);
    try {
      transaction.discovery = await discovery(c);
      const checkActive = () => { if (activeLogins.get(key) !== transaction || transaction.expiresAt <= now()) reject('platform_login_expired', 400); };
      checkActive();
      const state = random();
      const raw = await readJson(new URL('/v1/identity/authorize/password', c.api), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: c.headless.clientId, redirect_uri: c.headless.redirect, scope: 'openid profile email', state, nonce: transaction.nonce, code_challenge_method: 'S256', code_challenge: digest(transaction.verifier), username: body.username, password: body.password }) });
      const authorization = z.object({ authorization_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().regex(/^[0-9a-f]{64}$/), state: z.literal(state) }).safeParse(raw);
      if (!authorization.success) reject('platform_authorization_invalid', 502);
      checkActive();
      const token = tokenSchema.extend({ token_type: z.literal('Bearer'), scope: z.literal('openid profile email') }).parse(await readJson(new URL('/v1/identity/token', c.api), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', authorization_id: authorization.data.authorization_id, client_id: c.headless.clientId, redirect_uri: c.headless.redirect, code: authorization.data.code, code_verifier: transaction.verifier }) }, 'authorization_result_unknown'));
      await completeLogin(transaction, token, true);
      return await identitySession(identity);
    } finally {
      if (activeLogins.get(key) === transaction) activeLogins.delete(key);
    }
  };
  const selectAccount = async (identity, accountId) => {
    const session = getSession(identity);
    const key = namespace(identity);
    const mutationVersion = beginAccountMutation(key);
    const selection = { mutationVersion };
    pendingAccountSelections.set(key, selection);
    const accountVersion = session.accountVersion;
    try {
      const accounts = z.array(accountSchema).parse(await sessionRequest(key, session, '/v1/accounts'));
      assertCurrentSession(key, session, accountVersion);
      if (!accounts.some((account) => account.id === accountId)) reject('platform_account_forbidden', 403);
      const projection = await accountProjection(key, session, config(), accounts, accountId);
      assertCurrentSession(key, session, accountVersion);
      assertAccountMutation(key, mutationVersion);
      const current = assertCurrentSession(key, session, accountVersion);
      persistSession(identity, { ...current, accountId, accountVersion: accountVersion + 1, selectedOnce: true });
      return { ...projection, user: current.user };
    } finally {
      if (pendingAccountSelections.get(key) === selection) pendingAccountSelections.delete(key);
    }
  };
  const captureCommerceSession = (identity) => {
    const session = getSession(identity);
    const key = namespace(identity);
    const accountId = session.accountId;
    const accountVersion = session.accountVersion;
    if (!accountId) reject('platform_account_required', 409);
    return { actingUserId: session.user.id, billingAccountId: accountId, serviceId: crypto.createHash('sha256').update(JSON.stringify([session.api, session.clientId])).digest('hex'), request: async (path, init) => {
      assertCurrentSession(key, session, accountVersion);
      const targetAccount = /^\/v1\/accounts\/([^/]+)\//.exec(path)?.[1];
      if (targetAccount && targetAccount !== encodeURIComponent(accountId)) reject('platform_account_forbidden', 403);
      const result = await sessionRequest(key, session, path, init);
      assertCurrentSession(key, session, accountVersion);
      return result;
    } };
  };
  // Keeps the user's access token inside this server. Gateway and call path
  // come from trusted runtime configuration and a previously admitted task.
  const readKnowledgeResult = async (identity, { taskId, callId, model }) => {
    const identifier = /^[A-Za-z0-9._:-]{1,200}$/;
    if (!identifier.test(taskId ?? '') || !identifier.test(callId ?? '') || !/^[A-Za-z0-9._:/-]{1,128}$/.test(model ?? '')) reject('platform_knowledge_result_invalid', 400);
    const gatewayValue = env.OPENCHAMBER_UNIHUB_GATEWAY_URL || (usePublicDefaults ? 'https://llmrouter.quukk.com/platform/v1' : '');
    let gateway;
    try { gateway = new URL(gatewayValue); } catch { reject('platform_knowledge_result_unavailable', 503); }
    if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname.replace(/\/$/, '') !== '/platform/v1' || (gateway.protocol !== 'https:' && !(gateway.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)))) reject('platform_knowledge_result_unavailable', 503);
    if (enterprise() && !['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)) reject('enterprise_mode', 403);
    const session = getSession(identity);
    const key = namespace(identity);
    const version = session.accountVersion;
    if (!session.accountId) reject('platform_account_required', 409);
    const raw = await sessionRequest(key, session, `/v1/accounts/${encodeURIComponent(session.accountId)}/model-credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_product_id: 'superwagie', models: [model], task_id: taskId }) });
    const schema = z.object({ token: z.string().min(1), actor_id: z.string(), account_id: z.string(), origin_product_id: z.literal('superwagie'), task_id: z.string(), models: z.array(z.string()), expires_at: z.string() });
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.actor_id !== session.user.id || parsed.data.account_id !== session.accountId || parsed.data.task_id !== taskId || !parsed.data.models.includes(model) || !(Date.parse(parsed.data.expires_at) > now())) reject('platform_knowledge_result_unavailable', 403);
    assertCurrentSession(key, session, version);
    let response;
    try {
      response = await fetchImpl(`${gateway.href.replace(/\/$/, '')}/knowledge/results/${encodeURIComponent(callId)}`, { method: 'POST', headers: { Authorization: `Bearer ${parsed.data.token}`, 'X-UniHub-Task-ID': taskId, 'X-UniHub-Actor-Authorization': `Bearer ${session.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { reject('platform_knowledge_result_unavailable', 503); }
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) { await response.body?.cancel(); reject('platform_knowledge_result_unavailable', 404); }
    const reader = response.body?.getReader();
    if (!reader) reject('platform_knowledge_result_unavailable', 503);
    const parts = []; let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 16 * 1024 * 1024) { await reader.cancel(); reject('platform_knowledge_result_unavailable', 503); }
        parts.push(result.value);
      }
    } catch (error) { if (error instanceof PlatformAccountError) throw error; reject('platform_knowledge_result_unavailable', 503); }
    assertCurrentSession(key, session, version);
    if ((env.OPENCHAMBER_UNIHUB_GATEWAY_URL || (usePublicDefaults ? 'https://llmrouter.quukk.com/platform/v1' : '')) !== gatewayValue) reject('platform_session_changed', 409);
    const bytes = Buffer.concat(parts);
    try { JSON.parse(bytes.toString('utf8')); } catch { reject('platform_knowledge_result_unavailable', 503); }
    return bytes;
  };
  // The caller has already persisted the immutable logical call. Every error
  // after this point is an unknown outcome and can only use result recovery.
  const dispatchKnowledge = async (identity, { taskId, callId, model, body }, operation) => {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId ?? '') || !/^wk_[a-f0-9]{60}$/.test(callId ?? '') || !/^[A-Za-z0-9._:/-]{1,128}$/.test(model ?? '') || !Buffer.isBuffer(body) || body.length < 1 || body.length > 2 * 1024 * 1024) reject('platform_knowledge_request_invalid', 400);
    const gatewayValue = env.OPENCHAMBER_UNIHUB_GATEWAY_URL || (usePublicDefaults ? 'https://llmrouter.quukk.com/platform/v1' : '');
    let gateway;
    try { gateway = new URL(gatewayValue); } catch { reject('platform_knowledge_request_unavailable', 503); }
    if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname.replace(/\/$/, '') !== '/platform/v1' || (gateway.protocol !== 'https:' && !(gateway.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)))) reject('platform_knowledge_request_unavailable', 503);
    if (enterprise() && !['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)) reject('enterprise_mode', 403);
    const session = getSession(identity);
    const key = namespace(identity); const version = session.accountVersion;
    if (!session.accountId) reject('platform_account_required', 409);
    const raw = await sessionRequest(key, session, `/v1/accounts/${encodeURIComponent(session.accountId)}/model-credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_product_id: 'superwagie', models: [model], task_id: taskId }) });
    const schema = z.object({ token: z.string().min(1), actor_id: z.string(), account_id: z.string(), origin_product_id: z.literal('superwagie'), task_id: z.string(), models: z.array(z.string()), expires_at: z.string() });
    const grant = schema.safeParse(raw);
    if (!grant.success || grant.data.actor_id !== session.user.id || grant.data.account_id !== session.accountId || grant.data.task_id !== taskId || !grant.data.models.includes(model) || !(Date.parse(grant.data.expires_at) > now())) reject('platform_knowledge_request_unavailable', 403);
    assertCurrentSession(key, session, version);
    if ((env.OPENCHAMBER_UNIHUB_GATEWAY_URL || (usePublicDefaults ? 'https://llmrouter.quukk.com/platform/v1' : '')) !== gatewayValue) reject('platform_session_changed', 409);
    let response;
    try {
      const url = operation === 'embedding' ? `${gateway.href.replace(/\/$/, '')}/embeddings` : new URL('/platform/api/v1/services/rerank/text-rerank/text-rerank', gateway.origin).href;
      response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${grant.data.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': callId, 'X-UniHub-Task-ID': taskId }, body, redirect: 'error', signal: AbortSignal.timeout(120_000) });
    } catch { reject('platform_knowledge_outcome_unknown', 503); }
    await response.body?.cancel();
    assertCurrentSession(key, session, version);
    if ((env.OPENCHAMBER_UNIHUB_GATEWAY_URL || (usePublicDefaults ? 'https://llmrouter.quukk.com/platform/v1' : '')) !== gatewayValue) reject('platform_session_changed', 409);
    if (!response.ok) reject('platform_knowledge_outcome_unknown', 503);
  };
  const dispatchKnowledgeEmbedding = (identity, request) => dispatchKnowledge(identity, request, 'embedding');
  const dispatchKnowledgeRerank = (identity, request) => dispatchKnowledge(identity, request, 'rerank');
  return { publicSession, identitySession, captureIdentitySession, begin, start, callback, selectAccount, authMethods, register, passwordLogin, captureCommerceSession, readKnowledgeResult, dispatchKnowledgeEmbedding, dispatchKnowledgeRerank,
    logout: (identity) => { const key = namespace(identity); activeLogins.delete(key); removeSession(identity); for (const [state, t] of transactions) if (t.key === key) transactions.delete(state); for (const [ticket, t] of starts) if (t.key === key) starts.delete(ticket); return { status: 'signed-out' }; },
    request: (identity, path, init) => { const key = namespace(identity); const session = getSession(identity); return sessionRequest(key, session, path, init); },
    instancePrincipal: (identity) => { const session = getSession(identity); return { issuer: session.issuer, userId: session.user.id }; },
    actor: (identity) => { const session = getSession(identity); const authSession = crypto.createHash('sha256').update(JSON.stringify([session.accessToken, session.generation ?? '', session.accountVersion])).digest('hex'); return { actingUserId: session.user.id, billingAccountId: session.accountId, expiresAt: session.expiresAt, authSession }; },
  };
};
