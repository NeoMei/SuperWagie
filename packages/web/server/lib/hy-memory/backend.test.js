import { describe, expect, test } from 'bun:test';
import { createEmbeddedKnowledgeClient } from '../embedded-knowledge/client.js';

describe('private memory index transport', () => {
  test('uses the existing authenticated knowledge-base transport and rejects unknown actions', async () => {
    const calls = [];
    const client = createEmbeddedKnowledgeClient({ baseUrl: 'http://127.0.0.1:17808', apiKey: 'fixture-key', tenantId: 7,
      fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ success: true, data: { revision: 3, records: [] } }), { status: 200 }); } });
    expect(await client.memoryIndex({ knowledgeBaseId: 'kb /a', action: 'state/read', input: { namespace: 'project-a' } })).toEqual({ revision: 3, records: [] });
    expect(calls[0].url).toBe('http://127.0.0.1:17808/api/v1/knowledge-bases/kb%20%2Fa/memory-index/state/read');
    expect(calls[0].options.headers['X-API-Key']).toBe('fixture-key');
    await expect(client.memoryIndex({ knowledgeBaseId: 'kb', action: '../models', input: {} })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
