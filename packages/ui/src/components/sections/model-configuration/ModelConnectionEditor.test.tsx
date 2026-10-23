import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { ModelConfigurationError, testModelConnection, type ModelConfiguration, type ModelConnectionInput, type ModelConnectionTestInput, type ModelConnectionTestResult } from '@/lib/modelConfiguration';
import type { ModelConnectionProbeDraft } from './ModelConnectionEditor';

const browser = new Window({ url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, Element: browser.Element,
  Node: browser.Node, Event: browser.Event, PointerEvent: browser.PointerEvent, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = String(input instanceof Request ? input.url : input);
  if (path.endsWith('/fs/home')) return Response.json({ home: '/fixture' });
  if (path.endsWith('/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
  return Response.json([]);
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ModelConnectionEditor } = await import('./ModelConnectionEditor');
afterAll(async () => {
  fetchFixture.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const configuration = (): ModelConfiguration => ({
  version: 1, revision: 1, enterpriseMode: false, credentialSources: { status: 'available', sources: [] },
  purposes: [{ id: 'embedding', labelKey: 'modelConfiguration.purpose.embedding', status: 'available', consumerIds: ['knowledge-library'], required: true, probeProtocols: ['openai-compatible'] }],
  presets: [{ id: 'embedding', providerId: 'example', name: 'Example embedding', origin: 'international', purposes: ['embedding'], protocol: 'openai-compatible', model: 'embedding-current', baseUrl: 'https://models.example/v1', docsUrl: 'https://models.example/docs', keyUrl: 'https://models.example/keys', parameters: { dimensions: 1024 }, status: 'compatible', notes: [], noteCodes: [], reviewedAt: '2026-10-23' }],
  connections: [{ id: 'saved', name: 'My connection', providerId: 'example', protocol: 'openai-compatible', baseUrl: 'https://models.example/v1', hasApiKey: true }],
  bindings: [{ purpose: 'embedding', connectionId: 'saved', presetId: 'embedding', model: 'embedding-current', parameters: { dimensions: 1024 }, verification: { status: 'untested' } }],
});

describe('ModelConnectionEditor', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    useI18nStore.getState().setLocale('en');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  function clientFor(snapshot: ModelConfiguration) {
    return {
      saveConnection: async (_revision: number, _connection: ModelConnectionInput) => snapshot,
      removeConnection: async () => snapshot,
      testConnection: async (_id: string, _revision: number, _input: ModelConnectionTestInput): Promise<ModelConnectionTestResult> => ({ status: 'verified', testedAt: '2026-10-23T00:00:00Z' }),
    };
  }
  async function render(snapshot: ModelConfiguration, client = clientFor(snapshot), selected = snapshot.connections[0] ?? null, initialPreset = selected ? null : snapshot.presets[0] ?? null) {
    await act(async () => root.render(<I18nProvider><ModelConnectionEditor configuration={snapshot} selected={selected} initialPreset={initialPreset} pending={false} applyChange={(operation) => operation()} client={client} onSaved={() => {}} /></I18nProvider>));
  }
  function field(label: string): HTMLInputElement {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!input) throw new Error(`Missing field: ${label}`);
    return input;
  }
  function button(label: string): HTMLButtonElement {
    const value = Array.from(host.querySelectorAll('button')).find((candidate) => candidate.textContent === label);
    if (!value) throw new Error(`Missing button: ${label}`);
    return value;
  }
  async function type(label: string, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Missing input setter');
      setter.call(field(label), value); field(label).dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  test('a recommendation fills endpoint, model and parameters, and restores edited defaults', async () => {
    const snapshot = configuration(); snapshot.connections = []; snapshot.bindings = [];
    await render(snapshot);
    expect(field('API base URL').value).toBe('https://models.example/v1');
    expect(field('Model ID').value).toBe('embedding-current');
    expect(field('Dimensions').value).toBe('1024');
    expect(host.querySelector('input[aria-label="Workspace ID"]')).toBeNull();
    expect(host.querySelector('input[aria-label="Region"]')).toBeNull();
    await type('API base URL', 'https://custom.example/v1'); await type('Model ID', 'custom-model');
    await act(async () => button('Use recommended defaults').click());
    expect(field('API base URL').value).toBe('https://models.example/v1');
    expect(field('Model ID').value).toBe('embedding-current');
    expect(button('Test saved connection').disabled).toBe(true);
    expect(host.textContent).toContain('Save the connection before testing it.');
  });
  test('changing the recommended model prefills its endpoint and parameters', async () => {
    const snapshot = configuration(); snapshot.connections = []; snapshot.bindings = [];
    snapshot.presets.push({ ...snapshot.presets[0], id: 'second', name: 'Second embedding', providerId: 'second', baseUrl: 'https://second.example/v1', model: 'second-model', parameters: { dimensions: 2048, region: 'international' } });
    await render(snapshot);
    const picker = host.querySelector<HTMLButtonElement>('button[aria-label="Recommended model"]');
    if (!picker) throw new Error('Missing recommendation picker');
    await act(async () => picker.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((candidate) => candidate.textContent === 'Second embedding');
    if (!option) throw new Error('Missing recommendation option');
    await act(async () => {
      option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      option.click();
    });
    expect(field('API base URL').value).toBe('https://second.example/v1');
    expect(field('Model ID').value).toBe('second-model');
    expect(field('Dimensions').value).toBe('2048');
    expect(field('Region').value).toBe('international');
  });
  test('saved connection testing submits the chosen model without changing bindings', async () => {
    const snapshot = configuration(); const client = clientFor(snapshot); const calls: ModelConnectionTestInput[] = [];
    client.testConnection = async (id, revision, input) => { expect(id).toBe('saved'); expect(revision).toBe(1); calls.push(input); return { status: 'verified', testedAt: '2026-10-23T00:00:00Z' }; };
    await render(snapshot, client); await type('Model ID', 'custom-embedding');
    expect(button('Test saved connection').disabled).toBe(false);
    await act(async () => button('Test saved connection').click());
    expect(calls).toEqual([{ purpose: 'embedding', model: 'custom-embedding', parameters: { dimensions: 1024 } }]);
    expect(snapshot.bindings[0].model).toBe('embedding-current');
    expect(host.textContent).toContain('Connection verified for this model and purpose.');
  });
  test('saving hands off only the public probe draft and restores it after the saved editor remounts', async () => {
    const snapshot = configuration(); snapshot.connections = []; snapshot.bindings = [];
    const client = clientFor(snapshot);
    let savedId = ''; let draft: ModelConnectionProbeDraft | undefined;
    const savedConnection = { id: 'new-account', name: 'Example embedding', providerId: 'example', protocol: 'openai-compatible' as const, baseUrl: 'https://models.example/v1', hasApiKey: true };
    client.saveConnection = async () => ({ ...snapshot, revision: 2, connections: [savedConnection] });
    await act(async () => root.render(<I18nProvider><ModelConnectionEditor key="draft" configuration={snapshot} selected={null} initialPreset={snapshot.presets[0]} pending={false} applyChange={(operation) => operation()} client={client} onSaved={(id, probe) => { savedId = id; draft = probe; }} /></I18nProvider>));
    await type('Model ID', 'custom-model'); await type('Dimensions', '2048'); await type('API key', 'fixture-private-key');
    await act(async () => button('Save changes').click());
    expect(savedId).toBe('new-account');
    expect(draft).toEqual({ presetId: 'embedding', purpose: 'embedding', model: 'custom-model', parameters: { dimensions: 2048 } });
    expect(JSON.stringify(draft)).not.toContain('fixture-private-key');
    const saved = { ...snapshot, revision: 2, connections: [savedConnection] };
    await act(async () => root.render(<I18nProvider><ModelConnectionEditor key="saved" configuration={saved} selected={savedConnection} initialPreset={null} initialDraft={draft} pending={false} applyChange={(operation) => operation()} client={client} onSaved={() => {}} /></I18nProvider>));
    expect(field('Model ID').value).toBe('custom-model'); expect(field('Dimensions').value).toBe('2048');
    expect(field('API key').value).toBe(''); expect(button('Test saved connection').disabled).toBe(false);
  });
  test('endpoint and credential changes require a save before testing', async () => {
    const snapshot = configuration(); await render(snapshot);
    expect(button('Test saved connection').disabled).toBe(false);
    await type('API base URL', 'https://other.example/v1');
    expect(button('Test saved connection').disabled).toBe(true);
    await type('API base URL', snapshot.connections[0].baseUrl);
    expect(button('Test saved connection').disabled).toBe(false);
    await type('API key', 'fixture-key');
    expect(button('Test saved connection').disabled).toBe(true);
    expect(host.textContent).not.toContain('fixture-key');
  });
  test('unsupported and planned models cannot run a misleading connection test', async () => {
    const snapshot = configuration(); snapshot.presets[0].status = 'requires-adapter';
    await render(snapshot);
    expect(button('Test saved connection').disabled).toBe(true);
    expect(host.textContent).toContain('Connection testing is unavailable for this model and purpose.');
    snapshot.presets[0].status = 'compatible'; snapshot.purposes[0].status = 'planned';
    await render(snapshot);
    expect(button('Test saved connection').disabled).toBe(true);
  });
  test('enterprise mode permits saved loopback probes while external probes and connection writes stay blocked', async () => {
    const local = configuration(); local.enterpriseMode = true;
    local.connections[0].baseUrl = 'http://127.0.0.1:8080/v1';
    const client = clientFor(local); let probes = 0;
    client.testConnection = async () => { probes += 1; return { status: 'verified', testedAt: '2026-10-23T00:00:00Z' }; };
    await render(local, client);
    expect(button('Save changes').disabled).toBe(true);
    expect(button('Test saved connection').disabled).toBe(false);
    await act(async () => button('Test saved connection').click());
    expect(probes).toBe(1);
    const external = configuration(); external.enterpriseMode = true;
    await act(async () => root.unmount()); root = createRoot(host);
    await render(external, client);
    expect(button('Save changes').disabled).toBe(true);
    expect(button('Test saved connection').disabled).toBe(true);
    await act(async () => button('Test saved connection').click());
    expect(probes).toBe(1);
  });
  test('probe failures display a sanitized code and retain the form', async () => {
    const snapshot = configuration(); const client = clientFor(snapshot);
    client.testConnection = async () => ({ status: 'failed', testedAt: '2026-10-23T00:00:00Z', errorCode: 'model_configuration_provider_http_401' });
    await render(snapshot, client); await act(async () => button('Test saved connection').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('model_configuration_provider_http_401');
    expect(field('Model ID').value).toBe('embedding-current');
    client.testConnection = async () => { throw new ModelConfigurationError('model_configuration_revision_conflict'); };
    await render(snapshot, client); await act(async () => button('Test saved connection').click());
    expect(host.textContent).toContain('Configuration changed on another client.');
  });
  test('a late test result is discarded after the model changes', async () => {
    const snapshot = configuration(); const client = clientFor(snapshot);
    let complete: ((result: ModelConnectionTestResult) => void) | undefined;
    client.testConnection = () => new Promise((resolve) => { complete = resolve; });
    await render(snapshot, client); await act(async () => button('Test saved connection').click());
    expect(host.textContent).toContain('Testing connection');
    await type('Model ID', 'new-model');
    await type('Model ID', 'embedding-current');
    if (!complete) throw new Error('Probe did not start');
    const finish = complete;
    await act(async () => finish({ status: 'verified', testedAt: '2026-10-23T00:00:00Z' }));
    expect(host.textContent).not.toContain('Connection verified for this model and purpose.');
    expect(field('Model ID').value).toBe('embedding-current');
  });
  test('the HTTP client sends the saved connection test contract and rejects malformed verification', async () => {
    let requestBody: string | null = null; let path = '';
    fetchFixture.mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(input, browser.location.href), init);
      path = request.url;
      requestBody = await request.text();
      return Response.json({ status: 'verified', testedAt: '2026-10-23T00:00:00Z' });
    });
    const input: ModelConnectionTestInput = { purpose: 'embedding', model: 'embedding-current', presetId: 'embedding', parameters: { dimensions: 1024 } };
    expect(await testModelConnection('saved/connection', 4, input)).toEqual({ status: 'verified', testedAt: '2026-10-23T00:00:00Z' });
    expect(path).toContain('/api/model-configuration/connections/saved%2Fconnection/test');
    expect(JSON.parse(requestBody ?? '{}')).toEqual({ revision: 4, ...input });
    fetchFixture.mockImplementation(async () => Response.json({ status: 'connected' }));
    await expect(testModelConnection('saved', 4, input)).rejects.toThrow('bad_response');
  });
});
