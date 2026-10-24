import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerKnowledgeLibraryRoutes } from './routes.js';
import { ProvisionError } from '../embedded-knowledge/provision.js';

const createRuntime = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    getStatus: async () => ({
      supported: true,
      enabled: true,
      provisioned: true,
      backend: { state: 'running', port: 17_808 },
      error: null,
    }),
    readLibraries: async () => [{ id: 'l1', root: '/tmp/a', slug: 'a-1', enabled: true }],
    previewLibrary: async (root) => {
      calls.push(['previewLibrary', root]);
      return root.startsWith('/') ? { total: 3, indexable: 2, skipped: 1 } : { error: 'path_not_absolute' };
    },
    listImages: async (query) => {
      calls.push(['listImages', query]);
      return { images: [{ id: 'i1', sourceName: 'a.pdf', caption: 'cap', url: 'resource://x' }], total: 1 };
    },
    readImage: async (url) =>
      url === 'resource://x'
        ? { stream: Readable.from([Buffer.from('png')]), contentType: 'image/png' }
        : { error: 'not_found' },
    listWikiPages: async () => {
      calls.push(['listWikiPages']);
      return { enabled: false, pages: [], total: 0 };
    },
    readWikiGraph: async () => {
      calls.push(['readWikiGraph']);
      return { enabled: false, nodes: [], edges: [] };
    },
    retryFailed: async () => {
      calls.push(['retryFailed']);
      return { queued: 2 };
    },
    rescan: async (id) => {
      calls.push(['rescan', id ?? null]);
      return { ok: true };
    },
    addLibrary: async (root) => {
      calls.push(['addLibrary', root]);
      return root.startsWith('/') ? { library: { id: 'l2', root } } : { error: 'path_not_absolute' };
    },
    setLibraryEnabled: async (id, enabled) => {
      calls.push(['setLibraryEnabled', id, enabled]);
      return { library: { id, enabled } };
    },
    removeLibrary: async (id, options) => {
      calls.push(['removeLibrary', id, options]);
      return { ok: true };
    },
    rescan: async (id) => {
      calls.push(['rescan', id ?? null]);
      return { ok: true };
    },
    listDocuments: async (filter) => {
      calls.push(['listDocuments', filter]);
      return { total: 0, documents: [] };
    },
    retryDocument: async (id) => ({ ok: true, id }),
    cleanMissing: async () => ({ removed: 0 }),
    search: async (input) => {
      calls.push(['search', input]);
      return { query: input.query, documents: [], passages: [] };
    },
    readContent: async (id) => (id === 'missing' ? { error: 'not_indexed' } : { documentId: id, content: 'text' }),
    getFile: async () => ({ error: 'not_found' }),
    provision: async (key) => {
      calls.push(['provision', key]);
      return { ok: true };
    },
    reconnect: async () => ({ supported: true }),
    rebuild: async () => ({ ok: true }),
    ...overrides,
  };
};

const appWith = (runtime) => {
  const app = express();
  registerKnowledgeLibraryRoutes(app, { runtime });
  return app;
};

describe('knowledge library routes', () => {
  it('reports status without leaking credentials', async () => {
    const response = await request(appWith(createRuntime())).get('/api/knowledge-library/status').expect(200);
    expect(response.body).toMatchObject({ supported: true, provisioned: true });
    expect(JSON.stringify(response.body)).not.toContain('apiKey');
  });

  it('reads model metadata only for an explicit model projection request', async () => {
    const calls = [];
    const runtime = createRuntime({ getStatus: async (options) => {
      calls.push(options);
      return { supported: true, enabled: true, provisioned: false, backend: { state: 'stopped', port: 17808 }, ...(options.includeModelConfiguration ? { modelConfiguration: { status: 'unavailable', reason: 'backend_unavailable' } } : {}) };
    } });
    const app = appWith(runtime);
    const ordinary = await request(app).get('/api/knowledge-library/status').expect(200);
    const models = await request(app).get('/api/knowledge-library/status?models=1').expect(200);
    expect(ordinary.body.modelConfiguration).toBeUndefined();
    expect(models.body.modelConfiguration).toEqual({ status: 'unavailable', reason: 'backend_unavailable' });
    expect(calls).toEqual([{ includeModelConfiguration: false }, { includeModelConfiguration: true }]);
  });

  it('previews a folder without adding it', async () => {
    const runtime = createRuntime();
    const response = await request(appWith(runtime)).post('/api/knowledge-library/libraries/preview').send({ path: '/tmp/a' }).expect(200);
    expect(response.body).toEqual({ total: 3, indexable: 2, skipped: 1 });
    expect(runtime.calls).toContainEqual(['previewLibrary', '/tmp/a']);
  });

  it('rescans every library on request', async () => {
    const runtime = createRuntime();
    await request(appWith(runtime)).post('/api/knowledge-library/rescan').expect(200);
    expect(runtime.calls).toContainEqual(['rescan', null]);
  });

  it('rejects a relative library path with a specific code', async () => {
    await request(appWith(createRuntime()))
      .post('/api/knowledge-library/libraries')
      .send({ path: 'relative/dir' })
      .expect(400, { error: 'path_not_absolute' });
  });

  it('rejects a library request with no path', async () => {
    await request(appWith(createRuntime()))
      .post('/api/knowledge-library/libraries')
      .send({})
      .expect(400, { error: 'path_required' });
  });

  it('requires a query on search', async () => {
    await request(appWith(createRuntime())).post('/api/knowledge-library/search').send({}).expect(400, { error: 'query_required' });
  });

  it('passes the delete-remote flag through', async () => {
    const runtime = createRuntime();
    await request(appWith(runtime)).delete('/api/knowledge-library/libraries/l1?deleteRemote=true').expect(200);
    expect(runtime.calls).toContainEqual(['removeLibrary', 'l1', { deleteRemote: true }]);
  });

  it('answers 503 when the backend is not provisioned yet', async () => {
    const runtime = createRuntime({
      addLibrary: async () => {
        const error = new Error('The knowledge backend is not ready');
        error.name = 'ProvisionError';
        error.code = 'not_provisioned';
        throw error;
      },
    });
    await request(appWith(runtime))
      .post('/api/knowledge-library/libraries')
      .send({ path: '/tmp/a' })
      .expect(503, { error: 'not_provisioned' });
  });

  it('retries every failed document in one call', async () => {
    const runtime = createRuntime();
    await request(appWith(runtime)).post('/api/knowledge-library/documents/retry-failed').expect(200, { queued: 2 });
    expect(runtime.calls).toContainEqual(['retryFailed']);
  });

  it('lists images and streams their bytes', async () => {
    const runtime = createRuntime();
    const list = await request(appWith(runtime)).get('/api/knowledge-library/images').expect(200);
    expect(list.body.images[0]).toMatchObject({ id: 'i1', sourceName: 'a.pdf' });

    const content = await request(appWith(runtime))
      .get('/api/knowledge-library/images/content?url=resource%3A%2F%2Fx')
      .expect(200);
    expect(content.headers['content-type']).toBe('image/png');
    expect(content.body.toString()).toBe('png');

    await request(appWith(runtime)).get('/api/knowledge-library/images/content?url=resource%3A%2F%2Fmissing').expect(404);
  });

  it('reports a disabled wiki as an empty state', async () => {
    const runtime = createRuntime();
    const pages = await request(appWith(runtime)).get('/api/knowledge-library/wiki/pages').expect(200);
    expect(pages.body).toEqual({ enabled: false, pages: [], total: 0 });
    const graph = await request(appWith(runtime)).get('/api/knowledge-library/wiki/graph').expect(200);
    expect(graph.body).toEqual({ enabled: false, nodes: [], edges: [] });
  });

  it('maps a document without an index to 409', async () => {
    await request(appWith(createRuntime())).get('/api/knowledge-library/documents/missing/content').expect(409, { error: 'not_indexed' });
  });

  it('maps an unavailable backend to 503', async () => {
    const runtime = createRuntime({ search: async () => ({ error: 'backend_unavailable' }) });
    await request(appWith(runtime)).post('/api/knowledge-library/search').send({ query: 'x' }).expect(503, { error: 'backend_unavailable' });
  });

  it.each(['model_configuration_knowledge_restart_required', 'backend_error'])(
    'preserves the knowledge synchronization error %s as a 503 response', async (code) => {
      const runtime = createRuntime({ search: async () => { throw new ProvisionError(code, 'Private backend detail'); } });
      await request(appWith(runtime)).post('/api/knowledge-library/search').send({ query: 'x' }).expect(503, { error: code });
    },
  );

  it('validates the provisioning payload', async () => {
    await request(appWith(createRuntime())).post('/api/knowledge-library/provision').send({}).expect(400, { error: 'model_key_required' });
  });
});
