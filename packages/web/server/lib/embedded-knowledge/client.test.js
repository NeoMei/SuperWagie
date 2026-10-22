import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
