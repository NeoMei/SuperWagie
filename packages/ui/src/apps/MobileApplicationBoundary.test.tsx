import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
const { MobileApplicationBoundary } = await import(process.env.OC_PILOT_ENTRY_MODULE || './MobileApplicationBoundary');
import { I18nProvider } from '@/lib/i18n';
import { useI18nStore } from '@/lib/i18n/store';

test('actual mobile entry exposes only the authenticated selected-material root and keeps full mobile and Capacitor blocked', async () => {
  const dom = new Window({ url: 'http://mobile-entry.test/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element,
    Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  useI18nStore.getState().setLocale('en');
  const requests: string[] = [];
  const pending: Array<{ projectId: string; finish: (response: Response) => void }> = [];
  const session = { status: 'signed-in', user: { id: 'owner', name: 'Owner', email: 'owner@example.test' },
    expiresAt: '2099-01-01T00:00:00.000Z', accounts: [{ id: 'personal', name: 'Personal' }], accountId: 'personal' };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = new URL(String(input instanceof Request ? input.url : input), 'http://mobile-entry.test');
    requests.push(target.pathname + target.search);
    if (target.pathname === '/auth/session') return Response.json({ authenticated: true });
    if (target.pathname === '/auth/passkeys/status') return Response.json({ enabled: false, registered: false });
    if (target.pathname === '/api/mobile-official/auth/session') return Response.json(session);
    if (target.pathname === '/api/mobile-official/auth/logout') return Response.json({ status: 'signed-out' });
    if (target.pathname === '/api/mobile-official/reader/projects') return Response.json({ projects: [{ id: 'a', name: 'Project A' }, { id: 'b', name: 'Project B' }] });
    if (target.pathname === '/api/mobile-official/reader') return new Promise<Response>((finish) => pending.push({ projectId: target.searchParams.get('projectId') ?? '', finish }));
    throw new Error(`Unexpected business request: ${target.pathname}`);
  });
  let fullApplicationMounts = 0;
  const FullApplication = () => { fullApplicationMounts++; return <main>Full mobile business app</main>; };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const render = (search: string, native = false) => root.render(<I18nProvider><MobileApplicationBoundary native={native} search={search}><FullApplication /></MobileApplicationBoundary></I18nProvider>);
  const flush = async () => { for (let index = 0; index < 3; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const selection = (projectId: string, title: string) => ({ id: crypto.randomUUID(), projectId, projectName: `Project ${projectId}`,
    extensionId: 'openchamber-builtin-creation', sessionId: null, createdAt: 1, revision: 'a'.repeat(64),
    source: { kind: 'artifact', path: 'sample.md' }, card: { title }, preview: { kind: 'unavailable', contentType: 'text/plain', byteLength: 0 } });
  try {
    await act(async () => render('')); await flush();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('?view=official');
    expect(container.textContent).toContain('not supported');
    expect(requests.some((target) => target.startsWith('/api/mobile-official'))).toBe(false);
    await act(async () => render('?view=official&projectId=a')); await flush();
    expect(pending.map((entry) => entry.projectId)).toEqual(['a']);
    expect(fullApplicationMounts).toBe(0);
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Project B')?.click(); }); await flush();
    expect(pending.map((entry) => entry.projectId)).toEqual(['a', 'b']);
    await act(async () => { pending[0].finish(Response.json({ state: 'ready', selections: [selection('a', 'Retired A title')] })); pending[1].finish(Response.json({ error: 'offline' }, { status: 503 })); }); await flush();
    expect(container.textContent).not.toContain('Retired A title');
    expect(container.textContent).toContain('Could not read');
    expect(container.textContent).not.toContain('No material has been selected');
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Project A')?.click(); }); await flush();
    await act(async () => pending[2].finish(Response.json({ state: 'ready', selections: [selection('a', 'Current selected title')] }))); await flush();
    expect(container.textContent).toContain('Current selected title');
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Sign out')?.click(); }); await flush();
    expect(container.textContent).not.toContain('Current selected title');
    expect(container.querySelector('#mobile-official-username')).not.toBeNull();
    expect(requests.every((target) => target.startsWith('/auth/') || target.startsWith('/api/mobile-official'))).toBe(true);
    const beforeNative = requests.length;
    await act(async () => render('?view=official', true)); await flush();
    expect(container.textContent).toContain('not supported');
    expect(container.querySelector('a')).toBeNull();
    expect(requests.length).toBe(beforeNative);
    expect(fullApplicationMounts).toBe(0);
  } finally {
    await act(async () => root.unmount()); fetch.mockRestore(); await dom.happyDOM.close();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
