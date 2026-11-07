import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyModelBootstrap, discoverModelBootstrap, previewModelBootstrap } from './modelConfigurationBootstrap';
import { modelConfigurationSchema } from './modelConfiguration';
// @ts-expect-error JavaScript server module has no TypeScript declaration.
import { createModelBootstrapRuntime } from '../../../web/server/lib/model-configuration/bootstrap.js';
// @ts-expect-error JavaScript server module has no TypeScript declaration.
import { createModelConfigurationRuntime } from '../../../web/server/lib/model-configuration/runtime.js';

const directories: string[] = [];
let restoreFetch: (() => void) | undefined;
afterEach(async () => {
  restoreFetch?.(); restoreFetch = undefined;
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const serveDiscovery = async (catalog: Array<{ id: string; operations?: string[]; dimensions?: number | string | null; parameters?: { dimensions: number } }>) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-client-contract-'));
  directories.push(dataDir);
  const modelRuntime = createModelConfigurationRuntime({ dataDir });
  const runtime = createModelBootstrapRuntime({
    dataDir, modelRuntime,
    platformAccount: { accountId: 'fixture-account', instanceId: 'fixture-instance' },
    uniHubClient: { discover: async () => ({ origin_product_id: 'superwagie', account_id: 'fixture-account', instance_id: 'fixture-instance', data: catalog }) },
  });
  const discovery = await runtime.discover({ source: 'session' });
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(discovery));
  restoreFetch = () => fetch.mockRestore();
  return { discovery, fetch, runtime, modelRuntime };
};

test('parses the server discovery catalog with absent, explicit and nested embedding dimensions', async () => {
  await serveDiscovery([{ id: 'chat' }, { id: 'embedding', dimensions: 1024 },
    { id: 'nested', parameters: { dimensions: 2048 } }, { id: 'minimum', dimensions: 1 }, { id: 'maximum', dimensions: 65536 }]);
  const discovery = await discoverModelBootstrap({ source: 'session' });
  expect(discovery.models.map((model) => model.dimensions)).toEqual([null, 1024, 2048, 1, 65536]);
  expect(discovery.catalog?.map((model) => model.dimensions)).toEqual([null, 1024, 2048, 1, 65536]);
});

for (const dimensions of [0, -1, 1.5, 65537, '1024']) {
  test(`rejects invalid discovery dimensions ${JSON.stringify(dimensions)}`, async () => {
    await serveDiscovery([{ id: 'invalid', dimensions }]);
    await expect(discoverModelBootstrap({ source: 'session' })).rejects.toMatchObject({ code: 'bad_response' });
  });
}

test('keeps strict model parsing while accepting older responses without dimensions', async () => {
  const fixture = await serveDiscovery([{ id: 'chat' }]);
  fixture.fetch.mockResolvedValue(Response.json({ ...fixture.discovery, models: [{ id: 'legacy' }] }));
  expect((await discoverModelBootstrap({ source: 'session' })).models[0].id).toBe('legacy');
  fixture.fetch.mockResolvedValue(Response.json({ ...fixture.discovery, models: [{ id: 'chat', unexpected: true }] }));
  await expect(discoverModelBootstrap({ source: 'session' })).rejects.toMatchObject({ code: 'bad_response' });
});

test('parses the server preview for the 24-model catalog and preserves unavailable purposes', async () => {
  // Public model IDs and operations reproduce the November 5 acceptance preview.
  const chatModels = [
    'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo',
    'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air', 'deepseek-v4-pro',
    'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'DeepSeek-V4-Pro-A',
    'DeepSeek-V4-Flash-A', 'Doubao-Seed-2.0-Pro-A', 'MiniMax-M3-A',
    'Qwen3.7-Max-A', 'kimi-k2.7-code', 'Kimi-K2.6-A', 'k3', 'GLM-5.2-A',
  ];
  const fixture = await serveDiscovery([
    ...chatModels.map((id) => ({ id, operations: ['chat'] })),
    { id: 'text-embedding-v4', operations: ['embedding'], dimensions: 1024 },
    { id: 'qwen3-rerank', operations: ['rerank'] },
  ]);
  const discovery = await discoverModelBootstrap({ source: 'session' });
  expect(discovery.models).toHaveLength(24);
  expect(discovery.catalog).toEqual(discovery.models);
  const configuration = modelConfigurationSchema.parse(await fixture.modelRuntime.getPublicConfiguration());
  for (const id of ['agent', 'auxiliary']) {
    expect(configuration.purposes.find((purpose) => purpose.id === id)).toMatchObject({ id, status: 'native' });
  }
  const input = { discoveryId: discovery.discoveryId, revision: configuration.revision, mode: 'fill-missing' as const };
  const serverPreview = await fixture.runtime.preview(input);
  fixture.fetch.mockResolvedValue(Response.json(serverPreview, { status: 200 }));
  const preview = await previewModelBootstrap(input);
  expect(preview).toMatchObject({
    operationId: serverPreview.operationId, discoveryId: discovery.discoveryId,
    revision: 0, mode: 'fill-missing', replace: [], preserve: [],
  });
  expect(preview.add.map(({ purpose, model, capabilities, cost, parameters }) => ({ purpose, model, capabilities, cost, parameters }))).toEqual([
    { purpose: 'embedding', model: 'text-embedding-v4', capabilities: ['embedding'], cost: null, parameters: { dimensions: 1024 } },
    { purpose: 'rerank', model: 'qwen3-rerank', capabilities: ['rerank'], cost: null, parameters: {} },
  ]);
  expect(preview.unavailable).toEqual(['ocr', 'vision', 'stt-short', 'stt-realtime', 'tts', 'image-generation', 'routing']
    .map((purpose) => ({ purpose, reason: 'no_supported_model' })));
  expect(preview.items.map(({ purpose, action }) => ({ purpose, action }))).toEqual([
    ...['embedding', 'rerank'].map((purpose) => ({ purpose, action: 'add' })),
    ...preview.unavailable.map(({ purpose }) => ({ purpose, action: 'unavailable' })),
  ]);
  // The server's numeric fallback must retain unknown per-model prices.
  expect(serverPreview.items[0]).toMatchObject({ purpose: 'embedding', estimatedCost: 0 });
  expect(serverPreview.items[1]).toMatchObject({ purpose: 'rerank', estimatedCost: 0 });
  expect(preview.costs).toEqual({ estimated: 0, expensivePurposes: [] });
  for (const item of preview.items) {
    if (item.action === 'add') expect(item.estimatedCost).toBeUndefined();
    if (item.action === 'unavailable') expect(item).toMatchObject({ modelId: null, reason: 'no_supported_model' });
  }
  expect((await fixture.modelRuntime.getPublicConfiguration()).bindings).toEqual([]);
});

test('parses an existing routing binding as preserved and applies no replacement', async () => {
  const fixture = await serveDiscovery([{ id: 'deepseek-v4-flash', operations: ['chat'] }]);
  let configuration = await fixture.modelRuntime.saveConnection({ revision: 0, connection: { name: 'Existing Jev', providerId: 'jev', protocol: 'jev', baseUrl: 'https://routing.example.test/systemone', apiKey: 'fixture-jev-key' } });
  configuration = await fixture.modelRuntime.saveBinding('routing', { revision: configuration.revision, binding: { connectionId: configuration.connections[0].id, model: 'existing-jev', parameters: {} } });
  const input = { discoveryId: fixture.discovery.discoveryId, revision: configuration.revision, mode: 'replace-managed' as const };
  const serverPreview = await fixture.runtime.preview({ ...input, purposes: ['routing'] });
  fixture.fetch.mockResolvedValue(Response.json(serverPreview));
  const preview = await previewModelBootstrap(input);
  expect(preview).toMatchObject({ add: [], replace: [], unavailable: [] });
  expect(preview.items).toHaveLength(1);
  expect(preview.items[0]).toMatchObject({ purpose: 'routing', action: 'preserve', modelId: 'existing-jev', currentModel: 'existing-jev', recommendedModel: undefined });
  const applyInput = { ...input, operationId: preview.operationId };
  fixture.fetch.mockResolvedValue(Response.json(await fixture.runtime.apply(applyInput)));
  expect(await applyModelBootstrap(applyInput)).toEqual(modelConfigurationSchema.parse(configuration));
  expect(await fixture.modelRuntime.getPublicConfiguration()).toEqual(configuration);
});
