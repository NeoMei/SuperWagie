import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
  MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, Event: dom.Event,
  getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true });
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { getDefaultTheme } = await import('@/lib/theme/themes');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
const { tableQuoteDraft } = await import('@/components/views/files/previews/tableQuoteDraft');
const { formatContextText, contextPayloadFromDraft } = await import('@/lib/messages/contextParts');
const { ComposerContextChips } = await import('./ComposerContextChips');
let root: Root | null = null;
let host: HTMLDivElement;
let preview: HTMLDivElement;
const target = { directory: '/repo', sessionKey: 'btw-child' };
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); preview?.remove(); root = null; useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} }); });
test('composer inspection distinguishes two files at the same range and removing one excludes it from send consumption', async () => {
  await useI18nStore.getState().setLocale('en');
  const store = useInlineCommentDraftStore.getState();
  store.addDraft(target, tableQuoteDraft('budget.csv', '/private/project/budget.csv', { range: 'B3:C5', values: '[["first"]]' }));
  store.addDraft(target, tableQuoteDraft('forecast.tsv', '/private/project/forecast.tsv', { range: 'B3:C5', values: '[["second"]]' }));
  host = document.createElement('div'); preview = document.createElement('div'); document.body.append(host, preview); root = createRoot(host);
  await act(async () => root?.render(<I18nProvider><ComposerContextChips draftTarget={target} colors={getDefaultTheme(false).colors} previewHost={preview} /></I18nProvider>));
  await act(async () => host.querySelector('button')?.click());
  expect(preview.textContent).toContain('budget.csv · CSV · B3:C5');
  expect(preview.textContent).toContain('forecast.tsv · TSV · B3:C5');
  expect(preview.textContent).not.toContain('/private/project');
  await act(async () => preview.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')?.click());
  const remaining = store.getDrafts(target);
  await act(async () => { store.consumeDrafts(target); });
  expect(remaining).toHaveLength(1);
  const outgoing = formatContextText(contextPayloadFromDraft(remaining[0]));
  expect(outgoing).toContain('forecast.tsv · TSV · B3:C5');
  expect(outgoing).not.toContain('budget.csv');
  expect(outgoing).not.toContain('first');
});
