import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { WorkCategoryHeader } from './WorkCategoryHeader';

test('creation entries change language in place and keep the expanded state', async () => {
  const dom = new Window({ url: 'http://sidebar.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const previousLocale = useI18nStore.getState().locale;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let toggled = 0;
  try {
    await act(async () => {
      useI18nStore.getState().setLocale('en');
      root.render(<I18nProvider>{(['chat', 'doc', 'deck', 'video', 'page', 'projects'] as const).map((category) => (
        <WorkCategoryHeader key={category} category={category} collapsed={false} forceExpanded={false} onToggle={() => toggled++} />
      ))}</I18nProvider>);
    });
    expect(container.textContent).toContain('Write documents');
    expect(container.textContent).toContain('Make slides');
    expect(/\p{Script=Han}/u.test(container.textContent ?? '')).toBe(false);
    const newDoc = container.querySelector('button[aria-label="New document"]');
    expect(newDoc).not.toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      useI18nStore.getState().setLocale('zh-CN');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain('写文档');
    expect(container.textContent).toContain('做 PPT');
    expect(container.querySelector('button[aria-label="新建文档"]')).toBe(newDoc);
    expect(container.querySelector('button[aria-expanded]')).toBe(toggle);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle?.click());
    expect(toggled).toBe(1);
  } finally {
    await act(async () => root.unmount());
    useI18nStore.getState().setLocale(previousLocale);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
