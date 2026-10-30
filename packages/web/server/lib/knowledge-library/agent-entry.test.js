import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { createEmbeddedKnowledgeClient } from '../embedded-knowledge/client.js';
import { createAgentToolRuntime } from '../agent-tool/runtime.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { createKnowledgeLibraryStore } from './store.js';
import { createIngestQueue } from './ingest.js';
import { createSearch } from './search.js';

it('indexes long Chinese text and returns only selected-library passages to the native agent tool', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-library-agent-'));
  try {
    const content = '收益法以预期收益为基础，结合折现率评估资产价值。\n'.repeat(80);
    const filePath = path.join(root, '收益法说明.txt');
    await fs.writeFile(filePath, content);
    const store = createKnowledgeLibraryStore({ dataDir: root });
    await store.writeLibraries([{ id: 'l1', name: '评估资料', slug: 'valuation', knowledgeBaseId: 'kb1' }]);
    await store.writeDocuments({
      d1: { id: 'd1', libraryId: 'l1', absPath: filePath, relPath: '收益法说明.txt', size: Buffer.byteLength(content), state: 'queued' },
      d2: { id: 'd2', libraryId: 'l2', absPath: '/other/保密.txt', relPath: '保密.txt', state: 'ready', knowledgeId: 'k2' },
    });
    let registered = false;
    let searches = 0;
    // The complete backend transport is local and synthetic. No fetch or model
    // implementation is reachable; parsing/ranking quality is not under test.
    const client = createEmbeddedKnowledgeClient({
      baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-key', tenantId: 1,
      fetchImpl: async (url, options) => {
        expect(options.headers['X-API-Key']).toBe('fixture-key');
        const route = new URL(url).pathname;
        if (route === '/api/v1/knowledge-bases/kb1/knowledge/ref') {
          const input = JSON.parse(options.body);
          expect(input.path).toBe(filePath);
          expect(input.title).toBe('收益法说明.txt');
          expect(input.metadata.sw_document_id).toBe('d1');
          expect(await fs.readFile(input.path, 'utf8')).toBe(content);
          registered = true;
          return Response.json({ data: { id: 'k1', parse_status: 'pending' } });
        }
        if (route === '/api/v1/knowledge/k1') {
          expect(registered).toBe(true);
          return Response.json({ data: { id: 'k1', parse_status: 'completed', pending_subtasks_count: 0 } });
        }
        if (route === '/api/v1/knowledge-bases/kb1/hybrid-search') {
          searches++;
          expect(JSON.parse(options.body)).toMatchObject({ query_text: '预期收益如何折现？', knowledge_ids: ['k1'] });
          return Response.json({ data: [
            { knowledge_id: 'k2', content: '其他资料库的保密信息', score: 1 },
            { knowledge_id: 'k1', content, score: 0.9, start_at: 0, end_at: content.length },
          ] });
        }
        throw new Error(`Unexpected backend request: ${route}`);
      },
    });
    const ingest = createIngestQueue({ client, store, getLibraries: () => store.readLibraries() });
    await expect(ingest.processOnce()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect((await store.readDocuments()).d1).toMatchObject({ state: 'ready', knowledgeId: 'k1' });
    const search = createSearch({ client, store, getKnowledgeBaseId: () => 'kb1' });
    let enabled = true;
    const control = createOpenChamberControlService({
      knowledgeLibraryRuntime: { isReady: () => true, readLibraries: () => store.readLibraries(), search: (input) => search.search(input) },
      isLibraryToolEnabled: () => enabled,
    });
    const agent = createAgentToolRuntime({ crypto, fsPromises: fs, path, instanceDir: root, getActivePort: () => 1, executeAction: (...args) => control.execute(...args) });
    const request = { tool: 'openchamber_library', sessionID: 'ses_main', input: { action: 'library.search', query: '预期收益如何折现？', library: '评估资料', limit: 1 } };
    const result = await agent.execute(request);
    expect(result.ok).toBe(true);
    expect(result.data.passages).toEqual([{
      path: filePath, title: '收益法说明.txt', content: content.slice(0, 600) + '…', startAt: 0, endAt: content.length,
    }]);
    expect(JSON.stringify(result)).not.toContain('保密');
    enabled = false;
    await expect(agent.execute(request)).resolves.toMatchObject({ ok: false });
    expect(searches).toBe(1);
    await expect(agent.execute({ ...request, input: { action: 'library.reparse' } })).resolves.toMatchObject({ ok: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
