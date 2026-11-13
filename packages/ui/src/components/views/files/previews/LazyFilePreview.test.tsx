import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { LazyFilePreview } = await import('./LazyFilePreview');
let root: Root | null = null;
let container: HTMLDivElement;
const render = async (identity: string, load: () => Promise<{ default: React.ComponentType<{ name: string }> }>) => {
  if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  await useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><div>chat draft</div><LazyFilePreview key={identity} load={load} previewProps={{ name: identity }} /></I18nProvider>));
};
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = null; });
const Good = ({ name }: { name: string }) => <div>ready {name}</div>;
describe('file preview failure ownership', () => {
  test('a rejected module retries with a new lazy component and retains its sibling', async () => {
    let attempts = 0;
    const load = async () => { if (++attempts === 1) throw new Error('module unavailable'); return { default: Good }; };
    await render('one', load);
    expect(container.textContent).toContain('Preview unavailable');
    expect(container.textContent).toContain('chat draft');
    await act(async () => container.querySelector('button')?.click());
    expect(attempts).toBe(2);
    expect(container.textContent).toContain('ready one');
  });
  test('a render failure stays local and cannot cover the next file or runtime', async () => {
    const Broken = () => { throw new Error('renderer failed'); };
    await render('runtime-a/broken', async () => ({ default: Broken }));
    expect(container.textContent).toContain('Preview unavailable');
    await render('runtime-b/good', async () => ({ default: Good }));
    expect(container.textContent).toContain('ready runtime-b/good');
    expect(container.textContent).not.toContain('Preview unavailable');
  });
});
