import express from 'express';
import { PlatformAccountError } from './runtime.js';

export const registerPlatformProfileRoutes = (app, { runtime, resolveIdentity, isRequestOriginAllowed = () => false }) => {
  const identity = (req, res) => resolveIdentity(req, res, { allowUrlToken: false });
  const route = (handler) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!await isRequestOriginAllowed(req)) throw new PlatformAccountError('platform_origin_forbidden', 403);
      await handler(req, res);
    } catch (error) {
      const known = error instanceof PlatformAccountError;
      res.status(known ? error.status : 502).json({ error: known ? error.code : 'platform_unavailable' });
    }
  };
  const jsonBody = express.json({ limit: '1mb' });
  const bodyRoute = (handler) => route(async (req, res) => {
    await new Promise((resolve, reject) => jsonBody(req, res, (error) => error ? reject(new PlatformAccountError('invalid_request', error.status === 413 ? 413 : 400)) : resolve()));
    return handler(req, res);
  });
  app.get('/api/platform-account/profile', route(async (req, res) => res.json(await runtime.read(await identity(req, res)))));
  app.patch('/api/platform-account/profile', bodyRoute(async (req, res) => res.json(await runtime.update(await identity(req, res), req.body))));
  app.post('/api/platform-account/password', bodyRoute(async (req, res) => res.json(await runtime.changePassword(await identity(req, res), req.body))));
  app.put('/api/platform-account/avatar', bodyRoute(async (req, res) => res.json(await runtime.updateAvatar(await identity(req, res), req.body))));
  app.get('/api/platform-account/avatar', route(async (req, res) => {
    const value = await runtime.avatar(await identity(req, res));
    res.setHeader('Content-Type', value.contentType);
    res.setHeader('Content-Length', String(value.bytes.length));
    res.end(value.bytes);
  }));
};
