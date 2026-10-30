import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

import { createEmbeddedKnowledgeClient, EmbeddedKnowledgeError } from './client.js';

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
