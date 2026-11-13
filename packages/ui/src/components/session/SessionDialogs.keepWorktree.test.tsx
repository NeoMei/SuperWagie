import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';

// The real dialog, providers and controls run here. Only native operations are replaced.
test.each(['desktop', 'mobile'] as const)('%s keep option is explicit and retains session tabs', async (surface) => {
  const dom = new Window({ url: 'http://localhost/?surface=desktop' });
  dom.happyDOM.setWindowSize({ width: surface === 'desktop' ? 1200 : 390, height: 844 });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Document: dom.Document, Text: dom.Text, Range: dom.Range,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { OpenCode } = await import('@opencode/client');
  const { SessionDialogs } = await import('./SessionDialogs');
  const { MobileDeleteWorktreeDialog } = await import('@/apps/MobileDeleteWorktreeDialog');
  const retention = await import('@/lib/worktrees/worktreeRetention');
  const status = await import('@/lib/worktrees/worktreeStatus');
  const tabs = await import('@/lib/sessionTabs');
  const { sessionEvents } = await import('@/lib/sessionEvents');
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const worktree: WorktreeMetadata = { path: '/fixture-worktree', projectDirectory: '/fixture-project', branch: 'feature', label: 'Feature', worktreeStatus: 'ready' };
  const sessions: Session[] = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index}`, title: `Conversation ${index}`, parentID: index > 0 ? 's0' : undefined,
    directory: worktree.path, projectID: 'fixture-project', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }));
  const preview = spyOn(retention, 'readWorktreeSessions').mockResolvedValue(sessions);
  const keep = spyOn(retention, 'moveWorktreeSessionsThenRemove').mockResolvedValue({ removed: true, movedIds: sessions.map((session) => session.id) });
  const inspect = spyOn(status, 'getWorktreeStatus').mockResolvedValue({ isDirty: false, ahead: 0, upstream: 'origin/feature' });
  const leave = spyOn(tabs, 'leaveFinishedSessions');
  const archive = spyOn(useSessionUIStore.getState(), 'archiveSessions');
  useProjectsStore.setState({ projects: [{ id: 'fixture-project', path: '/fixture-project', label: 'Fixture', addedAt: 1, lastOpenedAt: 1 }], activeProjectId: 'fixture-project' });
  await useI18nStore.getState().setLocale('en');
  const apis = createWebAPIs();
  const sdk = OpenCode.make({ baseUrl: 'http://fixture.test', fetch: () => new Promise<Response>(() => {}) });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  try {
    await act(async () => root.render(<SyncProvider sdk={sdk} directory="/fixture-project"><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={apis}>
      {surface === 'desktop' ? <SessionDialogs /> : <MobileDeleteWorktreeDialog open project={{ id: 'fixture-project', path: '/fixture-project' }} worktree={worktree} onClose={() => {}} />}
    </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></SyncProvider>));
    if (surface === 'desktop') await act(async () => sessionEvents.requestDelete({ mode: 'worktree', worktree, sessions: [sessions[0]] }));
    await flush();
    const option = button('Keep sessions in the project');
    expect(option).toBeDefined();
    expect(option?.getAttribute('aria-pressed')).toBe('false');
    expect(keep).not.toHaveBeenCalled();
    await act(async () => option?.click());
    await flush();
    expect(option?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('Conversation 7');
    expect(document.body.textContent).toContain('Subsession of Conversation 0');
    const remove = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Delete worktree' || item.textContent?.trim() === 'Remove worktree' || item.textContent?.trim() === 'Remove');
    expect(remove).toBeDefined();
    await act(async () => remove?.click());
    await flush();
    expect(keep).toHaveBeenCalledTimes(1);
    expect(keep.mock.calls[0]?.[0]).toMatchObject({ worktreePath: '/fixture-worktree', projectDirectory: '/fixture-project' });
    expect(archive).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    for (const spy of [preview, keep, inspect, leave, archive]) spy.mockRestore();
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom.happyDOM.close();
  }
}, 10_000);
