import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { llmRouterInferenceApiUrl } from '../model-configuration/bootstrap-endpoints.js';

const JOBS = '/api/v2/ocr/jobs';
const MAX_REQUEST = 32 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const taskSchema = z.object({ id: identifier, job_id: identifier, state: z.enum(['pending', 'running', 'done', 'failed']) });
const statusSchema = taskSchema.extend({ progress: z.object({ totalPages: z.number().int().nonnegative(), extractedPages: z.number().int().nonnegative() }) });
const pageSchema = z.object({
  index: z.number().int().nonnegative().optional(), width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
  text: z.string(), layout: z.array(z.object({ label: z.string(), content: z.string(), bbox: z.array(z.number().finite()).length(4).optional() })).max(100000),
}).strict();
const documentSchema = z.object({ id: identifier, pages: z.array(pageSchema).min(1).max(1000) }).strict();
const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fingerprint = (binding) => hash(JSON.stringify([binding.connectionId, binding.providerId, binding.protocol, binding.baseUrl, binding.model, binding.apiKey, binding.parameters, binding.revision]));
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) return fail('knowledge_provider_unavailable', 502);
  return result.data;
};
const readBytes = async (stream, limit) => {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) return fail('knowledge_request_too_large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
const send = (response, status, value, contentType = 'application/json') => {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(value));
};

/** Translates the bundled parser's jobs contract while retaining account-key ownership. */
export const createAccountKeyOcrBroker = ({ resolveBinding, captureOwner, enterpriseOptions, fetchImpl = fetch, env = process.env, now = Date.now }) => {
  if (!(resolveBinding instanceof Function) || !(captureOwner instanceof Function)) throw new TypeError('OCR ownership callbacks required');
  const scopes = new Map();
  const tasks = new Set();
  const shutdown = new AbortController();
  let server; let opening; let origin; let closed = false;
  const policy = () => { if (closed || isEnterpriseMode(enterpriseOptions)) return fail('knowledge_scope_unavailable'); };
  const validateBinding = (binding) => {
    if (!binding || binding.purpose !== 'ocr' || binding.providerId !== 'llmrouter' || binding.protocol !== 'openai-compatible'
      || binding.baseUrl !== llmRouterInferenceApiUrl(env) || !binding.apiKey || !binding.connectionId || !identifier.safeParse(binding.model).success) return fail('model_configuration_account_key_conflict');
  };
  const currentBinding = async (scope) => {
    policy();
    if (now() >= scope.expiresAt) return fail('knowledge_scope_expired');
    try { await scope.owner.assertCurrent(); } catch { return fail('knowledge_scope_expired'); }
    const binding = await resolveBinding('ocr', { supportedProtocols: ['openai-compatible'] });
    validateBinding(binding);
    if (fingerprint(binding) !== scope.fingerprint) return fail('knowledge_scope_expired');
    policy();
    try { await scope.owner.assertCurrent(); } catch { return fail('knowledge_scope_expired'); }
    return binding;
  };
  const upstream = async (scope, suffix, init) => {
    const binding = await currentBinding(scope);
    let response;
    try {
      response = await fetchImpl(`${binding.baseUrl}/ocr${suffix}`, {
        ...init, headers: { ...init.headers, Authorization: `Bearer ${binding.apiKey}`, 'X-Should-Retry': 'false' },
        redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(init.method === 'POST' ? 60000 : 30000)]),
      });
    } catch { return fail('knowledge_reconciliation_required', 503); }
    await currentBinding(scope);
    if (!response.ok) return fail('knowledge_provider_unavailable', response.status >= 400 && response.status < 500 ? response.status : 503);
    let json;
    try { json = JSON.parse((await readBytes(response.body, MAX_RESPONSE)).toString('utf8')); }
    catch { return fail('knowledge_provider_unavailable', 502); }
    await currentBinding(scope);
    return json;
  };
  const handle = async (request, response) => {
    policy();
    if (request.headers.host !== new URL(origin).host || request.headers.origin || request.headersDistinct?.host?.length !== 1 || request.url?.includes('?') || request.url?.includes('#')) return fail('knowledge_request_forbidden');
    const resource = request.url?.match(/^\/ocr-document\/([A-Za-z0-9_-]{43})$/);
    if (resource && request.method === 'GET') {
      let match;
      for (const scope of scopes.values()) {
        for (const job of scope.jobs.values()) if (job.resource === resource[1]) match = { scope, job };
      }
      if (!match || now() >= match.job.resourceExpiresAt) return fail('knowledge_scope_expired');
      await currentBinding(match.scope);
      const document = parse(documentSchema, await upstream(match.scope, `/${encodeURIComponent(match.job.id)}/document`, { method: 'GET' }));
      if (document.id !== match.job.id) return fail('knowledge_provider_unavailable', 502);
      const pages = document.pages.map((page) => {
        const prunedResult = { parsing_res_list: page.layout.map((block) => {
          const value = { block_label: block.label, block_content: block.content };
          if (block.bbox) value.block_bbox = block.bbox;
          return value;
        }) };
        if (page.index !== undefined) prunedResult.page_index = page.index;
        if (page.width !== undefined) prunedResult.width = page.width;
        if (page.height !== undefined) prunedResult.height = page.height;
        return { markdown: { text: page.text }, prunedResult };
      });
      await currentBinding(match.scope);
      return send(response, 200, { result: { layoutParsingResults: pages } }, 'application/x-ndjson');
    }
    if (request.headersDistinct?.authorization?.length !== 1) return fail('knowledge_unauthorized');
    const credential = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
    const scope = scopes.get(credential);
    if (!scope) return fail('knowledge_unauthorized');
    await currentBinding(scope);
    if (request.method === 'POST' && request.url === JOBS) {
      const contentType = request.headers['content-type'];
      if (!contentType?.startsWith('multipart/form-data;')) return fail('knowledge_request_invalid', 400);
      const bytes = await readBytes(request, MAX_REQUEST);
      let form;
      try { form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); } catch { return fail('knowledge_request_invalid', 400); }
      const keys = [...form.keys()];
      if (keys.length !== 3 || new Set(keys).size !== 3 || keys.some((key) => !['model', 'file', 'optionalPayload'].includes(key)) || form.get('model') !== scope.model) return fail('knowledge_request_invalid', 400);
      const file = form.get('file');
      const optional = z.string().max(65536).safeParse(form.get('optionalPayload'));
      if (!(file instanceof Blob) || !file.size || !optional.success) return fail('knowledge_request_invalid', 400);
      try { if (!z.json().safeParse(JSON.parse(optional.data)).success) return fail('knowledge_request_invalid', 400); } catch { return fail('knowledge_request_invalid', 400); }
      const digest = hash(JSON.stringify([scope.requestIdentity, file.name, hash(Buffer.from(await file.arrayBuffer())), optional.data]));
      if (!scope.submissions.has(digest)) {
        if (scope.submissions.size >= 64) return fail('knowledge_request_limit', 429);
        const promise = (async () => {
          const result = parse(taskSchema, await upstream(scope, '', { method: 'POST', headers: { 'Content-Type': contentType, 'Idempotency-Key': `swocr-${digest}` }, body: bytes }));
          const localId = randomBytes(24).toString('base64url');
          scope.jobs.set(localId, { id: result.id, upstreamJobId: result.job_id, resource: null, resourceExpiresAt: 0 });
          return { data: { jobId: localId }, errorCode: 0, errorMsg: '' };
        })();
        scope.submissions.set(digest, promise);
      }
      const result = await scope.submissions.get(digest);
      await currentBinding(scope);
      return send(response, 200, result);
    }
    const localId = request.url?.startsWith(`${JOBS}/`) ? request.url.slice(JOBS.length + 1) : '';
    const job = scope.jobs.get(localId);
    if (request.method !== 'GET' || !job) return fail('knowledge_task_not_found', 404);
    const result = parse(statusSchema, await upstream(scope, `/${encodeURIComponent(job.id)}`, { method: 'GET' }));
    if (result.id !== job.id || result.job_id !== job.upstreamJobId || result.progress.extractedPages > result.progress.totalPages) return fail('knowledge_provider_unavailable', 502);
    const data = { jobId: localId, state: result.state, extractProgress: result.progress };
    if (result.state === 'done') {
      if (!job.resource || now() >= job.resourceExpiresAt) { job.resource = randomBytes(32).toString('base64url'); job.resourceExpiresAt = Math.min(scope.expiresAt, now() + 60000); }
      data.resultUrl = { jsonUrl: `${origin}/ocr-document/${job.resource}` };
    }
    return send(response, 200, { data });
  };
  const start = async () => {
    policy();
    if (origin) return;
    if (!opening) opening = new Promise((resolve, reject) => {
      server = http.createServer((request, response) => {
        const task = handle(request, response).catch((error) => send(response, error.status ?? 503, { error: { code: z.string().regex(/^(?:knowledge|model_configuration)_[a-z_]+$/).safeParse(error.code).success ? error.code : 'knowledge_scope_unavailable' } }));
        tasks.add(task); void task.finally(() => tasks.delete(task));
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve(); });
    });
    await opening;
  };
  return {
    materialize: async (binding) => {
      policy(); validateBinding(binding);
      const owner = await captureOwner(binding);
      if (!owner?.id || !(owner.assertCurrent instanceof Function)) return fail('knowledge_scope_unavailable');
      await owner.assertCurrent();
      const value = fingerprint(binding);
      for (const [token, scope] of scopes) if (now() >= scope.expiresAt) scopes.delete(token);
      let entry = [...scopes.entries()].find(([, scope]) => scope.fingerprint === value && scope.owner.id === owner.id && scope.expiresAt - now() > 60000);
      if (!entry) {
        if (scopes.size >= 16) return fail('knowledge_request_limit', 429);
        const token = randomBytes(32).toString('base64url');
        entry = [token, { owner, fingerprint: value, requestIdentity: hash(JSON.stringify([binding.baseUrl, binding.model, binding.apiKey])), model: binding.model, expiresAt: now() + 600000, jobs: new Map(), submissions: new Map() }];
        scopes.set(...entry);
      }
      await currentBinding(entry[1]); await start(); await currentBinding(entry[1]);
      return { ...binding, protocol: 'paddleocr', baseUrl: `${origin}${JOBS}`, apiKey: entry[0] };
    },
    close: async () => {
      closed = true; shutdown.abort();
      if (opening) await opening.catch(() => {});
      if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      await Promise.allSettled([...tasks]); scopes.clear();
    },
  };
};
