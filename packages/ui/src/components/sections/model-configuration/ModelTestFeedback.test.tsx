import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ModelTestFeedback } = await import('./ModelTestFeedback');
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('ModelTestFeedback', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    useI18nStore.getState().setLocale('en');
    browser.happyDOM.settings.device.prefersReducedMotion = 'no-preference';
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  async function render(props: React.ComponentProps<typeof ModelTestFeedback>) {
    await act(async () => root.render(<I18nProvider><ModelTestFeedback {...props} /></I18nProvider>));
  }
  test('pending states describe the actual purpose and model without old result time or fabricated progress', async () => {
    const props = { purpose: 'image-generation' as const, model: 'image-model', testedAt: '2026-10-23T00:00:00Z' };
    await render({ ...props, status: 'queued' });
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Image generation connection test');
    expect(host.textContent).toContain('Awaiting test result');
    expect(host.textContent).toContain('A result for this model has not been reported yet.');
    expect(host.textContent).not.toContain('2026');
    expect(host.querySelector('[data-spinner]')).toBeNull();
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    await render({ ...props, status: 'testing' });
    expect(host.textContent).toContain('image-model');
    expect(host.textContent).toContain('Image generation can take longer.');
    expect(host.textContent).not.toContain('2026');
    expect(host.querySelector('[data-spinner]')).not.toBeNull();
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(/\d+\s*%/.test(host.textContent ?? '')).toBe(false);
  });
  test('confirmed results stop activity and only show safe error guidance and a valid result time', async () => {
    const props = { purpose: 'embedding' as const, model: 'embedding-model', testedAt: '2026-10-23T00:00:00Z' };
    await render({ ...props, status: 'verified' });
    expect(host.textContent).toContain('Connection test passed');
    expect(host.textContent).toContain('2026');
    expect(host.querySelector('[data-spinner]')).toBeNull();
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    await render({ ...props, status: 'failed', errorCode: 'model_configuration_provider_http_401' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('API key');
    expect(host.textContent).toContain('Connection test failed');
    expect(host.textContent).not.toContain('model_configuration_provider_http_401');
    await render({ ...props, status: 'failed', errorCode: 'private-provider-response', testedAt: 'not-a-date' });
    expect(host.textContent).not.toContain('private-provider-response');
    expect(host.textContent).not.toContain('Invalid Date');
  });
  test('unknown results stay distinct from failure and localize the accessible region', async () => {
    await render({ purpose: 'embedding', status: 'unknown', errorCode: 'transport-private-detail' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Test result not confirmed');
    expect(host.textContent).not.toContain('Connection test failed');
    expect(host.textContent).not.toContain('transport-private-detail');
    expect(host.querySelector('[data-spinner]')).toBeNull();
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('文本 embedding连通测试');
    expect(host.textContent).toContain('测试结果待确认');
  });
  test('changing reduced-motion preference pauses the shared clock and completion removes its subscribers', async () => {
    const preference = browser.matchMedia('(prefers-reduced-motion: reduce)');
    const media = spyOn(browser, 'matchMedia').mockReturnValue(preference);
    const intervals = spyOn(browser, 'setInterval');
    const clearIntervals = spyOn(browser, 'clearInterval');
    try {
      await render({ purpose: 'embedding', status: 'testing' });
      expect(intervals.mock.calls.some((args) => args[1] === 250)).toBe(true);
      const beforePause = clearIntervals.mock.calls.length;
      await act(async () => {
        browser.happyDOM.settings.device.prefersReducedMotion = 'reduce';
        preference.dispatchEvent(new browser.Event('change'));
      });
      expect(clearIntervals.mock.calls.length).toBeGreaterThan(beforePause);
      expect(host.querySelector('[data-spinner]')).not.toBeNull();
      const beforeResume = intervals.mock.calls.length;
      await act(async () => {
        browser.happyDOM.settings.device.prefersReducedMotion = 'no-preference';
        preference.dispatchEvent(new browser.Event('change'));
      });
      expect(intervals.mock.calls.length).toBeGreaterThan(beforeResume);
      const beforeComplete = clearIntervals.mock.calls.length;
      await render({ purpose: 'embedding', status: 'verified' });
      expect(clearIntervals.mock.calls.length).toBeGreaterThan(beforeComplete);
      expect(host.querySelector('[data-spinner]')).toBeNull();
    } finally { media.mockRestore(); intervals.mockRestore(); clearIntervals.mockRestore(); }
  });
});
