import { afterEach, expect, test } from 'bun:test';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true });
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { MarkdownOutlineMenu } = await import('./MarkdownOutlineMenu');
let root: Root | null = null;
let host: HTMLDivElement;
const containerRef = createRef<HTMLDivElement>();
const render = async (identity: string, children: React.ReactNode) => {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><div ref={containerRef}>{children}</div><MarkdownOutlineMenu key={identity} containerRef={containerRef} /></I18nProvider>));
};
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = null; });
test('duplicate Chinese headings target their own rendered node and switching to a titleless file clears the outline', async () => {
  await render('one', <><h1>预算</h1><h2>明细</h2><h1>预算</h1></>);
  const headings = Array.from(containerRef.current?.querySelectorAll('h1,h2') ?? []);
  let target: Element | null = null;
  for (const heading of headings) heading.scrollIntoView = () => { target = heading; };
  await act(async () => host.querySelector('button')?.click());
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  expect(items.map((item) => item.textContent)).toEqual(['预算', '明细', '预算']);
  await act(async () => items[2].click());
  expect(target).toBe(headings[2]);
  await render('two', <p>No title</p>);
  await act(async () => host.querySelector('button')?.click());
  expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('This file has no headings.');
});
