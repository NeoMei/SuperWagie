import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { ModelPurposeId } from '@/lib/modelConfiguration';
import type { ModelOverviewRow } from './modelOverviewRows';
import { MODEL_PURPOSE_LABELS } from './modelConfigurationView';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  Event: browser.Event, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { ModelConfigurationOverview } = await import('./ModelConfigurationOverview');
type OverviewProps = React.ComponentProps<typeof ModelConfigurationOverview>;

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function row(purpose: ModelPurposeId, changes: Partial<ModelOverviewRow> = {}): ModelOverviewRow {
  return { purpose, required: false, model: null, configuration: 'missing', test: 'untested', canConfigure: true, canTest: false, ...changes };
}

describe('ModelConfigurationOverview', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    useI18nStore.getState().setLocale('en');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  async function render(rows: ModelOverviewRow[], changes: Partial<OverviewProps> = {}) {
    await act(async () => root.render(<I18nProvider><ModelConfigurationOverview rows={rows} pending={false} testingPurpose={null} onConfigure={() => {}} onTest={() => {}} {...changes} /></I18nProvider>));
  }
  function button(label: string): HTMLButtonElement {
    const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }

  test('renders every purpose in one flat list with model and connection names', async () => {
    const rows = Object.keys(MODEL_PURPOSE_LABELS).filter((id): id is ModelPurposeId => id in MODEL_PURPOSE_LABELS).map((id) => row(id));
    rows[0] = row('agent', { required: true, configuration: 'native', test: 'component', model: 'openai/example-chat' });
    rows[4] = row('embedding', { configuration: 'configured', model: 'example-embedding', connectionName: 'Research API', canTest: true });
    await render(rows);
    expect(host.querySelectorAll('[data-model-purpose]')).toHaveLength(15);
    expect(host.querySelector('[data-settings-item="models.overview"]')).not.toBeNull();
    expect(host.textContent).toContain('openai/example-chat');
    expect(host.textContent).toContain('example-embedding');
    expect(host.textContent).toContain('Research API');
    expect(host.querySelector('h2')).toBeNull();
  });

  test('summary separates missing setup, saved untested, passed, fault and component checks', async () => {
    await render([
      row('agent', { configuration: 'native', test: 'component' }),
      row('embedding', { configuration: 'configured', canTest: true }),
      row('vision', { configuration: 'configured', test: 'verified', canTest: true }),
      row('rerank', { configuration: 'configured', test: 'failed', canTest: true }),
      row('ocr'),
      row('video-generation', { configuration: 'planned', test: 'unsupported', canConfigure: false }),
      row('routing', { configuration: 'unknown', test: 'unknown', canConfigure: false }),
    ]);
    const summary = host.querySelector('[aria-label="Model configuration summary"]');
    expect(summary?.textContent).toContain('Needs setup1');
    expect(summary?.textContent).toContain('Untested1');
    expect(summary?.textContent).toContain('Passed1');
    expect(summary?.textContent).toContain('Faults1');
    expect(summary?.textContent).toContain('Component checks1');
    expect(summary?.textContent).toContain('Planned1');
    expect(summary?.textContent).toContain('Unknown1');
  });

  test('configure, test and planned view actions target their own purpose', async () => {
    const configured: ModelPurposeId[] = []; const tested: ModelPurposeId[] = [];
    await render([
      row('embedding', { configuration: 'configured', canTest: true }),
      row('ocr', { configuration: 'inherited', test: 'component' }),
      row('video-generation', { configuration: 'planned', test: 'unsupported', canConfigure: false }),
      row('routing', { configuration: 'unknown', test: 'unknown', canConfigure: false }),
    ], { onConfigure: (purpose) => configured.push(purpose), onTest: (purpose) => tested.push(purpose) });
    await act(async () => button('Configure Text embedding').click());
    await act(async () => button('Test Text embedding').click());
    await act(async () => button('View Video generation').click());
    await act(async () => button('Test OCR and document parsing').click());
    expect(configured).toEqual(['embedding', 'video-generation']);
    expect(tested).toEqual(['embedding']);
    expect(button('Configure Classification and model routing').disabled).toBe(true);
    expect(host.textContent).toContain('In component');
  });

  test('testing reserves the same action slot and prevents duplicate or concurrent actions', async () => {
    const rows = [row('embedding', { configuration: 'configured', canTest: true }), row('vision', { configuration: 'configured', canTest: true })];
    await render(rows);
    const idleClass = button('Test Text embedding').className;
    await render(rows, { testingPurpose: 'embedding' });
    expect(button('Test Text embedding').className).toBe(idleClass);
    expect(button('Test Text embedding').textContent).toBe('Testing');
    expect(button('Test Text embedding').disabled).toBe(true);
    expect(button('Test Image understanding').disabled).toBe(true);
    expect(button('Configure Text embedding').disabled).toBe(true);
  });

  test('a click keeps untested status until the parent supplies the test result', async () => {
    const original = row('embedding', { configuration: 'configured', canTest: true });
    let requests = 0;
    await render([original], { onTest: () => { requests += 1; } });
    await act(async () => button('Test Text embedding').click());
    expect(requests).toBe(1);
    expect(host.querySelector('[data-model-purpose="embedding"]')?.textContent).toContain('Not tested');
    await render([{ ...original, test: 'verified', testedAt: '2026-10-23T04:05:00Z' }]);
    expect(host.querySelector('[data-model-purpose="embedding"]')?.textContent).toContain('Passed');
    expect(host.querySelector('[data-model-test="embedding"]')?.getAttribute('title')).toContain('2026');
    await render([{ ...original, test: 'failed', testedAt: '2026-10-23T04:06:00Z', errorCode: 'model_configuration_provider_http_401' }]);
    expect(host.querySelector('[data-model-test="embedding"]')?.getAttribute('title')).toContain('API key');
    expect(host.querySelector('[data-model-purpose="embedding"]')?.textContent).toContain('Fault');
  });

  test('request errors show a visible safe message without presenting a provider fault', async () => {
    await render([row('embedding', { configuration: 'configured', test: 'unknown', canTest: true })], { error: { purpose: 'embedding', code: 'model_configuration_provider_unreachable' } });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Text embedding');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not reach');
    expect(host.querySelector('[data-model-purpose="embedding"]')?.textContent).toContain('Unknown');
    await render([row('embedding')], { error: { purpose: 'embedding', code: 'untrusted-provider-message-secret' } });
    expect(host.textContent).not.toContain('untrusted-provider-message-secret');
  });

  test('Chinese labels update without losing the model names or action targets', async () => {
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    const configured: ModelPurposeId[] = [];
    await render([row('embedding', { configuration: 'configured', test: 'verified', model: 'text-embedding-v4', canTest: true })], { onConfigure: (purpose) => configured.push(purpose) });
    expect(host.textContent).toContain('文本 embedding');
    expect(host.textContent).toContain('text-embedding-v4');
    expect(host.textContent).toContain('正常');
    await act(async () => button('设置文本 embedding').click());
    expect(configured).toEqual(['embedding']);
    expect(host.textContent).not.toContain('Needs setup');
  });
});
