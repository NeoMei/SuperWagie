import express from 'express';
import { z } from 'zod';
import { PlatformAccountError } from './runtime.js';
import { sessionCookieNameForRequest } from '../ui-auth/session-cookie.js';
const bridgeQuerySchema = z.string();
const queryValue = (value) => {
  const parsed = bridgeQuerySchema.safeParse(value);
  return parsed.success ? parsed.data : '';
};

/** start/callback use one-time capabilities and an HttpOnly browser transaction cookie. */
export const registerPlatformAccountRoutes = (app, { runtime, resolveIdentity, isRequestOriginAllowed = () => false }) => {
  const cookieName = (req) => sessionCookieNameForRequest(req, 'oc_platform_login');
  const route = (handler) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!['GET', 'HEAD'].includes(req.method) && !await isRequestOriginAllowed(req)) throw new PlatformAccountError('platform_origin_forbidden', 403);
      await handler(req, res);
    }
    catch (error) {
      const known = error instanceof PlatformAccountError;
      const payload = { error: known ? error.code : 'platform_unavailable' };
      if (known && error.interaction) payload.interaction = error.interaction;
      res.status(known ? error.status : 502).json(payload);
    }
  };
  const jsonBody = express.json({ limit: '8kb' });
  const bodyRoute = (handler) => route(async (req, res) => {
    await new Promise((resolve, reject) => jsonBody(req, res, (error) => error ? reject(new PlatformAccountError('invalid_request', 400)) : resolve()));
    return handler(req, res);
  });
  const identity = (req, res) => resolveIdentity(req, res, { allowUrlToken: false });
  app.get('/api/platform-account', route(async (req, res) => res.json(await runtime.publicSession(await identity(req, res)))));
  app.get('/api/platform-account/session', route(async (req, res) => res.json(await runtime.identitySession(await identity(req, res)))));
  app.get('/api/platform-account/auth-methods', route(async (req, res) => res.json(runtime.authMethods(await identity(req, res)))));
  app.post('/api/platform-account/register', bodyRoute(async (req, res) => {
    const result = await runtime.register(await identity(req, res), req.body);
    res.status(result.status === 'UNKNOWN' ? 202 : 200).json(result);
  }));
  app.post('/api/platform-account/password-login', bodyRoute(async (req, res) => res.json(await runtime.passwordLogin(await identity(req, res), req.body))));
  app.post('/api/platform-account/login', route(async (req, res) => res.json(await runtime.begin(await identity(req, res)))));
  app.get('/api/platform-account/start', route(async (req, res) => {
    const result = await runtime.start(queryValue(req.query.ticket));
    res.cookie(cookieName(req), result.browser, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 300_000, path: '/api/platform-account/callback' });
    res.redirect(303, result.url);
  }));
  app.get('/api/platform-account/callback', route(async (req, res) => {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=')));
    const browser = cookies[cookieName(req)] || '';
    res.clearCookie(cookieName(req), { path: '/api/platform-account/callback' });
    await runtime.callback({ state: queryValue(req.query.state), code: queryValue(req.query.code), browser });
    res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>UniHub</title><p>登录完成，请返回 SuperWagie。 / Signed in. Return to SuperWagie.</p></html>');
  }));
  app.put('/api/platform-account/account', express.json({ limit: '4kb' }), route(async (req, res) => res.json(await runtime.selectAccount(await identity(req, res), req.body?.accountId))));
  app.post('/api/platform-account/logout', route(async (req, res) => res.json(runtime.logout(await identity(req, res)))));
};
