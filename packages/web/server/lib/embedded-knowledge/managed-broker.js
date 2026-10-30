import crypto from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';

// WeKnora owns the consumer protocol. The platform runtime owns task grants,
// durable call identity, reconciliation, and authorization to charge.
const ROUTES = Object.freeze({
  embedding: { path: '/v1/embeddings', contentType: 'application/json', maxBytes: 2 * 1024 * 1024 },
  rerank: { path: '/api/v1/services/rerank/text-rerank/text-rerank', contentType: 'application/json', maxBytes: 2 * 1024 * 1024 },
  vision: { path: '/v1/chat/completions', contentType: 'application/json', maxBytes: 12 * 1024 * 1024 },
  ocr: { path: '/api/v2/ocr/jobs', contentType: 'multipart/form-data', maxBytes: 32 * 1024 * 1024 },
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_RESPONSE = 16 * 1024 * 1024;
const error = (code, status) => Object.assign(new Error(code), { code, status });
const fail = (code, status) => { throw error(code, status); };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const emitError = (res, status, code) => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { code } }));
};
const bodyBytes = async (req, limit) => {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) fail('knowledge_request_too_large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
const validateInput = async (purpose, model, contentType, body) => {
  if (purpose === 'ocr') {
    let form;
    try { form = await new Response(body, { headers: { 'content-type': contentType } }).formData(); }
    catch { fail('knowledge_request_invalid', 400); }
    const keys = [...form.keys()];
    if (keys.length !== 3 || new Set(keys).size !== 3 || keys.some((key) => !['model', 'file', 'optionalPayload'].includes(key)) || form.get('model') !== model) fail('knowledge_request_invalid', 400);
    const file = form.get('file');
    const optionalPayload = z.string().safeParse(form.get('optionalPayload'));
    if (!(file instanceof Blob) || !file.size || !optionalPayload.success) fail('knowledge_request_invalid', 400);
    try { if (!z.record(z.string(), z.unknown()).safeParse(JSON.parse(optionalPayload.data)).success) fail('knowledge_request_invalid', 400); }
    catch { fail('knowledge_request_invalid', 400); }
    return hash(JSON.stringify({ purpose, model, fileName: file.name, fileType: file.type, fileHash: hash(Buffer.from(await file.arrayBuffer())), optionalPayload: form.get('optionalPayload') }));
  }
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { fail('knowledge_request_invalid', 400); }
  const input = z.looseObject({ model: z.literal(model), stream: z.unknown().optional() }).safeParse(parsed);
  if (!input.success || (purpose === 'vision' && input.data.stream === true)) fail('knowledge_request_invalid', 400);
  return hash(Buffer.concat([Buffer.from(purpose + '\0' + model + '\0'), body]));
};
const resultResponse = (result) => {
  if (!result || result.status !== 200 || !z.string().regex(/^application\/json(?:;|$)/i).safeParse(result.contentType).success) fail('knowledge_provider_unavailable', 502);
  const bytes = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body ?? '');
  if (!bytes.length || bytes.length > MAX_RESPONSE) fail('knowledge_provider_unavailable', 502);
  try { JSON.parse(bytes.toString('utf8')); } catch { fail('knowledge_provider_unavailable', 502); }
  return { status: 200, contentType: 'application/json', body: bytes };
};

/**
 * A loopback capability bridge for one explicitly admitted knowledge owner.
 * The consumer must send stable Idempotency-Key values; older WeKnora builds
 * do not, so this bridge refuses them before a platform model call. Tokens are
 * purpose-scoped, expire in memory, and never authorize an arbitrary URL.
 * Injected callbacks must enforce the immutable owner, payer, model and task
 * through the platform runtime; broker results never contain those secrets.
 */
export async function createManagedKnowledgeBroker({ admit, validate, dispatch, read, now = () => Date.now(), resourceOrigin, port = 0, lifetimeMs = 60 * 60 * 1000 } = {}) {
  if (![admit, validate, dispatch, read].every((value) => z.function().safeParse(value).success)) throw new TypeError('managed knowledge callbacks required');
  const origin = new URL(resourceOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new TypeError('invalid knowledge resource origin');
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 60 * 60 * 1000) throw new TypeError('invalid knowledge scope lifetime');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid knowledge broker port');
  let scope = null; let closed = false; let opening = false;
  const pending = new Set();

  const verifyScope = async (current, binding) => {
    if (closed || scope !== current || now() >= current.expiresAt) fail('knowledge_scope_expired', 401);
    const valid = await validate({ identity: current.identity, actorID: current.actorID, accountID: current.accountID, sessionID: binding.sessionID, model: binding.model });
    if (valid !== true || scope !== current || now() >= current.expiresAt) fail('knowledge_scope_expired', 401);
  };
  const server = http.createServer((req, res) => {
    const task = (async () => {
      const current = scope;
      if (!current || closed) fail('knowledge_scope_unavailable', 401);
      if (req.url?.includes('?') || req.url?.includes('#') || req.headersDistinct?.authorization?.length !== 1) fail('knowledge_request_invalid', 400);
      const auth = req.headers.authorization ?? '';
      if (!/^Bearer [A-Za-z0-9_-]+$/i.test(auth)) fail('knowledge_unauthorized', 401);
      const tokenHash = hash(auth.slice(7));
      const binding = current.bindings.find((item) => item.tokenHash === tokenHash);
      if (!binding) fail('knowledge_unauthorized', 401);
      const route = ROUTES[binding.purpose];
      const ocrRead = binding.purpose === 'ocr' && req.method === 'GET' && req.url?.startsWith(route.path + '/');
      const callID = ocrRead ? req.url.slice(route.path.length + 1) : null;
      if (ocrRead) {
        if (!ID.test(callID) || !current.jobs.has(callID) || current.jobs.get(callID).binding !== binding) fail('knowledge_task_not_found', 404);
        await verifyScope(current, binding);
        const result = resultResponse(await read({ identity: current.identity, actorID: current.actorID, accountID: current.accountID, sessionID: binding.sessionID, model: binding.model, operation: 'ocr', callID, path: '/platform/api/v2/ocr/jobs/' + encodeURIComponent(callID) }));
        const value = JSON.parse(result.body.toString('utf8'));
        const state = String(value?.data?.state ?? '').toLowerCase();
        if (!['pending', 'processing', 'running', 'done', 'failed'].includes(state) || value?.data?.jobId !== callID) fail('knowledge_provider_unavailable', 502);
        if (state === 'done') {
          let url;
          try { url = new URL(value?.data?.resultUrl?.jsonUrl); } catch { fail('knowledge_provider_unavailable', 502); }
          if (url.origin !== origin.origin || url.username || url.password || url.hash || !/^\/api\/ocr\/jobs\/[^/]+\/resources\/[^/]+$/.test(url.pathname)) fail('knowledge_provider_unavailable', 502);
        }
        if (state === 'done' || state === 'failed') current.jobs.get(callID).terminal = true;
        if (!res.destroyed) { res.writeHead(result.status, { 'content-type': result.contentType, 'cache-control': 'no-store' }); res.end(result.body); }
        return;
      }
      if (req.method !== 'POST' || req.url !== route.path) fail('knowledge_route_unsupported', 404);
      const key = req.headers['idempotency-key'];
      if (req.headersDistinct?.['idempotency-key']?.length !== 1 || !z.string().regex(ID).safeParse(key).success) fail('knowledge_stable_call_required', 400);
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith(route.contentType) || (route.contentType === 'application/json' && !/^application\/json(?:\s*;|$)/i.test(contentType))) fail('knowledge_request_invalid', 400);
      const body = await bodyBytes(req, route.maxBytes);
      const digest = await validateInput(binding.purpose, binding.model, contentType, body);
      await verifyScope(current, binding);
      const entryKey = `${binding.purpose}:${key}`;
      const previous = current.calls.get(entryKey);
      if (previous) {
        if (previous.digest !== digest) fail('knowledge_call_conflict', 409);
        if (previous.state !== 'complete' || !previous.result) fail('knowledge_reconciliation_required', 409);
        if (!res.destroyed) { res.writeHead(200, { 'content-type': previous.result.contentType, 'cache-control': 'no-store' }); res.end(previous.result.body); }
        return;
      }
      if (current.calls.size >= 4096) fail('knowledge_scope_capacity', 409);
      // The managed worker has already derived a work- and batch-bound ID.
      // Preserve it so gateway settlement and worker recovery address one call.
      const logicalID = /^wk_[a-f0-9]{60}$/.test(key) ? key : 'kb_' + hash(`${binding.taskID}\0${binding.purpose}\0${key}`);
      const entry = { digest, state: 'pending', callID: logicalID, result: null };
      current.calls.set(entryKey, entry);
      const run = binding.queue.then(async () => {
        try { await verifyScope(current, binding); }
        catch (err) { current.calls.delete(entryKey); throw err; }
        try {
          const result = resultResponse(await dispatch({ identity: current.identity, actorID: current.actorID, accountID: current.accountID, sessionID: binding.sessionID, model: binding.model, operation: binding.purpose, callID: logicalID, path: route.path, contentType, body }));
          if (binding.purpose === 'ocr') {
            const value = JSON.parse(result.body.toString('utf8'));
            if (value?.data?.jobId !== logicalID) fail('knowledge_provider_unavailable', 502);
            current.jobs.set(logicalID, { binding, terminal: false });
          }
          entry.state = 'complete'; entry.result = result; current.cachedBytes += result.body.length;
          for (const other of current.calls.values()) {
            if (current.cachedBytes <= 32 * 1024 * 1024) break;
            if (other !== entry && other.state === 'complete' && other.result) {
              current.cachedBytes -= other.result.body.length;
              other.result = null;
            }
          }
          return result;
        } catch (err) {
          if (err?.definitelyNotSent === true) current.calls.delete(entryKey);
          else entry.state = 'unknown';
          throw err;
        }
      });
      binding.queue = run.catch(() => {});
      const result = await run;
      if (!res.destroyed) { res.writeHead(200, { 'content-type': result.contentType, 'cache-control': 'no-store' }); res.end(result.body); }
    })().catch((err) => emitError(res, [400, 401, 404, 409, 413].includes(err?.status) ? err.status : 502, z.string().regex(/^knowledge_[a-z_]+$/).safeParse(err?.code).success ? err.code : 'knowledge_provider_unavailable'));
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  server.maxConnections = 8;
  server.requestTimeout = 185_000; server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async activate(identity, selected) {
      if (closed || scope || opening) fail('knowledge_scope_busy', 409);
      const selection = z.partialRecord(z.enum(['embedding', 'rerank', 'vision', 'ocr']), z.string().regex(MODEL)).safeParse(selected);
      if (!identity || !selection.success) fail('knowledge_scope_invalid', 400);
      const entries = Object.entries(selection.data);
      if (!entries.length) fail('knowledge_scope_invalid', 400);
      opening = true;
      try {
        const admitted = [];
        for (const [purpose, model] of entries) {
          const task = await admit({ identity, purpose, model });
          if (closed) fail('knowledge_scope_unavailable', 401);
          if (!task || !ID.test(task.sessionID ?? '') || !ID.test(task.taskID ?? '') || !ID.test(task.actorID ?? '') || !ID.test(task.accountID ?? '') || task.model !== model) fail('knowledge_scope_invalid', 403);
          admitted.push({ purpose, model, ...task });
        }
        if (admitted.some((item) => item.actorID !== admitted[0].actorID || item.accountID !== admitted[0].accountID)) fail('knowledge_scope_invalid', 403);
        const bindings = admitted.map((item) => { const token = crypto.randomBytes(32).toString('base64url'); return { ...item, token, tokenHash: hash(token), queue: Promise.resolve() }; });
        scope = { identity, actorID: admitted[0].actorID, accountID: admitted[0].accountID, bindings, expiresAt: now() + lifetimeMs, calls: new Map(), jobs: new Map(), cachedBytes: 0 };
        return { expiresAt: scope.expiresAt, bindings: Object.fromEntries(bindings.map(({ purpose, model, token }) => [purpose, { purpose, model, protocol: 'managed-media', baseUrl: purpose === 'ocr' || purpose === 'rerank' ? base + ROUTES[purpose].path : base + '/v1', apiKey: token }])) };
      } finally { opening = false; }
    },
    release() {
      if (!scope) return;
      if (pending.size || [...scope.calls.values()].some((entry) => entry.state !== 'complete') || [...scope.jobs.values()].some((job) => !job.terminal)) fail('knowledge_reconciliation_required', 409);
      scope = null;
    },
    async close() {
      closed = true; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await Promise.allSettled([...pending]); scope = null;
    },
  };
}
