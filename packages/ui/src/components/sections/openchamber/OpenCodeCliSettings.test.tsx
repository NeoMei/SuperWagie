import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { OpenCodeCompatibility } from '@/lib/opencode/compatibility';
import type { OpenCodeUpgradeStatus } from '@/components/update/openCodeUpgrade';
import type { DesktopSettings } from '@/lib/settings/registry';

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

const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { invalidateSettingsCache } = await import('@/lib/persistence');
const { useUIStore } = await import('@/stores/useUIStore');
const { OpenCodeCliSettings } = await import('./OpenCodeCliSettings');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('OpenCodeCliSettings', () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchFixture: ReturnType<typeof spyOn> | null = null;
  beforeEach(() => {
    Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' }, configurable: true });
    useI18nStore.getState().setLocale('en');
    useUIStore.getState().setShowOpenCodeUpdateNotifications(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    fetchFixture?.mockRestore();
    fetchFixture = null;
    host.remove();
  });

  const render = async (
    settings: Partial<DesktopSettings>,
    compatibility: OpenCodeCompatibility,
    runtimeUpdate: OpenCodeUpgradeStatus['runtimeUpdate'] = null,
  ) => {
    invalidateSettingsCache();
    fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input), browser.location.href).pathname;
      if (path.endsWith('/api/config/settings')) return Response.json(settings);
      if (path.endsWith('/api/opencode/compatibility')) return Response.json(compatibility);
      if (path.endsWith('/api/opencode/upgrade-status')) return Response.json({
        available: false,
        currentVersion: compatibility.version,
        runtimeUpdate,
      });
      return Response.json({});
    });
    await act(async () => root.render(<I18nProvider><OpenCodeCliSettings /></I18nProvider>));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  };

  test('shows the bundled engine and updater ownership by default', async () => {
    await render({}, { state: 'compatible', version: '2.1.4', installation: 'bundled', canInstall: false });
    expect(host.textContent).toContain('OpenCode 2.1.4 is managed by SuperWagie and upgrades itself from official releases. It switches automatically when no conversation is running. Your system OpenCode is never used or changed.');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Use bundled OpenCode')).toBe(false);
  });

  test('marks a custom path as an explicit binding with a return action', async () => {
    await render({ opencodeBinary: '/opt/custom/opencode' }, { state: 'compatible', version: '2.1.4', installation: 'managed', canInstall: false });
    expect(host.textContent).toContain('SuperWagie uses this custom OpenCode until you return to the bundled engine. Other OpenCode installations are untouched.');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Use bundled OpenCode')).toBe(true);
  });

  test('shows a downloaded official runtime waiting for the current conversation to finish', async () => {
    await render(
      {},
      { state: 'compatible', version: '2.1.4', installation: 'bundled', canInstall: false },
      { status: 'installed', latestVersion: '2.1.5', installedVersion: '2.1.5', packagedVersion: '2.1.4', restartRequired: true },
    );
    expect(host.textContent).toContain('OpenCode 2.1.5 is downloaded and will switch in when the current conversation finishes.');
  });
});
