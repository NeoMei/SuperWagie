import crypto from 'node:crypto';
import { z } from 'zod';

const identifier = /^[A-Za-z0-9._:-]{1,200}$/;
const opaque = /^[a-f0-9]{64}$/;
const allowedPairs = Object.freeze({
  'unihub-text-embedding-v4:embeddings.create': { model: 'unihub-text-embedding-v4', wire: 'embeddings.create', upstream: 'text-embedding-v4', path: '/embeddings', operation: 'embedding' },
  'qwen3-rerank:rerank.create': { model: 'qwen3-rerank', wire: 'rerank.create', upstream: 'qwen3-rerank', path: '/platform/api/v1/services/rerank/text-rerank/text-rerank', operation: 'rerank' },
});
const embeddingSpaceSchema = z.object({ provider: z.literal('aliyun'), model: z.literal('text-embedding-v4'), version: z.literal('v4'), dimensions: z.literal(1024), input_semantics: z.literal('text') }).strict();
const grantSchema = z.object({
  operations: z.record(z.string(), z.array(z.string())).optional(), credential_kind: z.string().optional(), instance_id: z.string().optional(),
  funding_mode: z.string(), asset: z.string(), billing_profile_version: z.number().int().nonnegative(), id: z.string().min(1), audience: z.literal('llmrouter'),
  actor_id: z.string().min(1), account_id: z.string().min(1), origin_product_id: z.literal('superwagie'), models: z.array(z.string()), task_id: z.string(),
  expires_at: z.string(), token: z.string().min(1),
}).strict();
const dispatchRouteSchema = z.object({
  version: z.literal(1), issuer: z.literal('llmrouter-knowledge-v1'), audience: z.literal('superwagie'), origin_product_id: z.literal('superwagie'),
  instance_id: z.string().min(1), actor_id: z.string().min(1), account_id: z.string().min(1), task_id: z.string().min(1), authorized_credential_id: z.string().min(1),
  model: z.string(), wire_operation: z.string(), policy_digest: z.string().regex(opaque), route_generation: z.string().regex(opaque), embedding_space: embeddingSpaceSchema.optional(),
  issued_at: z.number().int().nonnegative(), expires_at: z.number().int().positive(),
}).strict();
const indexReadRouteSchema = z.object({
  version: z.literal(1), purpose: z.literal('index_read'), issuer: z.literal('llmrouter-knowledge-v1'), audience: z.literal('superwagie'),
  origin_product_id: z.literal('superwagie'), instance_id: z.string().min(1), actor_id: z.string().min(1), account_id: z.string().min(1),
  access_version: z.number().int().nonnegative(), model: z.string(), wire_operation: z.string(), policy_digest: z.string().regex(opaque),
  route_generation: z.string().regex(opaque), embedding_space: embeddingSpaceSchema.optional(), issued_at: z.number().int().nonnegative(), expires_at: z.number().int().positive(),
}).strict();
const receiptBindingFields = {
  version: z.literal(1), issuer: z.literal('llmrouter-knowledge-v1'), audience: z.literal('superwagie'), origin_product_id: z.literal('superwagie'),
  instance_id: z.string().min(1), actor_id: z.string().min(1), account_id: z.string().min(1), task_id: z.string().min(1), call_id: z.string().min(1),
  attempt_id: z.number().int().positive(), status: z.literal('SETTLED'), producer_credential_id: z.string().min(1), authorized_credential_id: z.string().min(1),
  model: z.string(), wire_operation: z.string(), policy_digest: z.string().regex(opaque), route_generation: z.string().regex(opaque),
};
const embeddingReceiptSchema = z.object({ ...receiptBindingFields, embedding_space: embeddingSpaceSchema, content_sha256: z.string().regex(opaque), issued_at: z.number().int().nonnegative(), expires_at: z.number().int().positive() }).strict();
const rerankReceiptSchema = z.object({ ...receiptBindingFields, content_sha256: z.string().regex(opaque), issued_at: z.number().int().nonnegative(), expires_at: z.number().int().positive() }).strict();
const embeddingBodySchema = z.object({ model: z.literal('unihub-text-embedding-v4'), input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]), dimensions: z.literal(1024), encoding_format: z.literal('float').optional(), user: z.string().max(256).optional() }).strict();
const rerankBodySchema = z.object({
  model: z.literal('qwen3-rerank'),
  input: z.object({ query: z.string().min(1), documents: z.array(z.string().min(1)).min(1).max(100) }).strict(),
  parameters: z.object({ top_n: z.literal(1), return_documents: z.literal(false) }).strict(),
}).strict();
const utf8 = new TextDecoder('utf-8', { fatal: true });

const reject = (code, status = 503) => { const error = new Error(code); error.code = code; error.status = status; throw error; };
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const fixedPair = (model, wire) => allowedPairs[`${model}:${wire}`] || reject('platform_knowledge_request_invalid', 400);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const parseUniqueJson = (text) => {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor += 1; };
  const string = () => {
    const start = cursor;
    if (text[cursor++] !== '"') throw new Error('invalid json string');
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === '"') return JSON.parse(text.slice(start, cursor));
      if (character === '\\') { if (cursor >= text.length) throw new Error('invalid json escape'); cursor += 1; }
      else if (character.charCodeAt(0) < 0x20) throw new Error('invalid json control');
    }
    throw new Error('unterminated json string');
  };
  const value = () => {
    whitespace();
    if (text[cursor] === '"') { string(); return; }
    if (text[cursor] === '{') {
      cursor += 1; whitespace(); const keys = new Set();
      if (text[cursor] === '}') { cursor += 1; return; }
      while (cursor < text.length) {
        whitespace(); const key = string();
        if (keys.has(key)) throw new Error('duplicate json key');
        keys.add(key); whitespace(); if (text[cursor++] !== ':') throw new Error('invalid json object');
        value(); whitespace(); const separator = text[cursor++];
        if (separator === '}') return;
        if (separator !== ',') throw new Error('invalid json object');
      }
      throw new Error('unterminated json object');
    }
    if (text[cursor] === '[') {
      cursor += 1; whitespace();
      if (text[cursor] === ']') { cursor += 1; return; }
      while (cursor < text.length) { value(); whitespace(); const separator = text[cursor++]; if (separator === ']') return; if (separator !== ',') throw new Error('invalid json array'); }
      throw new Error('unterminated json array');
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(cursor));
    if (!primitive) throw new Error('invalid json value');
    cursor += primitive[0].length;
  };
  value(); whitespace(); if (cursor !== text.length) throw new Error('trailing json data');
  return JSON.parse(text);
};
const readJsonResponse = async (response, code, maxBytes) => {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); reject(code, response.status === 401 ? 401 : 503); }
  const reader = response.body?.getReader(); if (!reader) reject(code);
  const chunks = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maxBytes) { await reader.cancel(); reject(code); } chunks.push(part.value); }
  } catch (error) { if (error?.code) throw error; reject(code); }
  try { return parseUniqueJson(utf8.decode(Buffer.concat(chunks))); } catch { reject(code); }
};
const canonicalReceipt = (receipt) => {
  const fields = ['version', 'issuer', 'audience', 'origin_product_id', 'instance_id', 'actor_id', 'account_id', 'task_id', 'call_id', 'attempt_id', 'status', 'producer_credential_id', 'authorized_credential_id', 'model', 'wire_operation', 'policy_digest', 'route_generation'];
  const ordered = Object.fromEntries(fields.map((field) => [field, receipt[field]]));
  if (receipt.embedding_space) ordered.embedding_space = Object.fromEntries(['provider', 'model', 'version', 'dimensions', 'input_semantics'].map((field) => [field, receipt.embedding_space[field]]));
  ordered.content_sha256 = receipt.content_sha256; ordered.issued_at = receipt.issued_at; ordered.expires_at = receipt.expires_at;
  return JSON.stringify(ordered);
};

export const createPlatformKnowledgeAdapter = ({ env, fetchImpl, now, enterprise, usePublicDefaults, captureSession, assertCurrentSession, requestOriginal }) => {
  const gateway = () => {
    const value = env.OPENCHAMBER_UNIHUB_GATEWAY_URL || (usePublicDefaults ? 'https://llmrouter.quukk.com/platform/v1' : '');
    let url;
    try { url = new URL(value); } catch { return reject('platform_knowledge_request_unavailable'); }
    if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/platform/v1' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) reject('platform_knowledge_request_unavailable');
    if (enterprise() && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) reject('enterprise_mode', 403);
    return { url, value };
  };
  const requestJson = async (url, init, code) => {
    let response;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { reject(code); }
    if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) { await response.body?.cancel(); reject(code); }
    return readJsonResponse(response, code, 1024);
  };
  const assertGateway = (captured) => { if (gateway().value !== captured) reject('platform_session_changed', 409); };
  const gatewayPath = (configuredGateway, path) => new URL(`${configuredGateway.url.href.replace(/\/$/, '')}${path}`, configuredGateway.url.origin);
  const issueGrant = async (session, key, accountVersion, taskId, pair, configuredGateway) => {
    assertCurrentSession(key, session, accountVersion);
    const response = await requestOriginal(session, `/v1/accounts/${encodeURIComponent(session.accountId)}/model-credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin_product_id: 'superwagie', models: [pair.model], task_id: taskId }),
    }, 'platform_knowledge_request_unavailable');
    assertCurrentSession(key, session, accountVersion); assertGateway(configuredGateway.value);
    const raw = await readJsonResponse(response, 'platform_knowledge_request_unavailable', 16 * 1024);
    assertCurrentSession(key, session, accountVersion); assertGateway(configuredGateway.value);
    const grant = grantSchema.safeParse(raw);
    const expiresAt = grant.success ? Date.parse(grant.data.expires_at) : Number.NaN;
    if (!grant.success || grant.data.actor_id !== session.user.id || grant.data.account_id !== session.accountId || grant.data.origin_product_id !== 'superwagie' || grant.data.task_id !== taskId || grant.data.audience !== 'llmrouter' || grant.data.models.length !== 1 || grant.data.models[0] !== pair.model || !Number.isFinite(expiresAt) || expiresAt <= now()) reject('platform_knowledge_request_unavailable', 403);
    return grant.data;
  };
  const validateRoute = (raw, session, taskId, grant, pair) => {
    const route = dispatchRouteSchema.safeParse(raw);
    const value = route.success ? route.data : null;
    const seconds = Math.floor(now() / 1000);
    if (!value || value.actor_id !== session.user.id || value.account_id !== session.accountId || value.task_id !== taskId || value.authorized_credential_id !== grant.id || value.model !== pair.model || value.wire_operation !== pair.wire || value.instance_id !== (env.OPENCHAMBER_UNIHUB_INSTANCE_ID || 'default') || value.issued_at > seconds || value.expires_at <= seconds || value.expires_at - value.issued_at > 60) reject('platform_knowledge_request_unavailable', 403);
    if (pair.operation === 'embedding' && !value.embedding_space) reject('platform_knowledge_request_unavailable', 403);
    return value;
  };
  const routePaid = async (session, grant, taskId, pair, key, version, configuredGateway) => {
    assertCurrentSession(key, session, version); assertGateway(configuredGateway.value);
    const url = gatewayPath(configuredGateway, '/knowledge/route');
    const route = validateRoute(await requestJson(url, {
      method: 'POST', headers: {
        Authorization: `Bearer ${grant.token}`, 'X-UniHub-Actor-Authorization': `Bearer ${session.accessToken}`,
        'X-UniHub-Task-ID': taskId, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ model: pair.model, wire_operation: pair.wire }),
    }, 'platform_knowledge_request_unavailable'), session, taskId, grant, pair);
    assertCurrentSession(key, session, version); assertGateway(configuredGateway.value);
    return route;
  };
  const publicRoute = (route) => ({ instanceId: route.instance_id, actorId: route.actor_id, accountId: route.account_id, taskId: route.task_id, authorizedCredentialId: route.authorized_credential_id, model: route.model, wireOperation: route.wire_operation, policyDigest: route.policy_digest, routeGeneration: route.route_generation, embeddingSpace: route.embedding_space });
  const preflightKnowledgeRoute = async (identity, request) => {
    if (!exactKeys(request, ['taskId', 'model', 'wireOperation'])) reject('platform_knowledge_request_invalid', 400);
    const { taskId, model, wireOperation } = request;
    if (!identifier.test(taskId ?? '')) reject('platform_knowledge_request_invalid', 400);
    const pair = fixedPair(model, wireOperation); const configuredGateway = gateway();
    const session = captureSession(identity); const key = session.key; const accountVersion = session.accountVersion;
    if (!session.accountId) reject('platform_account_required', 409);
    const grant = await issueGrant(session, key, accountVersion, taskId, pair, configuredGateway);
    const route = await routePaid(session, grant, taskId, pair, key, accountVersion, configuredGateway);
    return publicRoute(route);
  };
  const readCurrentKnowledgeRoute = async (identity, request) => {
    if (!exactKeys(request, ['accountId', 'model', 'wireOperation', 'expectedPolicyDigest'])) reject('platform_knowledge_request_invalid', 400);
    const { accountId, model, wireOperation, expectedPolicyDigest } = request;
    if (!opaque.test(expectedPolicyDigest ?? '')) reject('platform_knowledge_request_invalid', 400);
    const pair = fixedPair(model, wireOperation); const configuredGateway = gateway();
    const session = captureSession(identity); const key = session.key; const accountVersion = session.accountVersion;
    if (!session.accountId || accountId !== session.accountId) reject('platform_account_forbidden', 403);
    assertCurrentSession(key, session, accountVersion);
    const route = indexReadRouteSchema.safeParse(await requestJson(gatewayPath(configuredGateway, '/knowledge/route'), {
      method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'index_read', account_id: accountId, model: pair.model, wire_operation: pair.wire, policy_digest: expectedPolicyDigest }),
    }, 'platform_knowledge_route_unavailable'));
    assertCurrentSession(key, session, accountVersion); assertGateway(configuredGateway.value);
    const value = route.success ? route.data : null; const seconds = Math.floor(now() / 1000);
    if (!value || value.actor_id !== session.user.id || value.account_id !== accountId || value.instance_id !== (env.OPENCHAMBER_UNIHUB_INSTANCE_ID || 'default') || value.model !== pair.model || value.wire_operation !== pair.wire || value.policy_digest !== expectedPolicyDigest || value.issued_at > seconds || value.expires_at <= seconds || value.expires_at - value.issued_at > 30 || (pair.operation === 'embedding' && !value.embedding_space)) reject('platform_knowledge_route_unavailable', 403);
    return { purpose: 'index_read', instanceId: value.instance_id, actorId: value.actor_id, accountId: value.account_id, accessVersion: value.access_version, model: value.model, wireOperation: value.wire_operation, policyDigest: value.policy_digest, routeGeneration: value.route_generation, embeddingSpace: value.embedding_space, issuedAt: value.issued_at, expiresAt: value.expires_at };
  };
  const dispatchPinned = async (identity, request, wireOperation) => {
    if (!exactKeys(request, ['taskId', 'callId', 'model', 'policyDigest', 'body'])) reject('platform_knowledge_request_invalid', 400);
    const { taskId, callId, model, policyDigest, body: sourceBody } = request;
    const pair = fixedPair(model, wireOperation);
    if (!identifier.test(taskId ?? '') || !/^wk_[a-f0-9]{60}$/.test(callId ?? '') || !opaque.test(policyDigest ?? '') || !Buffer.isBuffer(sourceBody) || sourceBody.length < 1 || sourceBody.length > 1024 * 1024) reject('platform_knowledge_request_invalid', 400);
    const body = Buffer.from(sourceBody);
    let input;
    try { input = parseUniqueJson(utf8.decode(body)); } catch { reject('platform_knowledge_request_invalid', 400); }
    const bodySchema = pair.operation === 'embedding' ? embeddingBodySchema : rerankBodySchema;
    if (!bodySchema.safeParse(input).success) reject('platform_knowledge_request_invalid', 400);
    const configuredGateway = gateway(); const session = captureSession(identity); const key = session.key; const accountVersion = session.accountVersion;
    if (!session.accountId) reject('platform_account_required', 409);
    const grant = await issueGrant(session, key, accountVersion, taskId, pair, configuredGateway);
    const route = await routePaid(session, grant, taskId, pair, key, accountVersion, configuredGateway);
    if (policyDigest !== route.policy_digest) reject('platform_knowledge_request_unavailable', 409);
    assertCurrentSession(key, session, accountVersion); assertGateway(configuredGateway.value);
    let response;
    const dispatchUrl = pair.operation === 'embedding' ? gatewayPath(configuredGateway, pair.path) : new URL(pair.path, configuredGateway.url.origin);
    try { response = await fetchImpl(dispatchUrl, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}`, 'X-UniHub-Actor-Authorization': `Bearer ${session.accessToken}`, 'X-UniHub-Task-ID': taskId, 'Idempotency-Key': callId, 'X-UniHub-Knowledge-Policy': route.policy_digest, 'Content-Type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
    catch { reject('platform_knowledge_outcome_unknown', 503); }
    await response.body?.cancel(); assertCurrentSession(key, session, accountVersion); assertGateway(configuredGateway.value);
    if (!response.ok) reject('platform_knowledge_outcome_unknown', 503);
  };
  const dispatchKnowledgeEmbeddingPinned = (identity, request) => dispatchPinned(identity, request, 'embeddings.create');
  const dispatchKnowledgeRerankPinned = (identity, request) => dispatchPinned(identity, request, 'rerank.create');
  const readKnowledgeResultWithEvidence = async (identity, request) => {
    if (!exactKeys(request, ['taskId', 'callId', 'model', 'wireOperation'])) reject('platform_knowledge_result_invalid', 400);
    const { taskId, callId, model, wireOperation } = request;
    if (!identifier.test(taskId ?? '') || !/^wk_[a-f0-9]{60}$/.test(callId ?? '')) reject('platform_knowledge_result_invalid', 400);
    const pair = fixedPair(model, wireOperation); const configuredGateway = gateway();
    const session = captureSession(identity); const key = session.key; const accountVersion = session.accountVersion;
    if (!session.accountId) reject('platform_account_required', 409);
    const grant = await issueGrant(session, key, accountVersion, taskId, pair, configuredGateway);
    const responseUrl = gatewayPath(configuredGateway, `/knowledge/results/${encodeURIComponent(callId)}`);
    assertCurrentSession(key, session, accountVersion); assertGateway(configuredGateway.value);
    let response;
    try { response = await fetchImpl(responseUrl, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}`, 'X-UniHub-Actor-Authorization': `Bearer ${session.accessToken}`, 'X-UniHub-Task-ID': taskId }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { reject('platform_knowledge_result_unavailable', 503); }
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) { await response.body?.cancel(); reject('platform_knowledge_result_unavailable', 404); }
    const receiptHeader = response.headers.get('x-unihub-knowledge-receipt');
    if (!receiptHeader || receiptHeader.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(receiptHeader)) { await response.body?.cancel(); reject('platform_knowledge_result_unavailable', 503); }
    const reader = response.body?.getReader(); if (!reader) reject('platform_knowledge_result_unavailable', 503);
    const chunks = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 16 * 1024 * 1024) { await reader.cancel(); reject('platform_knowledge_result_unavailable', 503); } chunks.push(part.value); }
    } catch (error) { if (error?.code) throw error; reject('platform_knowledge_result_unavailable', 503); }
    const rawBytes = Buffer.concat(chunks); assertCurrentSession(key, session, accountVersion); assertGateway(configuredGateway.value);
    let receipt;
    try {
      const receiptText = Buffer.from(receiptHeader, 'base64url').toString('utf8');
      if (Buffer.from(receiptText, 'utf8').toString('base64url') !== receiptHeader) throw new Error('invalid base64url');
      receipt = parseUniqueJson(receiptText);
    } catch { reject('platform_knowledge_result_unavailable', 503); }
    const schema = pair.operation === 'embedding' ? embeddingReceiptSchema : rerankReceiptSchema;
    const parsed = schema.safeParse(receipt); const seconds = Math.floor(now() / 1000);
    if (!parsed.success || receipt.actor_id !== session.user.id || receipt.account_id !== session.accountId || receipt.instance_id !== (env.OPENCHAMBER_UNIHUB_INSTANCE_ID || 'default') || receipt.task_id !== taskId || receipt.call_id !== callId || receipt.model !== pair.model || receipt.wire_operation !== pair.wire || receipt.authorized_credential_id !== grant.id || receipt.expires_at <= seconds || receipt.issued_at > seconds || receipt.expires_at - receipt.issued_at > 30 || receipt.content_sha256 !== sha256(rawBytes) || canonicalReceipt(receipt) !== Buffer.from(receiptHeader, 'base64url').toString('utf8')) reject('platform_knowledge_result_unavailable', 403);
    try { parseUniqueJson(utf8.decode(rawBytes)); } catch { reject('platform_knowledge_result_unavailable', 503); }
    assertCurrentSession(key, session, accountVersion);
    return { rawBytes, receipt: { version: receipt.version, issuer: receipt.issuer, audience: receipt.audience, originProductId: receipt.origin_product_id, instanceId: receipt.instance_id, actorId: receipt.actor_id, accountId: receipt.account_id, taskId: receipt.task_id, callId: receipt.call_id, attemptId: receipt.attempt_id, status: receipt.status, producerCredentialId: receipt.producer_credential_id, authorizedCredentialId: receipt.authorized_credential_id, model: receipt.model, wireOperation: receipt.wire_operation, policyDigest: receipt.policy_digest, routeGeneration: receipt.route_generation, embeddingSpace: receipt.embedding_space, contentSha256: receipt.content_sha256, issuedAt: receipt.issued_at, expiresAt: receipt.expires_at } };
  };
  return { preflightKnowledgeRoute, readCurrentKnowledgeRoute, dispatchKnowledgeEmbeddingPinned, dispatchKnowledgeRerankPinned, readKnowledgeResultWithEvidence };
};
