import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { ModelConfiguration } from '@/lib/modelConfiguration';
import type { ModelBootstrapClient, ModelBootstrapTestRun } from '@/lib/modelConfigurationBootstrap';

const browser = new Window({ url: 'http://localhost/' });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true }); }
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ModelQuickSetupWizard } = await import('./ModelQuickSetupWizard');

const config = (): ModelConfiguration => ({ version: 1, revision: 2, enterpriseMode: false, credentialSources: { status: 'available', sources: [] }, purposes: [{ id: 'agent', labelKey: 'modelConfiguration.purpose.agent', status: 'available', consumerIds: [], required: true, probeProtocols: ['openai-compatible'] }], presets: [], connections: [], bindings: [] });

afterAll(async () => { await browser.happyDOM.close(); for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });

describe('ModelQuickSetupWizard', () => {
  let root: Root; let host: HTMLDivElement;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => button.click());
  };
  const batchScenario = (startTests: ModelBootstrapClient['startTests'], readTestRun: ModelBootstrapClient['readTestRun']) => {
    const configuration = config();
    configuration.purposes = [
      { id: 'embedding', labelKey: 'modelConfiguration.purpose.embedding', status: 'available', consumerIds: [], required: true, probeProtocols: ['openai-compatible'] },
      { id: 'image-generation', labelKey: 'modelConfiguration.purpose.image-generation', status: 'available', consumerIds: [], required: false, probeProtocols: ['openai-compatible'] },
    ];
    configuration.bindings = [
      { purpose: 'embedding', connectionId: 'fixture', model: 'embedding-fixture', parameters: {}, verification: { status: 'untested' } },
      { purpose: 'image-generation', connectionId: 'fixture', model: 'image-fixture', parameters: {}, verification: { status: 'untested' } },
    ];
    const client: ModelBootstrapClient = {
      discover: async () => ({ discoveryId: 'd1', source: 'session', models: [] }),
      issueKey: async () => { throw new Error('Unexpected key issuance'); },
      preview: async () => ({ operationId: 'op1', discoveryId: 'd1', revision: 2, mode: 'fill-missing', add: [], replace: [], preserve: [], unavailable: [], items: configuration.purposes.map(purpose => ({ purpose: purpose.id, action: 'add', modelId: purpose.id, recommendedModel: purpose.id, candidates: undefined, estimatedCost: undefined, reason: undefined })) }),
      apply: async () => configuration,
      startTests, readTestRun,
      rollback: async () => ({ operationId: 'op1', rolledBack: true, revision: 3 }),
    };
    return { configuration, client };
  };
  const openBatch = async (scenario: ReturnType<typeof batchScenario>) => {
    await act(async () => root.render(<I18nProvider><ModelQuickSetupWizard open {...scenario} onClose={() => {}} onApplied={() => {}} /></I18nProvider>));
    await click('Discover models'); await click('Build preview'); await click('Apply configuration');
  };

  test('keeps mobile account setup explicitly unavailable', async () => {
    const scenario = batchScenario(async () => { throw new Error('Unexpected model request'); }, async () => { throw new Error('Unexpected status request'); });
    const calls: string[] = [];
    scenario.client.discover = async () => { calls.push('discover'); return { discoveryId: 'd1', source: 'session', models: [] }; };
    window.history.replaceState({}, '', '/?surface=mobile');
    try {
      await act(async () => root.render(<I18nProvider><ModelQuickSetupWizard open {...scenario} onClose={() => {}} onApplied={() => {}} /></I18nProvider>));
      const discover = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Discover models');
      expect(discover?.disabled).toBe(true);
      expect(calls).toEqual([]);
    } finally { window.history.replaceState({}, '', '/'); }
  });

  test('an explicit credits choice reaches discovery without issuing a Key', async () => {
    const scenario = batchScenario(async () => { throw new Error('Unexpected model request'); }, async () => { throw new Error('Unexpected status request'); });
    const calls: Array<Parameters<ModelBootstrapClient['discover']>[0]> = [];
    scenario.client.discover = async (input) => { calls.push(input); return { discoveryId: 'd1', source: 'session', fundingMode: 'credits', models: [] }; };
    await act(async () => root.render(<I18nProvider><ModelQuickSetupWizard open {...scenario} onClose={() => {}} onApplied={() => {}} /></I18nProvider>));
    await click('Credits');
    expect(calls).toEqual([]);
    await click('Discover models');
    expect(calls).toEqual([{ source: 'session', fundingMode: 'credits', key: undefined }]);
  });

  test('batch tests animate immediately and keep skipped images separate from verified embeddings', async () => {
    let finishStart: (run: ModelBootstrapTestRun) => void = () => {};
    let finishRead: (run: ModelBootstrapTestRun) => void = () => {};
    let starts = 0;
    await openBatch(batchScenario(
      async () => { ++starts; return new Promise(resolve => { finishStart = resolve; }); },
      async () => new Promise(resolve => { finishRead = resolve; }),
    ));
    expect(document.querySelector('[data-spinner]')).not.toBeNull();
    expect(document.body.textContent).toContain('embedding-fixture');
    expect(starts).toBe(1);
    await act(async () => finishStart({ testRunId: 't1', status: 'running', results: [{ purpose: 'embedding', status: 'pending' }, { purpose: 'image-generation', status: 'skipped' }] }));
    expect(document.querySelector('[data-spinner]')).not.toBeNull();
    await act(async () => finishRead({ testRunId: 't1', status: 'completed', results: [{ purpose: 'embedding', status: 'verified' }, { purpose: 'image-generation', status: 'skipped' }] }));
    expect(document.querySelector('[data-spinner]')).toBeNull();
    expect(document.body.textContent).toContain('Skipped');
    expect(document.body.textContent).toContain('embedding-fixture');
    expect(starts).toBe(1);
  });

  test('a failed batch result read stops motion and refreshes status without starting another model test', async () => {
    let starts = 0; let reads = 0;
    await openBatch(batchScenario(
      async () => { ++starts; return { testRunId: 't1', status: 'running', results: [{ purpose: 'embedding', status: 'pending' }] }; },
      async () => { if (++reads === 1) throw new Error('Fixture network failure'); return { testRunId: 't1', status: 'completed', results: [{ purpose: 'embedding', status: 'verified' }] }; },
    ));
    expect(document.querySelector('[data-spinner]')).toBeNull();
    expect(document.body.textContent).toContain('Test results could not be confirmed');
    await click('Refresh test results');
    expect(document.body.textContent).toContain('Tests completed');
    expect(starts).toBe(1);
    expect(reads).toBe(2);
  });

  test('an unconfirmed batch start keeps a static result panel without automatically restarting tests', async () => {
    let starts = 0;
    await openBatch(batchScenario(
      async () => { ++starts; throw new Error('Fixture lost start response'); },
      async () => { throw new Error('No run identifier was returned'); },
    ));
    expect(document.querySelector('[data-spinner]')).toBeNull();
    expect(document.body.textContent).toContain('Test results could not be confirmed');
    expect(document.body.textContent).not.toContain('Connection test passed');
    expect(starts).toBe(1);
  });

  test('closing the test wizard stops its scheduled status read', async () => {
    let reads = 0;
    const scenario = batchScenario(
      async () => ({ testRunId: 't1', status: 'running', results: [{ purpose: 'embedding', status: 'pending' }] }),
      async () => { ++reads; return { testRunId: 't1', status: 'running', results: [{ purpose: 'embedding', status: 'pending' }] }; },
    );
    await openBatch(scenario);
    expect(reads).toBe(1);
    await act(async () => root.render(<I18nProvider><ModelQuickSetupWizard open={false} {...scenario} onClose={() => {}} onApplied={() => {}} /></I18nProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 850)); });
    expect(reads).toBe(1);
    expect(document.querySelector('[data-spinner]')).toBeNull();
  });
  test('source selection never issues a key and imported discovery still requires a preview', async () => {
    const calls: string[] = [];
    const discovery = { discoveryId: 'imported', source: 'imported-key' as const, models: [] };
    const client: ModelBootstrapClient = {
      discover: async (input) => { calls.push(`discover:${input.source}`); return discovery; },
      issueKey: async () => { calls.push('issue'); return discovery; },
      preview: async () => { calls.push('preview'); return { operationId: 'preview', discoveryId: 'imported', revision: 2, mode: 'fill-missing', add: [], replace: [], preserve: [], unavailable: [], items: [] }; },
      apply: async () => { calls.push('apply'); return config(); },
      startTests: async () => ({ testRunId: 'test', status: 'completed', results: [] }),
      readTestRun: async () => ({ testRunId: 'test', status: 'completed', results: [] }),
      rollback: async () => ({ operationId: 'preview', rolledBack: true, revision: 3 }),
    };
    await act(async () => root.render(<I18nProvider><ModelQuickSetupWizard open configuration={config()} client={client} onClose={() => {}} onApplied={() => {}} /></I18nProvider>));
    const issuance = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Set up API Key'));
    expect(Boolean(issuance)).toBe(false);
    const source = document.querySelector<HTMLElement>('[role="radio"][aria-label="Import a SuperWagie API Key"]')
      ?? Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]')).find((item) => item.textContent?.includes('Import'));
    if (!source) throw new Error('Missing imported source');
    await act(async () => source.click());
    expect(calls).toEqual([]);
    const input = document.querySelector<HTMLInputElement>('input[type="password"]');
    if (!input) throw new Error('Missing key input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(input, 'fixture-managed-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const discover = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === 'Discover models');
    if (!discover) throw new Error('Missing discover');
    await act(async () => discover.click());
    expect(calls).toEqual(['discover:imported-key']);
    expect(Array.from(document.querySelectorAll('button')).some((item) => item.textContent === 'Apply configuration')).toBe(false);
    const preview = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === 'Build preview');
    if (!preview) throw new Error('Missing preview');
    await act(async () => preview.click());
    expect(calls).toEqual(['discover:imported-key', 'preview']);
  });

  test('discovers, previews, applies and starts tests from a session', async () => {
    const calls: string[] = [];
    const client: ModelBootstrapClient = {
      discover: async () => { calls.push('discover'); return { discoveryId: 'd1', source: 'session', models: [{ id: 'chat', operations: ['chat'], inputModalities: ['text'], outputModalities: ['text'], probe: true }] }; },
      issueKey: async () => { calls.push('issue'); return { discoveryId: 'd1', source: 'session', models: [] }; },
      preview: async () => { calls.push('preview'); return { operationId: 'op1', discoveryId: 'd1', revision: 2, mode: 'fill-missing', add: [{ purpose: 'agent', model: 'chat' }], replace: [], preserve: [], unavailable: [], items: [{ purpose: 'agent', action: 'add', modelId: 'chat', recommendedModel: 'chat', candidates: undefined, estimatedCost: undefined, reason: undefined }] }; },
      apply: async () => { calls.push('apply'); return config(); },
      startTests: async () => { calls.push('tests'); return { testRunId: 't1', status: 'queued', results: [] }; },
      readTestRun: async () => ({ testRunId: 't1', status: 'completed', results: [] }),
      rollback: async () => ({ operationId: 'op1', rolledBack: true, revision: 3 }),
    };
    await act(async () => root.render(<I18nProvider><ModelQuickSetupWizard open configuration={config()} client={client} onClose={() => {}} onApplied={() => {}} /></I18nProvider>));
    const button = (label: string) => Array.from(document.querySelectorAll('button')).find((candidate) => (candidate.textContent ?? '').includes(label));
    const discoverButton = button('Discover models');
    if (!discoverButton) throw new Error(document.body.textContent);
    await act(async () => discoverButton.click());
    const previewButton = button('Build preview');
    if (!previewButton) throw new Error(document.body.textContent);
    await act(async () => previewButton.click());
    const applyButton = button('Apply configuration');
    if (!applyButton) throw new Error(document.body.textContent);
    await act(async () => applyButton.click());
    expect(calls).toEqual(['discover', 'preview', 'apply', 'tests']);
    expect(document.body.textContent).toContain('Tests completed');
  });
});
