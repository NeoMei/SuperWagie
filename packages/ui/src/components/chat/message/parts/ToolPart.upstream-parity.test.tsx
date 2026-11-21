import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGuestsStore } from '@/lib/guests/store';

plugin({
  name: 'upstream-tool-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
    }));
  },
});
const { default: ToolPart } = await import('./ToolPart');
const { ShownToolCard } = await import('./ShownToolCard');

const part = (tool: string, state: ToolPartData['state']): ToolPartData => ({
  id: `part-${tool}`, messageID: 'message-parity', sessionID: 'session-parity',
  callID: `call-${tool}`, type: 'tool', tool, state,
});

const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
  reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
  isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
  lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
};

async function withPart(value: ToolPartData, expanded: boolean, check: (container: HTMLElement) => Promise<void> | void, shown = false) {
  const dom = new Window({ url: 'http://upstream-tool.test' });
  class EventSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    send() {}
    close() { this.readyState = 3; }
  }
  const globals = {
    WebSocket: EventSocket,
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Node: dom.Node, Text: dom.Text, NodeList: dom.NodeList, Element: dom.Element,
    HTMLElement: dom.HTMLElement, SVGElement: dom.SVGElement, CustomEvent: dom.CustomEvent,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    getComputedStyle: dom.getComputedStyle.bind(dom), ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    if (url.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json(path.endsWith('/session/active') ? {} : { data: [] });
  } });
  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  const previousGuests = useGuestsStore.getState();
  useDirectoryStore.setState({ currentDirectory: '/synthetic/parity' });
  useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
  try {
    await act(async () => root.render(<I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory="/synthetic/parity">{shown ? <ShownToolCard part={value} /> : <ToolPart part={value} isExpanded={expanded} isMobile={false} onToggle={() => {}} />}</SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>));
    await check(container);
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    useGuestsStore.setState(previousGuests);
    await dom.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('ordinary tool rows retain upstream presentation without extra status labels', async () => {
  await withPart(part('read', { status: 'completed', input: { path: 'readme.md' }, output: 'content', metadata: {}, time: { start: 1, end: 2 } }), false, (container) => {
    expect(container.querySelector('[data-tool-status]') === null).toBe(true);
  });
});

test('todo results render the recorded list and settled item styling', async () => {
  await withPart(part('todowrite', { status: 'completed', input: { todos: [
    { content: 'Inspect the stream', status: 'completed', priority: 'high' },
    { content: 'Retain command output', status: 'in_progress', priority: 'medium' },
  ] }, output: 'Updated plan', metadata: {}, time: { start: 1, end: 2 } }), true, (container) => {
    expect(container.querySelector('.line-through')?.textContent).toBe('Inspect the stream');
    expect(container.querySelectorAll('ul > li').length).toBe(2);
  });
});

test('an interrupted foreground shell retains partial output and removes the model-only notice', async () => {
  const notice = 'Full output saved at a model-only path';
  await withPart(part('shell', { status: 'error', input: { command: 'long-running-command' },
    error: `partial output\n\n${notice}`, metadata: { interrupted: true, notice }, time: { start: 1, end: 2 } }), true, (container) => {
    expect(container.textContent).toContain('partial output');
    expect(container.textContent).not.toContain(notice);
    expect(container.querySelector('[role="button"]')?.textContent).not.toContain('Failed');
  });
});


for (const tool of ['openchamber_image']) test(`an unsupported ${tool} card retains a readable tool row and result`, async () => {
  const output = 'The recorded result remains available';
  await withPart(part(tool, { status: 'completed', input: { action: 'request' }, output, metadata: {}, time: { start: 1, end: 2 } }), false, async (container) => {
    const toggle = container.querySelector<HTMLElement>('[role="button"]');
    expect(toggle !== null).toBe(true);
    await act(async () => toggle?.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(container.textContent).toContain(output);
  }, true);
});

test('a waiting secret request renders a private input card in the transcript', async () => {
  await withPart(part('openchamber_secret', {
    status: 'running',
    input: { action: 'request', label: 'API token', reason: 'Use it for this command', placeholder: 'Paste token' },
    metadata: {},
    time: { start: 1 },
  }), false, (container) => {
    expect(container.querySelector('[data-secret-request-status="waiting"]') !== null).toBe(true);
    expect(container.textContent).toContain('API token');
    expect(container.querySelector('input[type="password"]') !== null).toBe(true);
  }, true);
});
