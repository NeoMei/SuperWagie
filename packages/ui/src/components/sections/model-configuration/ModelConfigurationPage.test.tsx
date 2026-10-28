import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { KnowledgeLibraryModelConfiguration } from '@/lib/knowledgeLibrary';
import { ModelConfigurationError, type ModelConfiguration, type ModelConnectionInput, type ModelBindingInput, type ModelConnectionTestResult, type ModelConnectionTestInput } from '@/lib/modelConfiguration';
import { useModelConfigurationTabStore, prepareModelConfigurationTarget } from './modelConfigurationTabs';
import { visibleModelPresets } from './modelConfigurationView';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  Element: browser.Element, Node: browser.Node, Event: browser.Event,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = String(input instanceof Request ? input.url : input);
  if (path.includes('/api/config/settings')) return Response.json({});
  if (path.endsWith('/fs/home')) return Response.json({ home: '/fixture' });
  if (path.endsWith('/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
  return Response.json([]);
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { reportSettingsSaveState, getSettingsSaveState } = await import('@/lib/persistence');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ModelConfigurationPage } = await import('./ModelConfigurationPage');
afterAll(async () => {
  fetchFixture.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const configuration = (): ModelConfiguration => ({
  version: 1, revision: 1, enterpriseMode: false, credentialSources: { status: 'available', sources: [] },
  purposes: [{ id: 'embedding', labelKey: 'modelConfiguration.purpose.embedding', status: 'available', consumerIds: ['knowledge-library'], required: true, probeProtocols: ['openai-compatible'] }],
  presets: [
    { id: 'china', providerId: 'example', name: 'China embedding', origin: 'china', purposes: ['embedding'], protocol: 'openai-compatible', model: 'embedding-current', baseUrl: 'https://models.example/v1', docsUrl: 'https://models.example/docs', keyUrl: 'https://models.example/keys', parameters: { dimensions: 1024 }, status: 'compatible', notes: [], noteCodes: [], reviewedAt: '2026-10-23' },
    { id: 'international', providerId: 'international', name: 'International embedding', origin: 'international', purposes: ['embedding'], protocol: 'openai-compatible', model: 'embedding-other', baseUrl: 'https://other.example/v1', docsUrl: 'https://other.example/docs', keyUrl: 'https://other.example/keys', parameters: {}, status: 'compatible', notes: [], noteCodes: [], reviewedAt: '2026-10-23' },
  ],
  connections: [{ id: 'saved', name: 'My connection', providerId: 'example', protocol: 'openai-compatible', baseUrl: 'https://models.example/v1', hasApiKey: true }],
  bindings: [{ purpose: 'embedding', connectionId: 'saved', presetId: 'china', model: 'embedding-current', parameters: { dimensions: 1024 }, verification: { status: 'untested' } }],
});

describe('ModelConfigurationPage', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    useI18nStore.getState().setLocale('en');
    useModelConfigurationTabStore.setState({ tab: 'purposes', purpose: 'embedding' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    useModelConfigurationTabStore.setState({ tab: 'purposes', purpose: 'agent' });
    host.remove();
  });

  function clientFor(snapshot: ModelConfiguration) {
    return {
      read: async () => snapshot,
      readKnowledgeModels: async (): Promise<KnowledgeLibraryModelConfiguration> => ({ status: 'unavailable', reason: 'backend_unavailable' }),
      saveConnection: async (_revision: number, _connection: ModelConnectionInput) => snapshot,
      removeConnection: async (_id: string, _revision: number) => snapshot,
      saveBinding: async (_purpose: ModelConfiguration['purposes'][number]['id'], _revision: number, _binding: ModelBindingInput | null) => snapshot,
      testBinding: async (_purpose: ModelConfiguration['purposes'][number]['id'], _revision: number) => snapshot,
      testConnection: async (_id: string, _revision: number, _input: ModelConnectionTestInput): Promise<ModelConnectionTestResult> => ({ status: 'verified', testedAt: '2026-10-23T00:00:00Z' }),
    };
  }
  async function render(client: NonNullable<React.ComponentProps<typeof ModelConfigurationPage>['client']>) {
    await act(async () => root.render(<I18nProvider><ModelConfigurationPage client={client} /></I18nProvider>));
  }
  function button(label: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button')).find((candidate) => candidate.textContent === label && !candidate.closest('[hidden]'));
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }
  async function type(label: string, value: string) {
    const field = Array.from(host.querySelectorAll<HTMLInputElement>(`input[aria-label="${label}"]`)).find((candidate) => !candidate.closest('[hidden]'));
    if (!field) throw new Error(`Missing field: ${label}`);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Missing input setter');
      setter.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  test('origin filters retain the saved preset and never change its model or dimensions', async () => {
    const snapshot = configuration();
    expect(visibleModelPresets(snapshot.presets, 'embedding', 'international', 'china').map((preset) => preset.id)).toEqual(['china', 'international']);
    await render(clientFor(snapshot));
    await act(async () => button('International models').click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe('embedding-current');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Dimensions"]')?.value).toBe('1024');
    expect(button('Save changes').disabled).toBe(true);
    expect(button('Test saved binding').disabled).toBe(false);
  });

  test('a saved unchanged binding explains why Save is disabled', async () => {
    await render(clientFor(configuration()));
    expect(button('Save changes').disabled).toBe(true);
    expect(host.textContent).toContain('This binding is saved with no unsaved changes. Edit a field to enable Save.');

    await type('Model ID', 'embedding-proposed');
    expect(button('Save changes').disabled).toBe(false);
    expect(host.textContent).not.toContain('no unsaved changes');
  });

  test('test updates verified status only from the server response', async () => {
    const snapshot = configuration();
    const client = clientFor(snapshot);
    let probes = 0;
    client.testBinding = async () => {
      probes += 1;
      return { ...snapshot, revision: 2, bindings: snapshot.bindings.map((binding) => ({ ...binding, verification: { status: 'verified', testedAt: '2026-10-23T00:00:00Z' } })) };
    };
    await render(client);
    expect(host.textContent).toContain('Saved, not tested');
    await act(async () => button('Test saved binding').click());
    expect(probes).toBe(1);
    expect(host.textContent).toContain('Verified for this purpose');
  });

  test('an unreadable configuration cannot create an empty writable state', async () => {
    const client = clientFor(configuration());
    client.read = async () => { throw new ModelConfigurationError('unreadable'); };
    await render(client);
    expect(host.textContent).toContain('Could not load model configuration');
    expect(host.querySelector('input[aria-label="Model ID"]')).toBeNull();
    expect(host.textContent).not.toContain('Not configured');
  });

  test('credential edits never read back or resubmit a stored key, and clear a replacement after save', async () => {
    const snapshot = configuration();
    const client = clientFor(snapshot);
    const writes: ModelConnectionInput[] = [];
    client.saveConnection = async (_revision, connection) => { writes.push(connection); return { ...snapshot, revision: snapshot.revision + writes.length }; };
    useModelConfigurationTabStore.setState({ tab: 'connections' });
    await render(client);
    // Select the existing connection through its real select control.
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label="Connection"]')).find((candidate) => !candidate.closest('[hidden]'));
    if (!trigger) throw new Error('Missing connection picker');
    await act(async () => trigger.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((candidate) => candidate.textContent?.includes('My connection'));
    if (!option) throw new Error('Missing stored connection');
    await act(async () => option.click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="API key"]')?.value).toBe('');
    await type('Connection name', 'Renamed connection');
    await act(async () => button('Save changes').click());
    expect(writes).toHaveLength(1);
    expect(writes[0]?.apiKey).toBeUndefined();
    await type('API key', 'replacement-fixture-key');
    await act(async () => button('Save changes').click());
    expect(writes[1]?.apiKey).toBe('replacement-fixture-key');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="API key"]')?.value).toBe('');
    expect(host.textContent).not.toContain('replacement-fixture-key');
  });

  test('a failed binding write retains the draft and its last saved verification', async () => {
    const snapshot = configuration();
    const client = clientFor(snapshot);
    client.saveBinding = async () => { throw new ModelConfigurationError('model_configuration_revision_conflict'); };
    await render(client);
    await type('Model ID', 'embedding-proposed');
    expect(button('Test saved binding').disabled).toBe(true);
    await act(async () => button('Save changes').click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe('embedding-proposed');
    expect(host.textContent).toContain('Configuration changed on another client');
    expect(host.textContent).toContain('Saved, not tested');
  });

  test('a planned purpose offers recommendations without a binding action', async () => {
    const snapshot = configuration();
    snapshot.purposes = [{ id: 'video-generation', labelKey: 'modelConfiguration.purpose.video-generation', status: 'planned', required: false, consumerIds: ['supervideo'] }];
    snapshot.presets = snapshot.presets.map((preset) => ({ ...preset, purposes: ['video-generation'], status: 'planned' }));
    snapshot.bindings = [];
    useModelConfigurationTabStore.setState({ purpose: 'video-generation' });
    await render(clientFor(snapshot));
    expect(host.textContent).toContain('Planned');
    expect(host.querySelector('input[aria-label="Model ID"]')).toBeNull();
    expect(Array.from(host.querySelectorAll('button')).some((candidate) => candidate.textContent === 'Save changes')).toBe(false);
  });

  test('a newly created account replaces the purpose connection while retaining its draft', async () => {
    const snapshot = configuration();
    const client = clientFor(snapshot);
    let savedBinding: ModelBindingInput | null = null;
    client.saveConnection = async (_revision, input) => ({
      ...snapshot, revision: 2,
      connections: [...snapshot.connections, { id: 'second-account', name: input.name, baseUrl: input.baseUrl, providerId: input.providerId, protocol: input.protocol, hasApiKey: true }],
    });
    client.saveBinding = async (_purpose, revision, binding) => { savedBinding = binding; return { ...snapshot, revision: revision + 1 }; };
    await render(client);
    await type('Model ID', 'embedding-proposed');
    await act(async () => button('Add connection').click());
    await type('Connection name', 'Second account');
    await type('API key', 'second-fixture-key');
    await act(async () => button('Save changes').click());
    expect(useModelConfigurationTabStore.getState().tab).toBe('purposes');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe('embedding-proposed');
    expect(host.querySelector('button[aria-label="Connection"]')?.textContent).toContain('Second account');
    await act(async () => button('Save changes').click());
    expect(savedBinding).toMatchObject({ connectionId: 'second-account', model: 'embedding-proposed', parameters: { dimensions: 1024 } });
  });

  test('creating a connection directly retains its model and parameters for the saved connection test', async () => {
    const snapshot = configuration();
    const client = clientFor(snapshot);
    let testedModel = '';
    let testedDimensions: number | undefined;
    client.saveConnection = async (revision, input) => ({
      ...snapshot, revision: revision + 1,
      connections: [...snapshot.connections, { id: 'direct-account', name: input.name, baseUrl: input.baseUrl, providerId: input.providerId, protocol: input.protocol, hasApiKey: true }],
    });
    client.testConnection = async (_id, _revision, probe) => {
      testedModel = probe.model; testedDimensions = probe.parameters.dimensions;
      return { status: 'verified', testedAt: '2026-10-23T00:00:00Z' };
    };
    useModelConfigurationTabStore.setState({ tab: 'connections' });
    await render(client);
    const picker = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label="Recommended model"]')).find((candidate) => !candidate.closest('[hidden]'));
    if (!picker) throw new Error('Missing connection recommendation');
    await act(async () => picker.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((candidate) => candidate.textContent?.includes('China embedding'));
    if (!option) throw new Error('Missing recommended model');
    await act(async () => option.click());
    await type('Model ID', 'custom-embedding');
    await type('Dimensions', '768');
    await type('API key', 'direct-fixture-key');
    await act(async () => button('Save changes').click());
    const visibleModel = Array.from(host.querySelectorAll<HTMLInputElement>('input[aria-label="Model ID"]')).find((candidate) => !candidate.closest('[hidden]'));
    expect(visibleModel?.value).toBe('custom-embedding');
    expect(button('Test saved connection').disabled).toBe(false);
    await act(async () => button('Test saved connection').click());
    expect(testedModel).toBe('custom-embedding');
    expect(testedDimensions).toBe(768);
    expect(host.textContent).toContain('Connection verified for this model and purpose.');
  });

  test('an unmounted runtime save cannot activate the current runtime voice path or change its save feedback', async () => {
    const snapshot = configuration();
    snapshot.purposes = [{ id: 'tts', labelKey: 'modelConfiguration.purpose.tts', status: 'available', consumerIds: ['read-aloud'], required: false }];
    snapshot.presets = snapshot.presets.map((preset) => ({ ...preset, purposes: ['tts'] }));
    snapshot.bindings = [{ purpose: 'tts', connectionId: 'saved', presetId: 'china', model: 'speech-model', parameters: { voice: 'alloy' }, verification: { status: 'untested' } }];
    const client = clientFor(snapshot);
    let finish: ((result: ModelConfiguration) => void) | undefined;
    client.saveBinding = async () => new Promise((resolve) => { finish = resolve; });
    const originalProvider = useConfigStore.getState().voiceProvider;
    useConfigStore.getState().setVoiceProvider('local');
    useModelConfigurationTabStore.setState({ purpose: 'tts' });
    await render(client);
    await type('Voice', 'different-voice');
    await act(async () => button('Save changes').click());
    await act(async () => root.render(null));
    reportSettingsSaveState('error');
    if (!finish) throw new Error('Save did not start');
    const complete = finish;
    await act(async () => complete({ ...snapshot, revision: 2 }));
    expect(useConfigStore.getState().voiceProvider).toBe('local');
    expect(getSettingsSaveState()).toBe('error');
    useConfigStore.getState().setVoiceProvider(originalProvider);
  });

  test('OpenCode key reuse submits only the reference and removes the manual key field', async () => {
    const snapshot = configuration();
    snapshot.credentialSources = { status: 'available', sources: [{ type: 'opencode', providerId: 'example', name: 'Example provider' }] };
    snapshot.connections[0].credentialSource = { type: 'opencode', providerId: 'example' };
    const client = clientFor(snapshot);
    const writes: ModelConnectionInput[] = [];
    client.saveConnection = async (revision, input) => {
      writes.push(input);
      return { ...snapshot, revision: revision + 1, connections: snapshot.connections.map((connection) => {
        const updated = { ...connection };
        if (input.credentialSource) updated.credentialSource = input.credentialSource;
        return updated;
      }) };
    };
    useModelConfigurationTabStore.setState({ tab: 'connections' });
    await render(client);
    const connectionPicker = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label="Connection"]')).find((candidate) => !candidate.closest('[hidden]'));
    if (!connectionPicker) throw new Error('Missing connection picker');
    await act(async () => connectionPicker.click());
    const connectionOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((candidate) => candidate.textContent?.includes('My connection'));
    if (!connectionOption) throw new Error('Missing stored connection');
    await act(async () => connectionOption.click());
    expect(host.querySelector('input[aria-label="API key"]')).toBeNull();
    await act(async () => button('Save changes').click());
    expect(writes).toHaveLength(1);
    expect(writes[0]?.credentialSource).toEqual({ type: 'opencode', providerId: 'example' });
    expect(writes[0]?.apiKey).toBeUndefined();
  });

  test('the rendered Chinese page uses its translated namespace and preserves English provider names', async () => {
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    await render(clientFor(configuration()));
    expect(host.textContent).toContain('模型配置');
    expect(host.textContent).toContain('模型来源');
    expect(host.textContent).toContain('国外模型');
    expect(host.textContent).toContain('保存更改');
    expect(host.textContent).not.toContain('Model configuration');
  });

  test('retirement and editable-PPT exclusions are visible as translated preset qualifications', async () => {
    const snapshot = configuration();
    snapshot.presets[0].noteCodes = ['openai-tts-retirement', 'editable-ppt-excluded'];
    await render(clientFor(snapshot));
    expect(host.textContent).toContain('2027-01-06');
    expect(host.textContent).toContain('The bundled editable-PPT skill excludes this model.');
    expect(host.textContent).toContain('Recommendations reviewed on 2026-10-23');
  });

  test('legacy knowledge configuration is shown read-only without replacing its model or index', async () => {
    const snapshot = configuration(); snapshot.bindings = [];
    const client = clientFor(snapshot);
    let reads = 0;
    client.readKnowledgeModels = async () => { reads += 1; return { status: 'available', models: [{ purpose: 'embedding', modelId: 'legacy', model: 'text-embedding-existing', baseUrl: 'https://existing.example/v1', dimensions: 1024, hasKey: true }] }; };
    await render(client);
    expect(reads).toBe(1);
    expect(host.textContent).toContain('Current component settings still apply');
    expect(host.textContent).toContain('text-embedding-existing');
    expect(host.textContent).toContain('https://existing.example/v1');
    expect(host.textContent).toContain('Dimensions: 1024');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe('');
  });

  test('legacy voice model and source remain visible while endpoint credentials stay hidden', async () => {
    const snapshot = configuration(); snapshot.bindings = [];
    snapshot.purposes = [{ id: 'tts', labelKey: 'modelConfiguration.purpose.tts', status: 'available', consumerIds: ['read-aloud'], required: false }];
    const initial = useConfigStore.getState();
    useConfigStore.setState({ voiceProvider: 'openai-compatible', openaiCompatibleTtsModel: 'existing-speech-model', openaiCompatibleUrl: 'https://name:fixture-password@voice.example/v1?key=fixture-secret' });
    useModelConfigurationTabStore.setState({ purpose: 'tts' });
    await render(clientFor(snapshot));
    expect(host.textContent).toContain('Current component settings still apply');
    expect(host.textContent).toContain('existing-speech-model');
    expect(host.textContent).toContain('https://voice.example/v1');
    expect(host.textContent).not.toContain('fixture-password');
    expect(host.textContent).not.toContain('fixture-secret');
    await act(async () => useConfigStore.setState({ voiceProvider: initial.voiceProvider, openaiCompatibleTtsModel: initial.openaiCompatibleTtsModel, openaiCompatibleUrl: initial.openaiCompatibleUrl }));
  });

  test('a pristine draft adopts an externally changed binding on refresh', async () => {
    let current = configuration(); const client = clientFor(current);
    client.read = async () => current;
    await render(client);
    current = { ...current, revision: 2, bindings: [{ ...current.bindings[0], presetId: undefined, model: 'external-model', parameters: { dimensions: 2048 } }] };
    await act(async () => button('Refresh').click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe('external-model');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Dimensions"]')?.value).toBe('2048');
    expect(button('Save changes').disabled).toBe(true);
  });

  test('an external binding change blocks a dirty draft until the saved binding is reloaded', async () => {
    let current = configuration(); const client = clientFor(current);
    client.read = async () => current;
    await render(client);
    await type('Model ID', 'unsaved-local-model');
    current = { ...current, revision: 2, bindings: [{ ...current.bindings[0], presetId: undefined, model: 'external-model', parameters: { dimensions: 2048 } }] };
    await act(async () => button('Refresh').click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe('unsaved-local-model');
    expect(host.textContent).toContain('The saved binding changed in another window');
    expect(button('Save changes').disabled).toBe(true);
    await act(async () => button('Reload saved binding').click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe('external-model');
    expect(host.textContent).not.toContain('The saved binding changed in another window');
    await type('Model ID', 'next-model');
    expect(button('Save changes').disabled).toBe(false);
  });

  test('an edited custom model does not submit the former preset ID', async () => {
    const snapshot = configuration(); const client = clientFor(snapshot);
    const writes: Array<ModelBindingInput | null> = [];
    client.saveBinding = async (_purpose, _revision, binding) => { writes.push(binding); return snapshot; };
    await render(client);
    await type('Model ID', 'my-custom-embedding');
    await act(async () => button('Save changes').click());
    expect(writes).toHaveLength(1);
    expect(writes[0]?.model).toBe('my-custom-embedding');
    expect(writes[0]?.presetId).toBeUndefined();
    expect(writes[0]?.connectionId).toBe('saved');
  });

  test('unsupported purpose probes show component validation guidance without a false failed result', async () => {
    const snapshot = configuration(); snapshot.purposes[0].probeProtocols = [];
    const client = clientFor(snapshot); let probes = 0;
    client.testBinding = async () => { probes += 1; return snapshot; };
    await render(client);
    expect(button('Test saved binding').disabled).toBe(true);
    expect(host.textContent).toContain('Verify this configuration by running its component once.');
    await act(async () => button('Test saved binding').click());
    expect(probes).toBe(0);
    expect(host.textContent).toContain('Saved, not tested');
  });

  test('enterprise mode permits existing local bindings and local probes while keeping new connections blocked', async () => {
    const snapshot = configuration(); snapshot.enterpriseMode = true;
    snapshot.connections[0].baseUrl = 'http://127.0.0.1:11434/v1';
    await render(clientFor(snapshot));
    expect(button('Test saved binding').disabled).toBe(false);
    expect(button('Add connection').disabled).toBe(true);
    await type('Model ID', 'local-embedding');
    expect(button('Save changes').disabled).toBe(false);
  });

  test('enterprise mode keeps external endpoint probes disabled', async () => {
    const snapshot = configuration(); snapshot.enterpriseMode = true;
    await render(clientFor(snapshot));
    expect(button('Test saved binding').disabled).toBe(true);
  });

  test('local connections can be created without a placeholder API key', async () => {
    const snapshot = configuration(); const client = clientFor(snapshot);
    const writes: ModelConnectionInput[] = [];
    client.saveConnection = async (_revision, input) => { writes.push(input); return { ...snapshot, revision: 2, connections: [...snapshot.connections, { id: 'local', name: input.name, providerId: input.providerId, protocol: input.protocol, baseUrl: input.baseUrl, hasApiKey: false }] }; };
    await render(client);
    await act(async () => button('Add connection').click());
    await type('Connection name', 'Local server');
    await type('API base URL', 'http://127.0.0.1:11434/v1');
    expect(button('Save changes').disabled).toBe(false);
    await act(async () => button('Save changes').click());
    expect(writes).toHaveLength(1);
    expect(writes[0]?.apiKey).toBeUndefined();
    expect(writes[0]?.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  test('settings search prepares the purpose before its anchor is revealed', () => {
    prepareModelConfigurationTarget('models.image-generation');
    expect(useModelConfigurationTabStore.getState().purpose).toBe('image-generation');
    expect(useModelConfigurationTabStore.getState().tab).toBe('purposes');
    prepareModelConfigurationTarget('models.connections');
    expect(useModelConfigurationTabStore.getState().tab).toBe('connections');
    prepareModelConfigurationTarget('sessions.small-model');
    expect(useModelConfigurationTabStore.getState().purpose).toBe('auxiliary');
  });
  function overviewRow(purpose: string): HTMLElement {
    const row = host.querySelector<HTMLElement>(`[data-model-purpose="${purpose}"]`);
    if (!row) throw new Error(`Missing overview row: ${purpose}`);
    return row;
  }
  function rowAction(row: HTMLElement, label: string): HTMLButtonElement {
    const action = row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!action) throw new Error(`Missing row action: ${label}`);
    return action;
  }
  test('overview lists every purpose without automatically testing and opens its existing settings', async () => {
    useModelConfigurationTabStore.setState({ tab: 'overview', purpose: 'embedding' });
    const snapshot = configuration(); const client = clientFor(snapshot); let tests = 0; let reads = 0;
    client.testBinding = async () => { tests += 1; return snapshot; };
    client.readKnowledgeModels = async () => { reads += 1; return { status: 'unavailable', reason: 'backend_unavailable' }; };
    await render(client);
    expect(host.querySelectorAll('[data-model-purpose]').length).toBe(15);
    expect(overviewRow('embedding').textContent).toContain('Configured');
    expect(overviewRow('embedding').textContent).toContain('Not tested');
    expect(overviewRow('ocr').textContent).toContain('Unknown');
    expect(tests).toBe(0); expect(reads).toBe(1);
    await act(async () => rowAction(overviewRow('embedding'), 'Configure Text embedding').click());
    expect(useModelConfigurationTabStore.getState().tab).toBe('purposes');
    expect(useModelConfigurationTabStore.getState().purpose).toBe('embedding');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')?.value).toBe('embedding-current');
    expect(tests).toBe(0);
  });
  test('an explicit overview test submits the saved purpose revision and updates its result', async () => {
    useModelConfigurationTabStore.setState({ tab: 'overview', purpose: 'embedding' });
    const snapshot = configuration(); const client = clientFor(snapshot); const calls: Array<{ purpose: string; revision: number }> = [];
    client.testBinding = async (purpose, revision) => {
      calls.push({ purpose, revision });
      return { ...snapshot, revision: 2, bindings: snapshot.bindings.map((binding) => ({ ...binding, verification: { status: 'verified', testedAt: '2026-10-23T00:00:00Z' } })) };
    };
    await render(client);
    await act(async () => rowAction(overviewRow('embedding'), 'Test Text embedding').click());
    expect(calls).toEqual([{ purpose: 'embedding', revision: 1 }]);
    expect(host.querySelector('[data-model-test="embedding"]')?.textContent).toBe('Passed');
    expect(overviewRow('embedding').textContent).toContain('embedding-current');
  });
  test('an incomplete overview test is unknown until retried and does not reuse an old passed status', async () => {
    useModelConfigurationTabStore.setState({ tab: 'overview', purpose: 'embedding' });
    const snapshot = configuration(); snapshot.bindings[0].verification = { status: 'verified', testedAt: '2026-10-23T00:00:00Z' };
    const client = clientFor(snapshot); let attempts = 0;
    client.testBinding = async () => { attempts += 1; if (attempts === 1) throw new ModelConfigurationError('model_configuration_revision_conflict'); return snapshot; };
    await render(client);
    expect(host.querySelector('[data-model-test="embedding"]')?.textContent).toBe('Passed');
    await act(async () => rowAction(overviewRow('embedding'), 'Test Text embedding').click());
    expect(host.querySelector('[data-model-test="embedding"]')?.textContent).toBe('Unknown');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Text embedding');
    await act(async () => rowAction(overviewRow('embedding'), 'Test Text embedding').click());
    expect(host.querySelector('[data-model-test="embedding"]')?.textContent).toBe('Passed');
  });
  test('overview read failure shows unknown rows and search opens the overview target', async () => {
    prepareModelConfigurationTarget('models.overview');
    expect(useModelConfigurationTabStore.getState().tab).toBe('overview');
    const client = clientFor(configuration()); client.read = async () => { throw new Error('offline'); };
    await render(client);
    expect(host.querySelector('[data-model-test="embedding"]')?.textContent).toBe('Unknown');
    expect(rowAction(overviewRow('embedding'), 'Test Text embedding').disabled).toBe(true);
    expect(host.textContent).toContain('Could not load model configuration');
    expect(useModelConfigurationTabStore.getInitialState().tab).toBe('overview');
  });

  test('a successful purpose test clears an older overview request error', async () => {
    useModelConfigurationTabStore.setState({ tab: 'overview', purpose: 'embedding' });
    const snapshot = configuration(); const client = clientFor(snapshot); let attempts = 0;
    client.testBinding = async () => {
      attempts += 1;
      if (attempts === 1) throw new ModelConfigurationError('model_configuration_revision_conflict');
      return { ...snapshot, revision: 2, bindings: snapshot.bindings.map((binding) => ({ ...binding, verification: { status: 'verified', testedAt: '2026-10-23T01:00:00Z' } })) };
    };
    await render(client);
    await act(async () => rowAction(overviewRow('embedding'), 'Test Text embedding').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Text embedding');
    await act(async () => rowAction(overviewRow('embedding'), 'Configure Text embedding').click());
    await act(async () => button('Test saved binding').click());
    await act(async () => button('Overview').click());
    expect(host.querySelector('[data-model-test="embedding"]')?.textContent).toBe('Passed');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  test('a fresh empty default preference does not resurrect an old user default in overview', async () => {
    useModelConfigurationTabStore.setState({ tab: 'overview', purpose: 'embedding' });
    const previousDefault = useConfigStore.getState().settingsDefaultModel;
    const previousOpenCode = useConfigStore.getState().opencodeDefaultModel;
    useConfigStore.setState({ settingsDefaultModel: 'stale/old-user-model', opencodeDefaultModel: 'server/native-default' });
    try {
      await render(clientFor(configuration()));
      expect(overviewRow('agent').textContent).toContain('server/native-default');
      expect(overviewRow('agent').textContent).not.toContain('old-user-model');
    } finally { await act(async () => useConfigStore.setState({ settingsDefaultModel: previousDefault, opencodeDefaultModel: previousOpenCode })); }
  });

});
