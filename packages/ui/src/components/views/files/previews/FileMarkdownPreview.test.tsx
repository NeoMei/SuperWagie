import { afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { FileMarkdownPreview } = await import('./FileMarkdownPreview');
import type { SimpleMarkdownRendererProps } from '@/components/chat/MarkdownRendererImpl';
let root: Root | null = null;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = null; });
test('cold Markdown and Mermaid file imports recover manually without remounting a sibling draft or reloading', async () => {
  await useI18nStore.getState().setLocale('en');
  const reload = spyOn(dom.location, 'reload');
  try {
    for (const content of ['# 预算', '```mermaid\ngraph TD; A-->B\n```']) {
      host = document.createElement('div'); document.body.append(host); root = createRoot(host);
      let attempts = 0;
      const loadRenderer = async () => {
        if (++attempts === 1) throw new Error('Failed to fetch dynamically imported module');
        return { default: ({ content: value }: SimpleMarkdownRendererProps) => <article>{value}</article> };
      };
      await act(async () => root?.render(<I18nProvider><input defaultValue="unsaved draft" /><FileMarkdownPreview content={content} loadRenderer={loadRenderer} /></I18nProvider>));
      const draft = host.querySelector('input');
      if (!draft) throw new Error('draft did not mount');
      draft.value = 'typed while preview failed';
      expect(host.textContent).toContain('Preview unavailable');
      await act(async () => host.querySelector('button')?.click());
      expect(host.querySelector('article')?.textContent).toBe(content);
      expect(host.querySelector('input')).toBe(draft);
      expect(draft.value).toBe('typed while preview failed');
      expect(attempts).toBe(2);
      expect(reload).not.toHaveBeenCalled();
      await act(async () => root?.unmount()); host.remove(); root = null;
    }
  } finally { reload.mockRestore(); }
});
