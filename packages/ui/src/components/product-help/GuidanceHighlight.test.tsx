import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  Event: browser.Event, MutationObserver: browser.MutationObserver,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json([]));
const { createRoot } = await import('react-dom/client');
const { GuidanceHighlight } = await import('./GuidanceHighlight');
const { useProductHelpGuidanceStore: guide } = await import('@/lib/product-help/guidance-store');
const { useUIStore: ui } = await import('@/stores/useUIStore');
let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  guide.getState().stop(); ui.getState().setSettingsDialogOpen(false);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<GuidanceHighlight />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  guide.getState().stop(); ui.getState().setSettingsDialogOpen(false);
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('guidance shell lifecycle', () => {
  for (const state of ['active', 'unavailable', 'completed'] as const) {
    test(`programmatic Settings close stops a ${state} guide`, async () => {
      await act(async () => guide.getState().start('appearance', 'guide'));
      if (state === 'unavailable') {
        const session = guide.getState().session;
        if (!session) throw new Error('Missing session');
        await act(async () => guide.getState().markUnavailable(session.requestId, 'hidden'));
      } else if (state === 'completed') {
        await act(async () => {
          guide.getState().reportAction(guide.getState().beginAction('appearance.language.opened'), 'complete');
          guide.getState().reportAction(guide.getState().beginAction('appearance.language.changed'), 'complete');
        });
        expect(guide.getState().session?.status).toBe('completed');
      }
      expect(ui.getState().isSettingsDialogOpen).toBe(true);
      await act(async () => ui.getState().setSettingsDialogOpen(false));
      expect(guide.getState().session).toBeNull();
      await act(async () => ui.getState().setSettingsDialogOpen(true));
      expect(guide.getState().session).toBeNull();
    });
  }
});
