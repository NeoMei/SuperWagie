import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';
import { discoverProviderModels, modelDiscoveryInternals } from './model-discovery.js';

describe('provider model discovery', () => {
  test('builds the models URL from the configured base path', () => {
    expect(modelDiscoveryInternals.buildModelsUrl('http://localhost:11434/v1/', '/models').href)
      .toBe('http://localhost:11434/v1/models');
    expect(() => modelDiscoveryInternals.buildModelsUrl('file:///tmp/models', '/models')).toThrow('http or https');
    expect(() => modelDiscoveryInternals.buildModelsUrl('https://example.test/v1', 'https://evil.test/models')).toThrow('one slash');
  });

  test('filters transport headers and owns authorization', () => {
    expect(modelDiscoveryInternals.buildHeaders(
      { Host: 'evil.test', 'X-Tenant': '{env:TENANT}', Authorization: 'wrong' },
      'secret',
      { TENANT: 'one' },
    )).toEqual({ Accept: 'application/json', 'X-Tenant': 'one', Authorization: 'Bearer secret' });
  });

  test('discovers, deduplicates, and enriches an exact model match', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'gpt-test', name: 'Provider name', context_window: 64_000 },
      { id: 'gpt-test' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await discoverProviderModels({
      baseURL: 'https://provider.test/v1',
      apiKey: '{env:TEST_KEY}',
      enrich: true,
      metadataProviderID: 'openai',
    }, {
      fetch: fetchMock,
      env: { TEST_KEY: 'secret' },
      getModelsMetadata: async () => ({ metadata: {
        openai: { models: { 'gpt-test': {
          name: 'Catalog name',
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 128_000, output: 16_000 },
        } } },
      } }),
    });

    expect(fetchMock).toHaveBeenCalledWith(new URL('https://provider.test/v1/models'), expect.objectContaining({
      redirect: 'manual',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret' },
    }));
    expect(result.models).toEqual([expect.objectContaining({
      id: 'gpt-test',
      name: 'Provider name',
      limit: { context: 64_000 },
      metadataMatch: 'exact',
      metadata: expect.objectContaining({
        providerID: 'openai',
        limit: { context: 128_000, output: 16_000 },
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      }),
    })]);
  });

  test('keeps discovery successful when models.dev fails', async () => {
    const result = await discoverProviderModels({ baseURL: 'https://provider.test', enrich: true }, {
      fetch: async () => new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 }),
      getModelsMetadata: async () => { throw new Error('offline'); },
    });
    expect(result).toEqual({
      models: [{ id: 'local', name: 'local', metadataMatch: 'unavailable' }],
      enrichment: { requested: true, available: false },
    });
  });

  test('uses a stored key only when the request does not supply one', async () => {
    const requests = [];
    const fetchMock = async (_url, init) => {
      requests.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 });
    };

    await discoverProviderModels({ baseURL: 'https://provider.test', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: 'stored-key',
      storedBaseURL: 'https://provider.test/',
    });
    await discoverProviderModels({ baseURL: 'https://provider.test', apiKey: 'replacement-key', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: 'stored-key',
      storedBaseURL: 'https://provider.test',
    });

    expect(requests).toEqual(['Bearer stored-key', 'Bearer replacement-key']);
  });

  test('resolves environment variables in stored keys', async () => {
    const requests = [];
    const fetchMock = async (_url, init) => {
      requests.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 });
    };

    await discoverProviderModels({ baseURL: 'https://provider.test', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: '{env:STORED_KEY}',
      storedBaseURL: 'https://provider.test',
      env: { STORED_KEY: 'resolved-secret' },
    });

    expect(requests).toEqual(['Bearer resolved-secret']);
  });

  test('never sends the stored key to a base URL other than the saved one', async () => {
    const requests = [];
    const fetchMock = async (_url, init) => {
      requests.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 });
    };

    await discoverProviderModels({ baseURL: 'https://elsewhere.test', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: 'stored-key',
      storedBaseURL: 'https://provider.test',
    });
    await discoverProviderModels({ baseURL: 'https://provider.test/v1', enrich: false }, {
      fetch: fetchMock,
      storedApiKey: 'stored-key',
    });

    expect(requests).toEqual([undefined, undefined]);
  });

  test('offers normalized matches as suggestions instead of applying them', async () => {
    const result = await discoverProviderModels({ baseURL: 'https://provider.test', enrich: true }, {
      fetch: async () => new Response(JSON.stringify({ data: [{ id: 'openai/gpt-test-production' }] }), { status: 200 }),
      getModelsMetadata: async () => ({ metadata: {
        openai: { models: { 'gpt-test': { limit: { context: 64_000 } } } },
        azure: { models: { 'gpt-test': { limit: { context: 32_000 } } } },
      } }),
    });
    expect(result.models[0]).toEqual(expect.objectContaining({
      metadataMatch: 'ambiguous',
      metadataCandidates: [
        expect.objectContaining({ providerID: 'openai', modelID: 'gpt-test' }),
        expect.objectContaining({ providerID: 'azure', modelID: 'gpt-test' }),
      ],
    }));
    expect(result.models[0].metadata).toBeUndefined();
  });

  // vLLM-style `/models` entries name their fields `max_input_tokens`,
  // `input_modalities`, and `supports_tool_call`; the provider's own numbers
  // must survive discovery instead of being dropped for want of the
  // OpenAI-style names.
  test('reads a provider model described with vLLM-style field names', async () => {
    const result = await discoverProviderModels({ baseURL: 'https://provider.test', enrich: false }, {
      fetch: async () => new Response(JSON.stringify({ data: [
        {
          id: 'deepseek-v4.1-flash',
          max_input_tokens: 1_000_000,
          max_output_tokens: 128_000,
          input_modalities: ['text', 'image'],
          supports_tool_call: true,
        },
        { id: 'big-pickle', input_modalities: ['text'], supports_tool_call: false },
      ] }), { status: 200 }),
    });
    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'big-pickle',
        capabilities: { input: ['text'], output: ['text'], tools: false },
      }),
      expect.objectContaining({
        id: 'deepseek-v4.1-flash',
        limit: { context: 1_000_000, output: 128_000 },
        capabilities: { input: ['text', 'image'], output: ['text'], tools: true },
      }),
    ]);
  });
});

// An OpenCode credential read can be unavailable while an environment-keyed
// project provider still answers its catalog over the configured connection.
test('the discovery route uses the requested project configuration without a stored credential', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opencode-model-discovery-'));
  const baseURL = 'https://project-provider.test/v1';
  const fetchCatalog = vi.fn(async () => Response.json({ data: [{ id: 'updated-upstream-model' }] }));
  vi.stubEnv('OPENCHAMBER_TEST_PROVIDER_KEY', 'test-provider-token');
  vi.stubGlobal('fetch', fetchCatalog);
  try {
    await writeFile(path.join(directory, 'opencode.json'), JSON.stringify({
      providers: { 'project-provider': { settings: { baseURL }, env: ['OPENCHAMBER_TEST_PROVIDER_KEY'] } },
    }));
    const { registerOpenCodeRoutes } = await import('./routes.js');
    const app = express();
    app.use(express.json());
    registerOpenCodeRoutes(app, {
      resolveProjectDirectory: async (req) => req.query.directory === directory
        ? { directory }
        : { error: 'Invalid test directory' },
    });
    const modelQuery = (target) => request(app).post('/api/provider/discover-models')
      .query({ directory: target }).send({ providerID: 'project-provider', baseURL, enrich: false });

    const success = await modelQuery(directory);
    expect(success.status).toBe(200);
    expect(success.body.models).toEqual([{ id: 'updated-upstream-model', name: 'updated-upstream-model' }]);
    expect(fetchCatalog).toHaveBeenCalledWith(new URL(baseURL + '/models'), expect.objectContaining({
      headers: { Accept: 'application/json', Authorization: 'Bearer test-provider-token' },
    }));

    expect((await modelQuery(path.join(directory, 'missing'))).status).toBe(400);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true });
  }
});
