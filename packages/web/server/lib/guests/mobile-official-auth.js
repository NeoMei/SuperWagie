import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { PlatformAccountError } from '../platform-account/runtime.js';
import { sessionCookieNameForRequest } from '../ui-auth/session-cookie.js';
import { isSpaceRequest } from '../spaces/dispatcher.js';

const PREFIX = '/api/mobile-official';
const TTL = 12 * 60 * 60 * 1000;
const cookieValue = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const accountRequest = z.object({ accountId: z.string().min(1).max(200) }).strict();
const pathOf = (req) => new URL(req.originalUrl || req.url, 'http://localhost').pathname.toLowerCase().replace(/\/$/, '');
export const isMobileOfficialAuthRequest = (req) => {
  const pathname = pathOf(req);
  return req.method === 'GET' && [`${PREFIX}/auth/session`, `${PREFIX}/auth/auth-methods`].includes(pathname)
    || req.method === 'POST' && [`${PREFIX}/auth/password-login`, `${PREFIX}/auth/account`, `${PREFIX}/auth/logout`].includes(pathname);
};
const isPilotRead = (req) => req.method === 'GET' && (pathOf(req) === `${PREFIX}/reader` || pathOf(req) === `${PREFIX}/reader/projects`
  || /^\/api\/mobile-official\/reader\/[a-f0-9-]{36}\/content$/.test(pathOf(req)));
const isFullRead = (req) => req.method === 'GET' && (pathOf(req) === PREFIX || pathOf(req) === `${PREFIX}/projects`
  || /^\/api\/mobile-official\/[a-f0-9-]{36}\/content$/.test(pathOf(req)));
const fail = (code, status = 403) => { throw new PlatformAccountError(code, status); };

/** The pilot namespace is deliberately invisible to ordinary platform/UI identity resolvers. */
export const createMobileOfficialAccess = ({ getAccountRuntime, resolveFullIdentity, captureTransport, isRequestOriginAllowed, now = Date.now }) => {
  const sessions = new Map();
  const transports = new WeakMap();
  const requireTransport = async (req) => {
    let pending = transports.get(req);
    if (!pending) { pending = Promise.resolve(captureTransport(req)); transports.set(req, pending); }
    const isCurrent = await pending;
    if (!isCurrent || !await isCurrent()) fail('platform_runtime_auth_required', 401);
  };
  const cookieName = (req) => sessionCookieNameForRequest(req, 'oc_mobile_official');
  const tokenOf = (req) => {
    const match = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName(req)}=`));
    const parsed = cookieValue.safeParse(match?.slice(cookieName(req).length + 1));
    return parsed.success ? parsed.data : null;
  };
  const find = (req) => {
    const token = tokenOf(req); const entry = token ? sessions.get(token) : null;
    if (!entry || entry.expiresAt <= now()) { if (token) sessions.delete(token); return null; }
    return { token, entry };
  };
  const current = (record) => { if (sessions.get(record.token) !== record.entry || record.entry.expiresAt <= now()) fail('platform_session_changed', 409); };
  const establish = async (req, res) => {
    if (req.headers.authorization !== undefined && !await resolveFullIdentity(req, res, { allowUrlToken: false })) fail('platform_runtime_auth_required', 401);
    const existing = find(req); if (existing) return existing;
    for (const [token, entry] of sessions) if (entry.expiresAt <= now()) sessions.delete(token);
    if (sessions.size >= 128) fail('platform_access_unavailable', 503);
    const token = crypto.randomBytes(32).toString('base64url');
    const entry = { identity: { type: 'session', token: `mobile-official:${token}` }, expiresAt: now() + TTL };
    sessions.set(token, entry);
    res.cookie(cookieName(req), token, { httpOnly: true, sameSite: 'lax', secure: req.secure === true, maxAge: TTL, path: PREFIX });
    return { token, entry };
  };
  const resolveIdentity = async (req, res, options) => {
    if (isPilotRead(req) || isFullRead(req)) await requireTransport(req);
    if (isPilotRead(req)) {
      // Dedicated reader ownership never falls back to an ambient full account.
      if (req.headers.authorization !== undefined && !await resolveFullIdentity(req, res, { allowUrlToken: false })) return null;
      return find(req)?.entry.identity ?? null;
    }
    return resolveFullIdentity(req, res, options);
  };
  const register = (app) => {
    const route = (handler) => async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      try {
        if (isSpaceRequest(req)) fail('mobile_host_only');
        await requireTransport(req);
        if (req.headers.authorization !== undefined && !await resolveFullIdentity(req, res, { allowUrlToken: false })) fail('platform_runtime_auth_required', 401);
        if (req.method !== 'GET' && !await isRequestOriginAllowed(req)) fail('platform_origin_forbidden');
        await handler(req, res);
      } catch (error) {
        const known = error instanceof PlatformAccountError;
        const body = { error: known ? error.code : 'platform_unavailable' };
        if (known && error.retryAfter !== undefined) { body.retry_after = error.retryAfter; res.setHeader('Retry-After', String(error.retryAfter)); }
        res.status(known ? error.status : 503).json(body);
      }
    };
    const runtime = () => { const value = getAccountRuntime(); if (!value) fail('platform_unconfigured', 503); return value; };
    const read = async (record) => {
      const state = await runtime().identitySession(record.entry.identity); current(record);
      if (state.status !== 'signed-in') {
        if (['signed-out', 'expired'].includes(state.status) && !runtime().authMethods(record.entry.identity).passwordLogin) return { status: 'unconfigured' };
        return state;
      }
      const accounts = await runtime().identityAccounts(record.entry.identity); current(record);
      return { ...state, ...accounts };
    };
    const send = async (req, res, value) => { await requireTransport(req); res.json(value); };
    app.get(`${PREFIX}/auth/session`, route(async (req, res) => send(req, res, await read(await establish(req, res)))));
    app.get(`${PREFIX}/auth/auth-methods`, route(async (req, res) => {
      const record = await establish(req, res);
      await send(req, res, { passwordLogin: runtime().authMethods(record.entry.identity).passwordLogin });
    }));
    app.post(`${PREFIX}/auth/password-login`, express.json({ limit: '8kb' }), route(async (req, res) => {
      const record = await establish(req, res);
      await runtime().passwordLogin(record.entry.identity, req.body); current(record);
      await send(req, res, await read(record));
    }));
    app.post(`${PREFIX}/auth/account`, express.json({ limit: '2kb' }), route(async (req, res) => {
      const input = accountRequest.safeParse(req.body); if (!input.success) fail('invalid_request', 400);
      const record = await establish(req, res);
      await runtime().identityAccounts(record.entry.identity, input.data.accountId); current(record);
      await send(req, res, await read(record));
    }));
    app.post(`${PREFIX}/auth/logout`, route(async (req, res) => {
      const record = find(req);
      if (record) { sessions.delete(record.token); runtime().logout(record.entry.identity); }
      res.clearCookie(cookieName(req), { path: PREFIX });
      await send(req, res, { status: 'signed-out' });
    }));
  };
  return { register, resolveIdentity };
};
