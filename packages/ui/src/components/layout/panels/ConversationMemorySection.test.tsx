import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { ConversationMemoryEntry, ConversationMemoryStatus } from '@/lib/conversationMemory';

const browser = new Window({ url: 'http://memory.test/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, location: browser.location,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, KeyboardEvent: browser.KeyboardEvent,
  HTMLInputElement: browser.HTMLInputElement, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../../web/src/api/index');
const { peekMessageFocus, settleMessageFocus } = await import('@/lib/router/messageFocus');
const { ConversationMemorySection } = await import('./ConversationMemorySection');
const apis = createWebAPIs();
const initialStatus: ConversationMemoryStatus = { enabled: false, state: 'off', pending: 0, failed: 0, unknown: 0, entries: 1, lastError: null };
const initialEntry: ConversationMemoryEntry = {
  id: 'entry_1', kind: 'experience', title: 'Fixture experience', body: 'The fixture observed a passing check.',
  status: 'candidate', indexState: 'failed', verification: 'unverified', sessionId: 'ses_source', projectId: 'project',
  createdAt: 1, updatedAt: 2, sourceMessageIds: ['msg_source'], limitations: ['Only a fixture.'],
};
let host: HTMLDivElement;
let root: Root;
let fetchFixture: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let currentStatus: ConversationMemoryStatus;
let entries: ConversationMemoryEntry[];
let calls: Array<{ path: string; method: string; body: string; query: URLSearchParams }>;
let failure: string | null;
let forgetPending: (() => void) | null;
let deferForget: boolean;

const render = async (directory = '/project', isVSCode = false, visible = true) => {
  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={{ ...apis, runtime: { ...apis.runtime, isVSCode } }}>
      <I18nProvider><ConversationMemorySection directory={directory} sessionId="ses_current" visible={visible} /></I18nProvider>
    </RuntimeAPIContext.Provider>,
  ));
};
const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
const click = async (text: string) => act(async () => button(text).click());

beforeEach(() => {
  useI18nStore.getState().setLocale('en');
  currentStatus = { ...initialStatus };
  entries = [{ ...initialEntry }];
  calls = [];
  failure = null;
  forgetPending = null;
  deferForget = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    calls.push({ path: url.pathname, method, body: String(init?.body ?? ''), query: url.searchParams });
    if (failure) return Response.json({ error: failure }, { status: 503 });
    if (url.pathname.endsWith('/status')) return Response.json(currentStatus);
    if (url.pathname.endsWith('/settings')) {
      currentStatus = { ...currentStatus, enabled: true, state: 'ready' };
      return Response.json(currentStatus);
    }
    if (url.pathname.endsWith('/confirm')) {
      entries = entries.map((entry) => ({ ...entry, status: 'active' }));
      return Response.json({ entry: entries[0] });
    }
    if (method === 'DELETE') {
      if (deferForget) await new Promise<void>((resolve) => { forgetPending = resolve; });
      entries = [{ ...initialEntry, status: 'forgotten', indexState: 'pending' }];
      return Response.json({ forgotten: true, pendingCleanup: true });
    }
    if (method === 'POST') return Response.json({ queued: true });
    if (url.pathname.endsWith('/entries')) return Response.json({ entries });
    return Response.json({ error: 'unhandled_fixture' }, { status: 404 });
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  fetchFixture.mockRestore();
  host.remove();
  for (const sessionId of ['ses_source', 'ses_independent']) {
    const focus = peekMessageFocus(sessionId);
    if (focus) settleMessageFocus(focus);
  }
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('conversation memory management', () => {
  test('reads the disabled server state and enables only after explicit selection', async () => {
    await render();
    expect(calls.some((call) => call.method !== 'GET')).toBe(false);
    const toggle = host.querySelector<HTMLElement>('[data-settings-item="knowledge-library.conversation-memory-enabled"] [role="button"]')
      ?? host.querySelector<HTMLElement>('[data-settings-item="knowledge-library.conversation-memory-enabled"][role="button"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(button('Process current session').disabled).toBe(true);
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(calls.find((call) => call.method === 'PUT')?.body).toBe('{"enabled":true}');
    await click('Process current session');
    expect(calls.find((call) => call.path.endsWith('/capture'))?.body).toBe('{"sessionId":"ses_current","directory":"/project"}');
    expect(host.textContent).toContain('History queued');
  });

  test('shows candidate evidence, confirms without claiming verification and opens the exact source', async () => {
    currentStatus = { ...initialStatus, enabled: true, state: 'ready' };
    await render();
    await click('Fixture experience');
    expect(host.textContent).toContain(initialEntry.body);
    expect(host.textContent).toContain('Unverified');
    await click('Make active');
    expect(host.textContent).toContain('Active');
    expect(host.textContent).toContain('Unverified');
    await click('Source msg_source');
    expect(peekMessageFocus('ses_source')?.messageId).toBe('msg_source');
    await click('Retry indexing');
    expect(calls.some((call) => call.path.endsWith('/retry') && call.body.includes('entry_1'))).toBe(true);
  });

  test('removes an entry only after the forget acknowledgment and keeps cleanup retry visible', async () => {
    currentStatus = { ...initialStatus, enabled: true, state: 'ready' };
    await render();
    await click('Fixture experience');
    await click('Forget');
    deferForget = true;
    await click('Forget entry');
    expect(host.textContent).toContain('Fixture experience');
    expect(forgetPending).not.toBeNull();
    await act(async () => forgetPending?.());
    expect([...host.querySelectorAll('button[aria-expanded]')].some((item) => item.textContent?.includes('Fixture experience'))).toBe(false);
    expect(host.textContent).toContain('Cleanup pending');
    await click('Retry cleanup');
    expect(calls.some((call) => call.path.endsWith('/retry'))).toBe(true);
  });

  test('preserves visible results on refresh failure and hides the feature in VS Code', async () => {
    await render();
    failure = 'index_unavailable';
    await click('Refresh');
    expect(host.textContent).toContain('Fixture experience');
    expect(host.textContent).toContain('index_unavailable');
    await render('/project', true);
    expect(host.textContent).toBe('');
  });

  test('shows separate review and blocked counts, engine health and actionable entry failures', async () => {
    currentStatus = {
      ...initialStatus, enabled: true, state: 'unavailable', entries: 3, candidates: 2, blocked: 1, failed: 0,
      engine: { name: 'hy-memory', state: 'unavailable', error: 'hy_runtime_not_installed', version: '2.0.8' },
    };
    entries = [{ ...initialEntry, error: 'embedding_failed' }];
    await render();
    expect(host.textContent).toContain('hy-memory');
    expect(host.textContent).toContain('2.0.8');
    expect(host.textContent).toContain('Candidates 2');
    expect(host.textContent).toContain('Blocked 1');
    expect(host.textContent).toContain('Failed jobs 0');
    expect(host.textContent).toContain('Update or reinstall the app');
    expect(host.textContent).toContain('Check the embedding model settings');
    await click('Fixture experience');
    expect(host.textContent).toContain('Candidate');
    expect(button('Retry indexing').disabled).toBe(false);
  });

  test('aborts the old scope and ignores its late data when the project changes', async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    fetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
      if (url.pathname.endsWith('/status')) return Response.json(initialStatus);
      if (url.searchParams.get('directory') === '/old') return new Promise<Response>((resolve) => { resolveOld = resolve; });
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ entries: [{ ...initialEntry, title: 'New project entry' }] });
    });
    await render('/old');
    await render('/new');
    await act(async () => resolveOld?.(Response.json({ entries: [initialEntry] })));
    expect(host.textContent).toContain('New project entry');
    expect(host.textContent).not.toContain('Fixture experience');
  });
});

test('the knowledge panel exposes experiences while the document backend is unavailable', async () => {
  const { KnowledgeLibraryPanel } = await import('./KnowledgeLibraryPanel');
  fetchFixture.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    if (url.pathname.startsWith('/api/conversation-memory/')) {
      return Response.json(url.pathname.endsWith('/status') ? initialStatus : { entries: [] });
    }
    if (url.pathname.endsWith('/status')) return Response.json({ supported: true, enabled: false, provisioned: false, backend: { state: 'stopped', port: 8877 } });
    if (url.pathname.endsWith('/libraries')) return Response.json({ libraries: [] });
    return Response.json({ documents: [], total: 0 });
  });
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><KnowledgeLibraryPanel /></I18nProvider></RuntimeAPIContext.Provider>));
  const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((entry) => entry.textContent?.trim() === 'Experiences');
  expect(Boolean(tab)).toBe(true);
  await act(async () => tab?.click());
  expect(host.textContent).toContain('Learn from new conversations');
  expect(host.textContent).not.toContain('Disabled in the saved settings');
});

test('the knowledge settings expose server learning on web while desktop backend controls remain desktop-only', async () => {
  const { KnowledgeLibrarySettings } = await import('@/components/sections/openchamber/KnowledgeLibrarySettings');
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><KnowledgeLibrarySettings /></I18nProvider></RuntimeAPIContext.Provider>));
  expect(host.textContent).toContain('Conversation learning');
  expect(host.querySelector('[data-settings-item="knowledge-library.backend"]') === null).toBe(true);
});

test('a degraded document search shows unavailable semantic retrieval without claiming an empty match', async () => {
  const { KnowledgeLibraryPanel } = await import('./KnowledgeLibraryPanel');
  fetchFixture.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    if (url.pathname.endsWith('/status')) return Response.json({ supported: true, enabled: true, provisioned: true, backend: { state: 'running', port: 8877 } });
    if (url.pathname.endsWith('/libraries')) return Response.json({ libraries: [] });
    if (url.pathname.endsWith('/search')) return Response.json({ query: 'retry', documents: [], passages: [], availability: { state: 'degraded', reason: 'semantic_unavailable' } });
    return Response.json({ documents: [], total: 0 });
  });
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><KnowledgeLibraryPanel /></I18nProvider></RuntimeAPIContext.Provider>));
  const input = host.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error('Missing document search');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, 'retry');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(host.textContent).toContain('Content search is unavailable');
  expect(host.textContent).not.toContain('Nothing matched.');
});

test('a failed document search preserves its last results and reports the stale result state', async () => {
  const { KnowledgeLibraryPanel } = await import('./KnowledgeLibraryPanel');
  let failSearch = false;
  fetchFixture.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    if (url.pathname.endsWith('/status')) return Response.json({ supported: true, enabled: true, provisioned: true, backend: { state: 'running', port: 8877 } });
    if (url.pathname.endsWith('/libraries')) return Response.json({ libraries: [] });
    if (url.pathname.endsWith('/search')) return failSearch ? Response.json({ error: 'search_unavailable' }, { status: 503 }) : Response.json({ query: 'retry', passages: [], documents: [{
      documentId: 'doc_1', title: 'Retry guide', path: '/library/retry.md', relPath: 'retry.md', libraryId: 'library', fileType: 'md', size: 32, parseStatus: 'completed', matched: 'name',
    }] });
    return Response.json({ documents: [], total: 0 });
  });
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><KnowledgeLibraryPanel /></I18nProvider></RuntimeAPIContext.Provider>));
  const input = host.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error('Missing document search');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  const search = async (value: string) => {
    await act(async () => {
      setValue?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  };
  await search('retry');
  expect(host.textContent).toContain('Retry guide');
  failSearch = true;
  await search('recover');
  expect(host.textContent).toContain('Retry guide');
  expect(host.textContent).toContain('Showing the last search results');
  expect(host.textContent).not.toContain('Nothing matched.');
});

test('search sends the full project query and keeps the existing list when search fails', async () => {
  await render();
  const input = host.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error('Missing experience search');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, 'observed retry');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  failure = 'search_unavailable';
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
  expect(calls.some((call) => call.query.get('directory') === '/project' && call.query.get('query') === 'observed retry')).toBe(true);
  expect(host.textContent).toContain('Fixture experience');
  expect(host.textContent).toContain('search_unavailable');
});

test('a failed settings write preserves the authoritative switch', async () => {
  await render();
  failure = 'settings_unavailable';
  const toggle = host.querySelector<HTMLElement>('[data-settings-item="knowledge-library.conversation-memory-enabled"][role="button"]');
  await act(async () => toggle?.click());
  expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  expect(host.textContent).toContain('settings_unavailable');
});

test('a runtime switch aborts pending reads and shows only the next runtime', async () => {
  let onNewRuntime = false;
  let resolveOld: ((response: Response) => void) | undefined;
  let oldSignal: AbortSignal | null | undefined;
  fetchFixture.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    if (url.pathname.endsWith('/status')) return Response.json(initialStatus);
    if (!onNewRuntime) {
      oldSignal = init?.signal;
      return new Promise<Response>((resolve) => { resolveOld = resolve; });
    }
    return Response.json({ entries: [{ ...initialEntry, title: 'Next runtime experience' }] });
  });
  await render();
  await act(async () => {
    window.dispatchEvent(new Event('openchamber:runtime-endpoint-will-change'));
    onNewRuntime = true;
    window.dispatchEvent(new Event('openchamber:runtime-endpoint-changed'));
  });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => resolveOld?.(Response.json({ entries: [initialEntry] })));
  expect(host.textContent).toContain('Next runtime experience');
  expect(host.textContent).not.toContain('Fixture experience');
});

test('methodology proposals require active experiences from independent sessions', async () => {
  currentStatus = { ...initialStatus, enabled: true, state: 'ready' };
  entries = [{ ...initialEntry, status: 'active' }, { ...initialEntry, id: 'entry_2', status: 'active' }];
  await render();
  expect([...host.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Propose methodology')).toBe(false);
  entries = [entries[0]!, { ...entries[1]!, sessionId: 'ses_independent' }];
  await click('Refresh');
  await click('Propose methodology');
  expect(calls.find((call) => call.path.endsWith('/consolidate'))?.body).toBe('{"directory":"/project","entryIds":["entry_1","entry_2"]}');
  expect(host.textContent).toContain('Methodology proposal queued');
});

test('hiding the section drops in-flight work and reopening reads fresh status', async () => {
  let resolveOld: ((response: Response) => void) | undefined;
  let onReopen = false;
  let requestCount = 0;
  fetchFixture.mockImplementation(async (input) => {
    requestCount += 1;
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    if (url.pathname.endsWith('/status')) return Response.json(initialStatus);
    if (!onReopen) return new Promise<Response>((resolve) => { resolveOld = resolve; });
    return Response.json({ entries: [{ ...initialEntry, title: 'Reopened experience' }] });
  });
  await render();
  await render('/project', false, false);
  const hiddenCount = requestCount;
  await act(async () => resolveOld?.(Response.json({ entries: [initialEntry] })));
  expect(host.textContent).not.toContain('Fixture experience');
  expect(requestCount).toBe(hiddenCount);
  onReopen = true;
  await render();
  await act(async () => resolveOld?.(Response.json({ entries: [initialEntry] })));
  expect(host.textContent).toContain('Reopened experience');
  expect(host.textContent).not.toContain('Fixture experience');
});

test('methodology sources open each original session and proposals stay within the server limit', async () => {
  entries = [{ ...initialEntry, kind: 'methodology', sourceReferences: [
    { sessionId: 'ses_source', messageId: 'msg_source' },
    { sessionId: 'ses_independent', messageId: 'msg_independent' },
  ] }];
  await render();
  await click('Fixture experience');
  await click('Source msg_independent');
  expect(peekMessageFocus('ses_independent')?.messageId).toBe('msg_independent');
  currentStatus = { ...initialStatus, enabled: true, state: 'ready' };
  entries = Array.from({ length: 12 }, (_, index): ConversationMemoryEntry => ({ ...initialEntry, id: `entry_${index}`, sessionId: `ses_${index}`, status: 'active' }));
  await click('Refresh');
  await click('Propose methodology');
  const proposal = calls.find((call) => call.path.endsWith('/consolidate'));
  expect(JSON.parse(proposal?.body ?? '{}').entryIds).toHaveLength(10);
});

test('reopening during an old settings write accepts a fresh server snapshot', async () => {
  let resolveSave: ((response: Response) => void) | undefined;
  fetchFixture.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    if (init?.method === 'PUT') return new Promise<Response>((resolve) => { resolveSave = resolve; });
    return Response.json(url.pathname.endsWith('/status') ? currentStatus : { entries: [initialEntry] });
  });
  await render();
  const toggle = () => host.querySelector<HTMLElement>('[data-settings-item="knowledge-library.conversation-memory-enabled"][role="button"]');
  await act(async () => toggle()?.click());
  await render('/project', false, false);
  currentStatus = { ...initialStatus, enabled: true, state: 'ready' };
  await render();
  await act(async () => resolveSave?.(Response.json(initialStatus)));
  expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
  expect(toggle()?.getAttribute('aria-disabled')).not.toBe('true');
});
