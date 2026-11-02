import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { ModelConfiguration } from '@/lib/modelConfiguration';
import type { ModelBootstrapClient } from '@/lib/modelConfigurationBootstrap';

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
