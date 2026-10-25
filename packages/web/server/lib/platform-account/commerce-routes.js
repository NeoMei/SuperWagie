import express from 'express';
import { PlatformAccountError } from './runtime.js';

/** Explicit runtime-authenticated routes; no browser-supplied upstream URLs or tokens. */
export const registerPlatformCommerceRoutes = (app, { runtime, resolveIdentity, isRequestOriginAllowed }) => {
  const identity = (req, res) => resolveIdentity(req, res, { allowUrlToken: false });
  const parseJson = express.json({ limit: '4kb', inflate: false });
  const route = (handler, mutation = false) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const who = await identity(req, res);
      if (mutation) {
        if (!await isRequestOriginAllowed(req)) throw new PlatformAccountError('platform_origin_forbidden', 403);
        if (!req.is('application/json')) throw new PlatformAccountError('platform_request_invalid', 400);
        await new Promise((resolve, reject) => parseJson(req, res, (error) => error ? reject(new PlatformAccountError('platform_request_invalid', error.status === 413 ? 413 : 400)) : resolve()));
      }
      res.json(await handler(who, req));
    } catch (error) {
      const known = error instanceof PlatformAccountError;
      res.status(known ? error.status : 503).json({ error: known ? error.code : 'platform_commerce_unavailable' });
    }
  };
  app.get('/api/platform-account/commerce', route((who) => runtime.overview(who)));
  app.post('/api/platform-account/commerce/recharges', route((who, req) => runtime.createRecharge(who, req.body), true));
  app.post('/api/platform-account/commerce/purchases', route((who, req) => runtime.purchase(who, req.body), true));
  app.post('/api/platform-account/commerce/intents/:key/reconcile', route((who, req) => runtime.reconcile(who, req.params.key, req.body), true));
  app.post('/api/platform-account/commerce/intents/:key/sandbox-settle', route((who, req) => runtime.sandboxSettle(who, req.params.key, req.body), true));
};
