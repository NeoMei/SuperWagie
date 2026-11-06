import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Model } from '@/lib/opencode/model';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const dom = new Window({ url: 'http://metadata.test' });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, CustomEvent: dom.CustomEvent })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
const idle: Array<() => void> = [];
Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: (callback: () => void) => { idle.push(callback); return idle.length; } });
const payload = (name: string) => ({ vendor: { id: 'vendor', models: { model: { id: 'model', name, limit: { context: 100, output: 10 } } } } });
let metadataReads = 0;
let metadataResponse = async (): Promise<Response> => Response.json(payload('fresh'));
const network = spyOn(globalThis, 'fetch').mockImplementation(async input => {
  const url = input instanceof Request ? input.url : input.toString();
  if (url.includes('models-metadata') || url.includes('models.dev')) { metadataReads++; return metadataResponse(); }
  return Response.json({});
});
const { opencodeClient } = await import('@/lib/opencode/client');
const { useConfigStore } = await import('./useConfigStore');
const { useDirectoryStore } = await import('./useDirectoryStore');
const { useProjectsStore } = await import('./useProjectsStore');
const { refreshStoresForCatalogKind } = await import('./catalogRefresh');
const { refreshAfterOpenCodeRestart } = await import('./useAgentsStore');
const liveModel: Model = {
  id: 'vendor/model', modelID: 'model', providerID: 'vendor', name: 'Live', status: 'active', enabled: true,
  capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 },
  cost: [{ input: 2, output: 3, cache: { read: 0, write: 0 } }], limit: { context: 200, output: 20 },
};
const sdk = spyOn(opencodeClient, 'getProvidersForConfig').mockImplementation(async () => ({
  providers: [{ id: 'vendor', name: 'Vendor', activation: 'enabled', package: 'vendor' }],
  models: [{ ...liveModel }], default: { providerID: 'vendor', id: 'model' },
}));
const health = spyOn(opencodeClient, 'checkHealth').mockResolvedValue(true);
const config = spyOn(opencodeClient, 'getConfig').mockResolvedValue({});
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const load = () => useConfigStore.getState().loadProviders({ directory: '/repo', fresh: true });
const runIdle = async () => { for (const callback of idle.splice(0)) callback(); await flush(); };
const switchTo = (key: string) => switchRuntimeEndpoint({ runtimeKey: key, apiBaseUrl: `http://${key}.test` });
beforeEach(() => {
  idle.length = 0;
  switchTo('metadata-a');
  useProjectsStore.setState({ projects: [{ id: 'repo', path: '/repo' }], activeProjectId: 'repo' });
  useDirectoryStore.setState({ currentDirectory: '/repo' });
  opencodeClient.setDirectory('/repo');
  useConfigStore.getState().activateDirectory('/repo');
  useConfigStore.getState().invalidateModelMetadataCache();
  metadataReads = 0;
  metadataResponse = async () => Response.json(payload('fresh'));
  useConfigStore.setState({ isConnected: true, isInitialized: true });
});
afterAll(async () => {
  network.mockRestore(); sdk.mockRestore(); config.mockRestore(); health.mockRestore();
  await dom.happyDOM.abort();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a runtime round trip retires metadata queued before idle dispatch', async () => {
  await load();
  expect(idle).toHaveLength(1);
  switchTo('metadata-b');
  switchTo('metadata-a');
  await runIdle();
  expect(metadataReads).toBe(0);
  await load();
  await runIdle();
  expect(metadataReads).toBe(1);
  expect(useConfigStore.getState().modelsMetadata.get('vendor/model')?.name).toBe('fresh');
});

test('explicit invalidation retires an old flight without clearing the replacement owner', async () => {
  let finishOld = (_response: Response) => {};
  let finishNew = (_response: Response) => {};
  const old = new Promise<Response>(resolve => { finishOld = resolve; });
  const current = new Promise<Response>(resolve => { finishNew = resolve; });
  metadataResponse = () => metadataReads === 1 ? old : current;
  await load(); await runIdle();
  useConfigStore.getState().invalidateModelMetadataCache();
  await load(); await runIdle();
  expect(metadataReads).toBe(2);
  finishOld(Response.json(payload('old'))); await flush();
  expect(useConfigStore.getState().modelsMetadata.size).toBe(0);
  await load(); await runIdle();
  expect(metadataReads).toBe(2);
  finishNew(Response.json(payload('current'))); await flush();
  expect(useConfigStore.getState().modelsMetadata.get('vendor/model')?.name).toBe('current');
});

test('automatic model/provider refresh retains enrichment while SDK models and custom fallback stay current', async () => {
  const enrichment = new Map([['vendor/model', { id: 'model', providerId: 'vendor', name: 'Catalog' }]]);
  useConfigStore.setState({ modelsMetadata: enrichment });
  for (const kind of ['provider', 'model'] as const) await refreshStoresForCatalogKind(kind);
  await runIdle();
  expect(metadataReads).toBe(0);
  expect(useConfigStore.getState().modelsMetadata).toBe(enrichment);
  expect(useConfigStore.getState().providers[0]?.models[0]?.cost[0]?.input).toBe(2);
  expect(useConfigStore.getState().providers[0]?.models[0]?.capabilities.tools).toBe(true);
  expect(useConfigStore.getState().getModelMetadata('vendor', 'model')?.limit).toEqual({ context: 200, output: 20 });
  useConfigStore.setState({ modelsMetadata: new Map([['other/model', { id: 'model', providerId: 'other' }]]) });
  await refreshStoresForCatalogKind('provider');
  expect(useConfigStore.getState().getModelMetadata('vendor', 'model')?.cost?.input).toBe(2);
  expect(useConfigStore.getState().getModelMetadata('vendor', 'model')?.tool_call).toBe(true);
});

test('explicit provider reload clears retained enrichment and an empty map remains loadable', async () => {
  useConfigStore.setState({ modelsMetadata: new Map([['vendor/model', { id: 'model', providerId: 'vendor', name: 'Old' }]]) });
  await refreshAfterOpenCodeRestart({ scopes: ['providers'], mode: 'active', delayMs: 0 });
  await runIdle();
  expect(metadataReads).toBe(1);
  expect(useConfigStore.getState().modelsMetadata.get('vendor/model')?.name).toBe('fresh');
});
