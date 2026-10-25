import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { PlatformModelError } from './runtime.js';

const fail = (res, error) => res.status(error instanceof PlatformModelError ? error.status : 503).json({ error: error instanceof PlatformModelError ? error.code : 'platform_models_unavailable' });
const promptBodySchema = z.object({ id: z.string().nullish() }).passthrough();

/** Authenticated UI traffic supplies identity; the plugin callback has a separate listener. */
export const registerPlatformModelRoutes = (app, { runtime, resolveIdentity, readSession, isRequestOriginAllowed }) => {
  const identity = (req, res) => resolveIdentity(req, res, { allowUrlToken: false });
  const parseJson = express.json({ limit: '1mb', inflate: false });
  const readPrompt = (req, res) => new Promise((resolve, reject) => {
    if (!req.is('application/json')) return reject(new PlatformModelError('platform_prompt_invalid', 400));
    // The common middleware preserves OpenCode request streams. The owning proxy replays
    // this parsed body, including the server-assigned prompt ID, with corrected framing.
    parseJson(req, res, (error) => error
      ? reject(new PlatformModelError(error.status === 413 ? 'platform_request_too_large' : 'platform_prompt_invalid', error.status === 413 ? 413 : 400))
      : resolve());
  });
  app.get('/api/platform-model/sessions/:sessionID', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(runtime.status(await identity(req, res), req.params.sessionID)); } catch (error) { fail(res, error); }
  });
  app.post('/api/platform-model/sessions/:sessionID/reconcile', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!await isRequestOriginAllowed(req)) throw new PlatformModelError('platform_origin_forbidden', 403);
      res.json(await runtime.reconcile(await identity(req, res), req.params.sessionID));
    } catch (error) { fail(res, error); }
  });
  // Prompt model selection lives on the authoritative session in OpenCode 2.
  app.use(async (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const sessionPath = /^\/api\/session\/([^/]+)(?:\/|$)/.exec(req.path);
    if (!sessionPath) return next();
    try {
      const who = await identity(req, res);
      runtime.authorizeSession(who, sessionPath[1]);
      const match = /^\/api\/session\/([^/]+)\/(prompt|generate|command|resume|synthetic)$/.exec(req.path);
      if (!match) return next();
      const session = await readSession(match[1]);
      if (session?.model?.providerID !== 'unihub') return next();
      if (!await isRequestOriginAllowed(req)) throw new PlatformModelError('platform_origin_forbidden', 403);
      if (!['prompt', 'synthetic'].includes(match[2])) throw new PlatformModelError('platform_protocol_unsupported', 403);
      await readPrompt(req, res);
      if (match[2] === 'synthetic' && req.body?.resume === false) return next();
      if (match[2] !== 'prompt') throw new PlatformModelError('platform_protocol_unsupported', 403);
      const prompt = promptBodySchema.safeParse(req.body);
      if (!prompt.success) throw new PlatformModelError('platform_prompt_invalid', 400);
      req.body = prompt.data;
      req.body.id ??= `msg_${crypto.randomUUID().replaceAll('-', '')}`;
      await runtime.admit(who, session, req.body.id);
      next();
    } catch (error) { fail(res, error); }
  });
};
