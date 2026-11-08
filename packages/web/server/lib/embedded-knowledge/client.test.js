import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

import { createEmbeddedKnowledgeClient, EmbeddedKnowledgeError } from './client.js';
import { createKnowledgeModelBindings } from './model-bindings.js';

let server;
let baseUrl;
let seen;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/api/v1/knowledge/missing') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (req.url === '/api/v1/auth/login') {
        res.end(JSON.stringify({ success: true, token: 'session-token', user: { id: 'u1' } }));
        return;
      }
      if (req.url.startsWith('/api/v1/knowledge-bases/kb1/knowledge?')) {
        res.end(JSON.stringify({ data: [{ id: 'k1' }], total: 1, success: true }));
        return;
      }
      res.end(JSON.stringify({ data: [], success: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('embedded knowledge client', () => {
  it('uses the API-key headers and tenant id', async () => {
    seen = [];
    const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: 'k', tenantId: 7 });
    await client.listKnowledge({ knowledgeBaseId: 'kb1' });
    expect(seen.at(-1).headers['x-api-key']).toBe('k');
    expect(seen.at(-1).headers['x-tenant-id']).toBe('7');
    expect(seen.at(-1).headers.authorization).toBeUndefined();
  });

  it('prefers the session token over the API key', async () => {
    seen = [];
    const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: 'k', sessionToken: 's' });
    await client.listModels();
    expect(seen.at(-1).headers.authorization).toBe('Bearer s');
    expect(seen.at(-1).headers['x-api-key']).toBeUndefined();
  });

  it('returns the login token', async () => {
    const client = createEmbeddedKnowledgeClient({ baseUrl });
    await expect(client.login('a@b.c', 'pw')).resolves.toMatchObject({ token: 'session-token' });
  });

  it('sends the signed managed reference only to the owned backend route', async () => {
    seen = [];
    const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: 'k', tenantId: 7 });
    await client.registerManagedReference({ knowledgeBaseId: 'kb1', path: '/tmp/approved.txt', capability: 'signed-capability', proof: 'signed-request-proof' });
    const call = seen.at(-1);
    expect(call.url).toBe('/api/v1/knowledge-bases/kb1/knowledge/managed-ref');
    expect(call.method).toBe('POST');
    expect(call.headers['x-api-key']).toBe('k');
    expect(call.headers['x-weknora-managed-proof']).toBe('signed-request-proof');
    expect(JSON.parse(call.body)).toEqual({ path: '/tmp/approved.txt', capability: 'signed-capability' });
  });

  it('maps 404 to a not_found error', async () => {
    const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: 'k' });
    await expect(client.getKnowledge('missing')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('sends the multipart upload with path and metadata fields', async () => {
    seen = [];
    const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: 'k' });
    await client.uploadFile({
      knowledgeBaseId: 'kb1',
      fileName: 'lib/a.md',
      metadata: { sw_document_id: 'd1' },
      bytes: Buffer.from('hello'),
    });
    const call = seen.at(-1);
    expect(call.url).toBe('/api/v1/knowledge-bases/kb1/knowledge/file');
    expect(call.headers['content-type']).toContain('multipart/form-data');
    expect(call.body).toContain('name="fileName"');
    expect(call.body).toContain('lib/a.md');
    expect(call.body).toContain('"sw_document_id":"d1"');
    expect(call.body).toContain('hello');
  });

  it('times out instead of hanging', async () => {
    const slow = http.createServer(() => {});
    await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const client = createEmbeddedKnowledgeClient({
      baseUrl: `http://127.0.0.1:${slow.address().port}`,
      timeoutMs: 50,
    });
    await expect(client.health()).rejects.toMatchObject({ code: 'timeout' });
    slow.close();
    slow.closeAllConnections?.();
  });

  it('reports an unreachable backend as unavailable', async () => {
    const client = createEmbeddedKnowledgeClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 200 });
    const error = await client.health().catch((caught) => caught);
    expect(error).toBeInstanceOf(EmbeddedKnowledgeError);
    expect(error.code).toBe('unavailable');
  });
});

it('preserves the exact signed body bytes on real loopback HTTP', async () => {
  seen = [];
  const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: 'local-only', tenantId: 7 });
  const body = '{"capability":"fixture","signedWhitespace": "exact"}';
  const response = await client.managedRequest({ path: '/api/v1/knowledge-bases/kb1/knowledge/managed-status', body, proof: 'signed-proof' });
  expect(seen.at(-1).body).toBe(body);
  expect(Buffer.isBuffer(response)).toBe(true);
  expect(seen.at(-1).headers['x-weknora-managed-proof']).toBe('signed-proof');
  await expect(client.managedRequest({ path: '/api/v1/models', body, proof: 'signed-proof' })).rejects.toMatchObject({ code: 'bad_request' });
});

it('gives only signed managed search its bounded dispatch timeout while metadata retains the default', async () => {
  const deadlines = []; const timeout = AbortSignal.timeout.bind(AbortSignal);
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => { deadlines.push(milliseconds); return timeout(milliseconds); });
  try {
    const client = createEmbeddedKnowledgeClient({ baseUrl, timeoutMs: 50 });
    await client.health();
    const body = JSON.stringify({ capability: 'signed-search' });
    await client.managedRequest({ path: '/api/v1/knowledge-bases/kb1/knowledge/managed-status', body, proof: 'signed-proof' });
    await client.managedRequest({ path: '/api/v1/knowledge-bases/kb1/managed-hybrid-search', body, proof: 'signed-proof' });
    expect(deadlines).toEqual([50, 50, 120_000]);
  } finally { spy.mockRestore(); }
});
it('reports a timed-out signed response body as a typed timeout without repeating the request', async () => {
  let requests = 0;
  const slow = http.createServer((_req, res) => { requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  try {
    const client = createEmbeddedKnowledgeClient({ baseUrl: `http://127.0.0.1:${slow.address().port}`, timeoutMs: 50 });
    await expect(client.managedRequest({ path: '/api/v1/knowledge-bases/kb1/knowledge/managed-status', body: '{"capability":"signed"}', proof: 'proof' })).rejects.toMatchObject({ code: 'timeout' });
    expect(requests).toBe(1);
  } finally { slow.closeAllConnections(); await new Promise((resolve) => slow.close(resolve)); }
});


describe('model updates against the credentials subresource contract', () => {
  let backend;
  let endpoint;
  let stored;
  let calls;
  let metadataStatus;
  let credentialStatus;

  const modelResponse = () => {
    const parameters = { ...stored.parameters };
    delete parameters.api_key;
    delete parameters.app_secret;
    return { ...stored, parameters };
  };

  beforeEach(() => {
    stored = { id: 'model/1', name: 'previous-model', type: 'Rerank', source: 'remote', parameters: { provider: 'generic', base_url: 'https://provider.example/v1', api_key: 'old-key', app_secret: 'old-secret', extra_config: { retained: 'value' } } };
    calls = [];
    metadataStatus = 200;
    credentialStatus = 200;
  });

  beforeAll(async () => {
    backend = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        calls.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/auth/login') {
          res.end(JSON.stringify({ success: true, token: 'session-token', user: { id: 'u1' } }));
          return;
        }
        if (req.method === 'GET' && req.url === '/api/v1/models') {
          res.end(JSON.stringify({ success: true, data: [modelResponse()] }));
          return;
        }
        if (req.method === 'GET' && req.url === '/api/v1/knowledge-bases/kb1') {
          res.end(JSON.stringify({ success: true, data: { id: 'kb1', name: 'Library' } }));
          return;
        }
        if (req.method === 'PUT' && req.url === '/api/v1/models/model%2F1') {
          res.statusCode = metadataStatus;
          if (metadataStatus === 200) {
            // The pinned backend ignores credentials in the metadata body.
            stored = { ...stored, ...body, parameters: { ...body.parameters, api_key: stored.parameters.api_key, app_secret: stored.parameters.app_secret } };
          }
          res.end(JSON.stringify({ success: metadataStatus === 200, data: modelResponse() }));
          return;
        }
        if (req.method === 'PUT' && req.url === '/api/v1/models/model%2F1/credentials') {
          res.statusCode = credentialStatus;
          if (credentialStatus !== 200) {
            res.end(JSON.stringify({ error: { code: 'credential_write_failed', message: 'private backend detail' } }));
            return;
          }
          for (const field of ['api_key', 'app_secret']) {
            if (body[field]) stored.parameters[field] = body[field];
          }
          res.end(JSON.stringify({ success: true, data: { fields: { api_key: { configured: Boolean(stored.parameters.api_key) }, app_secret: { configured: Boolean(stored.parameters.app_secret) } } } }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${backend.address().port}`;
  });

  afterAll(() => new Promise((resolve) => backend.close(resolve)));

  it('rotates credentials on the existing record and keeps secrets out of metadata', async () => {
    const client = createEmbeddedKnowledgeClient({ baseUrl: endpoint, sessionToken: 'session', apiKey: 'unused' });
    const update = { name: 'selected-model', type: 'Rerank', parameters: { ...stored.parameters, api_key: 'selected-key', app_secret: 'selected-secret' } };
    const original = structuredClone(update);
    const result = await client.updateModel('model/1', update);
    expect(stored).toMatchObject({ id: 'model/1', name: 'selected-model', parameters: { api_key: 'selected-key', app_secret: 'selected-secret', extra_config: { retained: 'value' } } });
    expect(calls.map(({ url }) => url)).toEqual(['/api/v1/models/model%2F1', '/api/v1/models/model%2F1/credentials']);
    expect(calls[0].body.parameters).toEqual({ provider: 'generic', base_url: 'https://provider.example/v1', extra_config: { retained: 'value' } });
    expect(calls[1].body).toEqual({ api_key: 'selected-key', app_secret: 'selected-secret' });
    for (const call of calls) {
      expect(call.headers.authorization).toBe('Bearer session');
      expect(call.headers['x-api-key']).toBeUndefined();
    }
    expect(result).toEqual(modelResponse());
    expect(update).toEqual(original);
  });

  it.each([undefined, {}, { api_key: '', app_secret: '' }, { api_key: null, app_secret: null }])('preserves existing credentials for absent or empty parameters %j', async (parameters) => {
    const client = createEmbeddedKnowledgeClient({ baseUrl: endpoint, apiKey: 'tenant-key', tenantId: 7 });
    await client.updateModel('model/1', { name: 'renamed', parameters });
    expect(stored.parameters).toMatchObject({ api_key: 'old-key', app_secret: 'old-secret' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.parameters ?? {}).not.toHaveProperty('api_key');
    expect(calls[0].body.parameters ?? {}).not.toHaveProperty('app_secret');
    expect(calls[0].headers['x-api-key']).toBe('tenant-key');
    expect(calls[0].headers['x-tenant-id']).toBe('7');
  });

  it('leaves an omitted credential unchanged when another credential rotates', async () => {
    const client = createEmbeddedKnowledgeClient({ baseUrl: endpoint });
    await client.updateModel('model/1', { parameters: { api_key: 'selected-key', app_secret: '' } });
    expect(stored.parameters).toMatchObject({ api_key: 'selected-key', app_secret: 'old-secret' });
    expect(calls[1].body).toEqual({ api_key: 'selected-key' });
  });

  it('does not rotate credentials after a failed metadata update', async () => {
    metadataStatus = 409;
    const client = createEmbeddedKnowledgeClient({ baseUrl: endpoint });
    await expect(client.updateModel('model/1', { parameters: { api_key: 'selected-key' } })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(stored.parameters.api_key).toBe('old-key');
    expect(calls).toHaveLength(1);
  });

  it('rejects partial synchronization and retries the same binding after credential failure', async () => {
    credentialStatus = 500;
    const runtime = createKnowledgeModelBindings({
      createClient: (options) => createEmbeddedKnowledgeClient({ baseUrl: endpoint, ...options }),
      getState: () => ({ email: 'local@example.invalid', password: 'fixture-password', knowledgeBaseId: 'kb1' }),
      readDocuments: async () => ({}),
      resolveModelBinding: async (purpose) => purpose === 'rerank' ? { purpose, protocol: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'selected-model', apiKey: 'selected-key', parameters: {} } : null,
    });
    await expect(runtime.syncModelBindings()).rejects.toMatchObject({ name: 'EmbeddedKnowledgeError', code: 'credential_write_failed', status: 500, message: 'The knowledge backend failed to handle the request' });
    expect(stored).toMatchObject({ name: 'selected-model', parameters: { api_key: 'old-key' } });
    credentialStatus = 200;
    await runtime.syncModelBindings();
    expect(stored.parameters.api_key).toBe('selected-key');
    expect(calls.filter(({ url }) => url.endsWith('/credentials'))).toHaveLength(2);
    const completedCalls = calls.length;
    await runtime.syncModelBindings();
    expect(calls).toHaveLength(completedCalls);
  });
});
