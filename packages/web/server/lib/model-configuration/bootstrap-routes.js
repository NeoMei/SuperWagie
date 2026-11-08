import express from 'express';
import { z } from 'zod';

import { fundingModeSchema } from './native-credit-contract.js';
import { ModelConfigurationError } from './runtime.js';

const source = z.enum(['session', 'imported-key']);
const purposes = z.array(z.string().min(1).max(100)).max(20).optional();
const route = (handler) => async (request, response) => {
  try { response.json(await handler(request, response)); }
  catch (error) {
    if (error instanceof ModelConfigurationError) response.status(error.status).json({ error: error.code, code: error.code });
    else if (Number.isInteger(error?.status) && error?.code) response.status(error.status).json({ error: error.code, code: error.code });
    else response.status(500).json({ error: 'model_configuration_bootstrap_failed' });
  }
};
const body = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ModelConfigurationError('model_configuration_invalid_input', 400);
  return parsed.data;
};

export const registerModelBootstrapRoutes = (app, { bootstrapRuntime, resolveIdentity, resolveOwner } = {}) => {
  const parseBody = express.json({ limit: '64kb' });
  app.use('/api/model-configuration/bootstrap', (request, response, next) => parseBody(request, response, (error) => {
    if (error) return response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'model_configuration_invalid_input', code: 'model_configuration_invalid_input' });
    return next();
  }));
  const unsupported = () => { throw new ModelConfigurationError('model_configuration_bootstrap_unsupported', 501); };
  const identity = (request, response) => resolveIdentity ? resolveIdentity(request, response) : undefined;
  const ownerIdentity = (request, response) => resolveOwner ? resolveOwner(request, response, { allowClientAuth: true, allowUrlToken: false }) : identity(request, response);
  const requiredOwner = async (request, response) => {
    const value = await ownerIdentity(request, response);
    if (!value) throw new ModelConfigurationError('model_configuration_bootstrap_auth_required', 401);
    return value;
  };
  const requiredIdentity = async (request, response) => {
    const value = await identity(request, response);
    if (!value) throw new ModelConfigurationError('platform_account_required', 409);
    return value;
  };
  const optionalIdentity = async (request) => {
    try { return await identity(request, null); } catch { return undefined; }
  };
  const accountKeyInput = z.object({ accountId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/), fundingMode: fundingModeSchema.optional() }).strict();
  app.get('/api/model-configuration/bootstrap/account-key', route(async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.set('Referrer-Policy', 'no-referrer');
    if (!bootstrapRuntime?.accountKey) return unsupported();
    return bootstrapRuntime.accountKey.read({ ...body(accountKeyInput, request.query), identity: await requiredIdentity(request, response), owner: await requiredOwner(request, response) });
  }));
  app.post('/api/model-configuration/bootstrap/account-key', route(async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.set('Referrer-Policy', 'no-referrer');
    if (!bootstrapRuntime?.accountKey) return unsupported();
    return bootstrapRuntime.accountKey.activate({ ...body(accountKeyInput.extend({ action: z.enum(['activate', 'resume', 'retest']) }), request.body), identity: await requiredIdentity(request, response), owner: await requiredOwner(request, response) });
  }));
  app.post('/api/model-configuration/bootstrap/discover', route(async (request, response) => {
    if (!bootstrapRuntime) return unsupported();
    const input = body(z.object({ source, key: z.string().min(1).max(8192).optional(), fundingMode: fundingModeSchema.optional() }).strict(), request.body);
    return bootstrapRuntime.discover({ ...input, identity: input.source === 'session' ? await requiredIdentity(request, response) : undefined, owner: await requiredOwner(request, response) });
  }));
  app.post('/api/model-configuration/bootstrap/issue-key', route(async (request, response) => bootstrapRuntime ? bootstrapRuntime.issueKey({ ...body(z.object({ fundingMode: fundingModeSchema.optional(), models: z.array(z.string().min(1).max(200)).max(100).optional(), expiresAt: z.string().max(100).optional() }).strict(), request.body), identity: await requiredIdentity(request, response), owner: await requiredOwner(request, response) }) : unsupported()));
  app.post('/api/model-configuration/bootstrap/preview', route(async (request, response) => bootstrapRuntime ? bootstrapRuntime.preview({ ...body(z.object({ discoveryId: z.string().min(1).max(100), revision: z.number().int().nonnegative(), mode: z.enum(['fill-missing', 'replace-managed']).default('fill-missing'), purposes, selections: z.record(z.string(), z.string().max(200)).optional() }).strict(), request.body), identity: await optionalIdentity(request), owner: await requiredOwner(request, response) }) : unsupported()));
  app.post('/api/model-configuration/bootstrap/apply', route(async (request, response) => bootstrapRuntime ? bootstrapRuntime.apply({ ...body(z.object({ operationId: z.string().min(1).max(100), discoveryId: z.string().min(1).max(100), revision: z.number().int().nonnegative(), mode: z.enum(['fill-missing', 'replace-managed']).default('fill-missing'), selections: z.record(z.string(), z.string().max(200)).optional() }).strict(), request.body), identity: await optionalIdentity(request), owner: await requiredOwner(request, response) }) : unsupported()));
  app.post('/api/model-configuration/bootstrap/test', route((request) => bootstrapRuntime ? bootstrapRuntime.startTests(body(z.object({ revision: z.number().int().nonnegative(), purposes, expensive: z.boolean().default(false) }).strict(), request.body)) : unsupported()));
  app.get('/api/model-configuration/bootstrap/test/:id', route(({ params }) => bootstrapRuntime ? bootstrapRuntime.readTestRun(params.id) : unsupported()));
  app.post('/api/model-configuration/bootstrap/rollback', route(async (request, response) => bootstrapRuntime ? bootstrapRuntime.rollback({ ...body(z.object({ operationId: z.string().min(1).max(100), revision: z.number().int().nonnegative() }).strict(), request.body), identity: await optionalIdentity(request), owner: await requiredOwner(request, response) }) : unsupported()));
};
