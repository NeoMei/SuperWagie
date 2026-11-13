import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
const { attachToMainComposerDraft, usePublishMainComposerDraftTarget } = await import('../mainComposerDraftTarget');
let root: Root | null = null;
let host: HTMLDivElement;
const directory = '/repo';
const draft: Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'> = { source: 'file-quote', fileLabel: 'budget.csv · CSV · B3:C5', startLine: 0, endLine: 0, code: '[["42"]]', language: 'json', text: '' };
function ComposerOwner({ sessionKey, enabled = true }: { sessionKey: string; enabled?: boolean }) {
  const target = React.useMemo(() => ({ directory, sessionKey }), [sessionKey]);
  usePublishMainComposerDraftTarget(target, getRuntimeKey(), enabled);
  return <input defaultValue="unsaved visible composer" />;
}
async function render(sessionKey: string, enabled = true) {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root?.render(<ComposerOwner sessionKey={sessionKey} enabled={enabled} />));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = null; useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} }); });
test('attaches to published normal, materialized BTW, pending BTW and new-session draft targets', async () => {
  for (const sessionKey of ['parent', 'btw-child', 'btw-pending:parent', 'draft']) {
    await render(sessionKey);
    expect(attachToMainComposerDraft(getRuntimeKey(), directory, draft)).toBe(true);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey })).toHaveLength(1);
  }
  expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: 'parent' })).toHaveLength(1);
});
test('unresolved, pinned/disabled and retired runtime scopes refuse attachment', async () => {
  expect(attachToMainComposerDraft(getRuntimeKey(), directory, draft)).toBe(false);
  await render('parent');
  expect(attachToMainComposerDraft(getRuntimeKey(), '/other-project', draft)).toBe(false);
  await render('pinned', false);
  expect(attachToMainComposerDraft(getRuntimeKey(), directory, draft)).toBe(false);
  await render('parent');
  const original = getRuntimeKey();
  switchRuntimeEndpoint({ apiBaseUrl: 'http://another-runtime.test', runtimeKey: 'other-runtime' });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: original });
  expect(attachToMainComposerDraft(original, directory, draft)).toBe(false);
});

test('an obsolete publisher cleanup cannot erase a newer composer, and unmount retires it', async () => {
  await render('old-owner');
  const newerHost = document.createElement('div'); document.body.append(newerHost);
  const newerRoot = createRoot(newerHost);
  try {
    await act(async () => newerRoot.render(<ComposerOwner sessionKey="new-owner" />));
    await act(async () => root?.unmount()); root = null;
    expect(attachToMainComposerDraft(getRuntimeKey(), directory, draft)).toBe(true);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: 'new-owner' })).toHaveLength(1);
    await act(async () => newerRoot.unmount());
    expect(attachToMainComposerDraft(getRuntimeKey(), directory, draft)).toBe(false);
  } finally { await act(async () => newerRoot.unmount()); newerHost.remove(); }
});
