import { z } from 'zod';

const API_PREFIX = '/api';
const requestPathSchema = z.string();
const platformErrorSchema = z.object({ code: z.string().startsWith('platform_') });
const actorSchema = z.object({ actingUserId: z.string().min(1), expiresAt: z.number().finite() });

const pathOf = (req) => {
  const raw = req?.originalUrl || req?.url || '';
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    const fallback = requestPathSchema.safeParse(req?.path);
    return fallback.success ? fallback.data : '';
  }
};

const methodOf = (req) => String(req?.method || 'GET').toUpperCase();

// Sandboxed documents carry only their path grant, and OAuth providers carry
// only the pending state. Each owning route validates that capability. Grant
// creation and every other guest/filesystem request still require an actor.
export const isCapabilityReadRequest = (req) => {
  if (methodOf(req) !== 'GET') return false;
  const path = req.path ?? pathOf(req);
  return /^\/api\/fs\/preview\/[^/]+\/.+$/.test(path)
    || /^\/api\/guest-files\/[^/]+\/.+$/.test(path)
    || /^\/api\/guests\/[a-z][a-z0-9-]*\/oauth\/callback$/.test(path);
};

// These routes establish the two identities that can later reach the API:
// OpenChamber runtime auth and the UniHub platform session. They carry no model,
// filesystem, project or conversation data.
const isBootstrapRequest = (req) => {
  const method = methodOf(req);
  const path = pathOf(req);
  if (method === 'OPTIONS') return true;
  if (method === 'GET' && ['/api/platform-account', '/api/platform-account/session', '/api/platform-account/auth-methods', '/api/platform-account/start', '/api/platform-account/callback'].includes(path)) return true;
  if (method === 'POST' && ['/api/platform-account/register', '/api/platform-account/password-login', '/api/platform-account/login', '/api/platform-account/logout'].includes(path)) return true;
  if (method === 'PUT' && path === '/api/platform-account/account') return true;

  // Runtime pairing/client-token flows must remain reachable before the UniHub
  // user session exists. Their own handlers still enforce pairing credentials.
  if (method === 'POST' && ['/api/client-auth/clients', '/api/client-auth/pairing/redeem'].includes(path)) return true;
  if (method === 'GET' && ['/api/client-auth/connection/candidates', '/api/client-auth/pairing/transports'].includes(path)) return true;

  // Discovery and the public shell need to learn the endpoint before login.
  if (method === 'GET' && (path === '/api/version' || path === '/api/system/info')) return true;
  return false;
};

const statusFor = (error) => {
  if (error?.code === 'platform_runtime_auth_required' || error?.code === 'platform_session_expired') return 401;
  if (error?.code === 'platform_runtime_unsupported') return 409;
  if (error?.code === 'platform_unconfigured' || error?.code === 'platform_configuration_invalid') return 503;
  return 503;
};

const codeFor = (error) => {
  const parsed = platformErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data.code;
  return 'platform_access_unavailable';
};

/**
 * Enforces the UniHub user boundary after transport authentication and before
 * every API route. The identity resolver is deliberately injected so this
 * module never owns cookies, bearer tokens or account-session storage.
 */
export const createPlatformAccessGate = ({ resolveIdentity, getAccountRuntime, authorizeServiceRequest = () => false }) => {
  const authorize = async (req, res, { allowUrlToken = false } = {}) => {
    const identity = await resolveIdentity(req, res, { allowUrlToken });
    const runtime = getAccountRuntime();
    if (!runtime) {
      const error = new Error('platform account runtime unavailable');
      error.code = 'platform_unconfigured';
      throw error;
    }
    const parsedActor = actorSchema.safeParse(runtime.actor(identity));
    if (!parsedActor.success || parsedActor.data.expiresAt <= Date.now()) {
      const error = new Error('platform account session required');
      error.code = 'platform_session_expired';
      throw error;
    }
    const actor = parsedActor.data;
    return { identity, actor };
  };

  // Existing streams must stop after logout, expiry or configuration removal.
  // A single process timer checks only live connections; no UniHub network IO.
  const live = new Set();
  let timer = null;
  const validateLive = () => {
    for (const entry of live) {
      try {
        const actor = getAccountRuntime()?.actor(entry.identity);
        if (!actor || actor.actingUserId !== entry.actor.actingUserId || actor.expiresAt !== entry.actor.expiresAt || !Number.isFinite(actor.expiresAt) || actor.expiresAt <= Date.now()) throw new Error('platform session changed');
      } catch {
        entry.close();
        live.delete(entry);
      }
    }
    if (live.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
  const track = (authorization, connection) => {
    const entry = { ...authorization, close: () => connection.destroy() };
    live.add(entry);
    const untrack = () => {
      live.delete(entry);
      if (live.size === 0 && timer) { clearInterval(timer); timer = null; }
    };
    connection.once('close', untrack);
    connection.once('finish', untrack);
    if (!timer) { timer = setInterval(validateLive, 1000); timer.unref?.(); }
    return untrack;
  };

  const middleware = async (req, res, next) => {
    const path = pathOf(req);
    // Express routes are case insensitive by default. Match the entire API
    // namespace under the same rule so /API cannot skip the user boundary.
    const apiPath = path.toLowerCase();
    if ((apiPath !== API_PREFIX && !apiPath.startsWith(`${API_PREFIX}/`)) || isBootstrapRequest(req) || isCapabilityReadRequest(req)) return next();
    try {
      if (methodOf(req) === 'POST' && ['/api/openchamber/agent-tool', '/api/openchamber/limit-failover', '/api/openchamber/limit-failover/settle', '/api/notifications/emit', '/api/git/repository-credential'].includes(path) && await authorizeServiceRequest(req)) return next();
      const authorization = await authorize(req, res, { allowUrlToken: true });
      // Readable media and EventSource requests use the existing scoped URL
      // tokens. The injected resolver checks their original path/method scope.
      track(authorization, res);
      return next();
    } catch (error) {
      return res.status(statusFor(error)).json({ error: codeFor(error), code: codeFor(error) });
    }
  };

  const authorizeUpgrade = async (req, { allowUrlToken = true } = {}) => {
    try {
      await authorize(req, null, { allowUrlToken });
      return null;
    } catch (error) {
      return { status: statusFor(error), code: codeFor(error), message: 'UniHub account login required' };
    }
  };

  const guardUpgrade = async (req, socket, reject) => {
    try {
      const authorization = await authorize(req, null, { allowUrlToken: true });
      track(authorization, socket);
      return true;
    } catch (error) {
      reject(socket, statusFor(error), 'UniHub account login required');
      return false;
    }
  };
  const dispose = () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const entry of live) entry.close();
    live.clear();
  };

  return { middleware, authorize, authorizeUpgrade, guardUpgrade, validateLive, dispose, isBootstrapRequest };
};

export { isBootstrapRequest };
