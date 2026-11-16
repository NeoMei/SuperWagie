import express from 'express';
import { PlatformAccountError } from './runtime.js';
import { sessionCookieNameForRequest } from '../ui-auth/session-cookie.js';

/** start/callback use one-time capabilities and an HttpOnly browser transaction cookie. */
export const registerPlatformAccountRoutes = (app, { runtime, resolveIdentity, onSessionRead, isRequestOriginAllowed = () => false }) => {
  const cookieName = (req) => sessionCookieNameForRequest(req, 'oc_platform_login');
  // Consumer restoration repairs per-process in-memory state after a restart.
  // It is not part of answering a verified account read, so it runs in the
  // background and concurrent reads for one login share a single restoration.
  const restorations = new Map();
  const route = (handler) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!['GET', 'HEAD'].includes(req.method) && !await isRequestOriginAllowed(req)) throw new PlatformAccountError('platform_origin_forbidden', 403);
      await handler(req, res);
    }
    catch (error) {
      const known = error instanceof PlatformAccountError;
      const retryAfter = known && error.code === 'rate_limited' ? error.retryAfter : undefined;
      if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
      const body = { error: known ? error.code : 'platform_unavailable' };
      if (known && error.interaction) body.interaction = error.interaction;
      if (known && error.code === 'invalid_password' && error.passwordIssues?.length) body.password_issues = error.passwordIssues;
      if (retryAfter !== undefined) body.retry_after = retryAfter;
      res.status(known ? error.status : 502).json(body);
    }
  };
  const jsonBody = express.json({ limit: '8kb' });
  const bodyRoute = (handler) => route(async (req, res) => {
    await new Promise((resolve, reject) => jsonBody(req, res, (error) => error ? reject(new PlatformAccountError('invalid_request', 400)) : resolve()));
    return handler(req, res);
  });
  const identity = (req, res) => resolveIdentity(req, res, { allowUrlToken: false });
  const sessionRoute = (read) => route(async (req, res) => {
    const who = await identity(req, res);
    const result = await read(who);
    if (result.status === 'signed-in') {
      // Daily history is collected during normal use, independently of the chart.
      void Promise.resolve().then(() => runtime.startUsageActivity?.(who)).catch(() => {});
    }
    if (result.status === 'signed-in' && onSessionRead) {
      // Key on the runtime identity, which is stable across the account reads
      // the user center issues together; a login/account change still produces
      // a new restoration through the next call.
      const scope = JSON.stringify(who);
      let restore = restorations.get(scope);
      if (!restore) {
        restore = Promise.resolve().then(() => onSessionRead(who)).catch(() => { /* Consumer recovery is best effort and never denies identity. */ });
        restorations.set(scope, restore);
        void restore.then(() => { if (restorations.get(scope) === restore) restorations.delete(scope); });
      }
    }
    res.json(result);
  });
  app.get('/api/platform-account', sessionRoute(runtime.publicSession));
  app.get('/api/platform-account/session', sessionRoute(runtime.identitySession));
  app.get('/api/platform-account/api-keys', route(async (req, res) => res.json(await runtime.readApiKeys(await identity(req, res), req.query.accountId))));
  app.get('/api/platform-account/auth-methods', route(async (req, res) => res.json(runtime.authMethods(await identity(req, res)))));
  app.post('/api/platform-account/register', bodyRoute(async (req, res) => {
    const result = await runtime.register(await identity(req, res), req.body);
    res.status(result.status === 'UNKNOWN' ? 202 : 200).json(result);
  }));
  app.post('/api/platform-account/password-login', bodyRoute(async (req, res) => res.json(await runtime.passwordLogin(await identity(req, res), req.body))));
  app.post('/api/platform-account/login', route(async (req, res) => res.json(await runtime.begin(await identity(req, res)))));
  app.get('/api/platform-account/start', route(async (req, res) => {
    const result = await runtime.start(typeof req.query.ticket === 'string' ? req.query.ticket : '');
    res.cookie(cookieName(req), result.browser, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 300_000, path: '/api/platform-account/callback' });
    res.redirect(303, result.url);
  }));
  app.get('/api/platform-account/callback', route(async (req, res) => {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=')));
    const get = (name) => typeof req.query[name] === 'string' ? req.query[name] : '';
    const browser = cookies[cookieName(req)] || '';
    res.clearCookie(cookieName(req), { path: '/api/platform-account/callback' });
    await runtime.callback({ state: get('state'), code: get('code'), browser });
    res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>SuperWagie</title><p>登录完成，请返回 SuperWagie。 / Signed in. Return to SuperWagie.</p></html>');
  }));
  app.put('/api/platform-account/account', express.json({ limit: '4kb' }), route(async (req, res) => {
    const who = await identity(req, res);
    const result = await runtime.selectAccount(who, req.body?.accountId);
    void Promise.resolve().then(() => runtime.startUsageActivity?.(who)).catch(() => {});
    res.json(result);
  }));
  for (const [product, prefix] of [['superwagie', ''], ['llmrouter', '/llmrouter']]) {
    for (const kind of product === 'superwagie' ? ['summary', 'calls', 'activity'] : ['summary', 'calls']) {
      app.get(`/api/platform-account/usage/:accountId${prefix}/${kind}`, route(async (req, res) => {
        res.json(await runtime.readUsage(await identity(req, res), req.params.accountId, kind, product));
      }));
    }
  }
  app.post('/api/platform-account/logout', route(async (req, res) => res.json(runtime.logout(await identity(req, res)))));
};
