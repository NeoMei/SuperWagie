import { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useGuestsStore } from '@/lib/guests/store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { applyBackgroundShellEvents, backgroundShellRevision, replaceDirectoryShells, resetBackgroundShells } from '@/sync/background-shells';
import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import type { ShellEnd } from '@/lib/opencode/background-shell';
import type { Metadata, SyntheticMessage } from '@/lib/opencode/model';


// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-guest-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { CommandActivityGroup } = await import('./CommandActivityGroup');

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpectedThemeChange,
  customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange,
  importTheme: unexpectedThemeChange,
  deleteImportedTheme: unexpectedThemeChange,
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: unexpectedThemeChange,
  themeMode: 'light',
  setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange,
  setDarkThemePreference: unexpectedThemeChange,
};

const withHarness = async (
  toolPart: ToolPartData,
  isExpanded: boolean,
  run: (store: ReturnType<ReturnType<typeof useChildStoreManager>['ensureChild']>, container: HTMLElement,
    remount: (nextPart?: ToolPartData) => Promise<void>, update: (nextPart: ToolPartData) => Promise<void>) => Promise<void>,
) => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    CustomEvent: happyWindow.CustomEvent,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });

  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  let manager: ReturnType<typeof useChildStoreManager> | undefined;
  const CaptureManager = () => { manager = useChildStoreManager(); return null; };
  try {
    replaceGlobalSessionStatusById(new Map());
    resetGlobalBlockingRequests();
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    let renderKey = 0;
    let currentPart = toolPart;
    const render = () => root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <CommandActivityGroup key={renderKey} id={currentPart.id} parts={[currentPart, settledSibling]} isExpanded={isExpanded} isMobile={false} onToggle={() => {}} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    await act(async () => { render(); });

    if (!manager) throw new Error('Sync manager did not mount');
    await run(manager.ensureChild('/workspace', { bootstrap: false }), container, async (nextPart) => {
      await act(async () => {
        currentPart = nextPart ?? currentPart;
        renderKey += 1;
        render();
      });
    }, async (nextPart) => {
      await act(async () => {
        currentPart = nextPart;
        render();
      });
    });
  } finally {
    await act(async () => { root.unmount(); });
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    replaceGlobalSessionStatusById(new Map());
    resetGlobalBlockingRequests();
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

const settledSibling: ToolPartData = {
  id: 'settled-sibling', sessionID: 'parent', messageID: 'parent-message',
  type: 'tool', tool: 'shell', callID: 'settled-sibling',
  state: { status: 'completed', input: { command: 'echo stable' }, output: 'stable output', time: { start: 110, end: 120 } },
};
const shell = { shellID: 'sh_selected', shellDirectory: '/workspace', command: 'sleep 300' };
const backgrounded: ToolPartData = {
  id: 'parent-call', sessionID: 'parent', messageID: 'parent-message',
  type: 'tool', tool: 'shell', callID: 'parent-call',
  state: {
    status: 'completed', input: { command: shell.command }, output: 'Moved to background',
    metadata: { status: 'running', shellID: shell.shellID }, time: { start: 100, end: 110 },
  },
};
const completion = (metadata: Metadata): SyntheticMessage => ({
  id: 'complete', sessionID: 'parent', role: 'synthetic', text: '<shell>\ncommand output\n</shell>',
  metadata: { source: 'shell', shellID: shell.shellID, ...metadata }, time: { created: 140 },
});
const start = () => applyBackgroundShellEvents('/workspace', [{ type: 'shell.started', properties: { shell: {
  id: shell.shellID, sessionID: 'parent', command: shell.command, file: '/tmp/selected.out', startedAt: 100,
} } }]);
const end = (value: ShellEnd) => applyBackgroundShellEvents('/workspace', [{ type: 'shell.ended', properties: {
  shellID: shell.shellID, end: value, endedAt: 140,
} }]);
const status = (container: HTMLElement) => container.querySelector('[data-tool-status]')?.getAttribute('data-tool-status');

test('a grouped background command follows authoritative completion while collapsed', async () => {
  resetBackgroundShells();
  const read = spyOn(opencodeClient, 'readShellOutput').mockResolvedValue({ output: 'live output', cursor: 11, skipped: false });
  try {
    await withHarness(backgrounded, false, async (store, container, remount) => {
      const header = () => container.querySelector<HTMLElement>('[data-command-header]');
      await act(async () => { start(); });
      expect(status(container)).toBe('running');
      expect(header()?.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelectorAll('[data-command-header]').length).toBe(1);
      expect(container.querySelector('button[aria-label="Stop command"]')).not.toBeNull();
      await act(async () => { header()?.click(); });
      expect(header()?.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('button[aria-label="Stop command"]')).toBeNull();
      const reads = read.mock.calls.length;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
      expect(read.mock.calls.length).toBe(reads);
      await act(async () => {
        end({ kind: 'exited', status: 'exited', exit: 2 });
        store.setState({ message: { parent: [completion({ state: 'completed', exit: 2 })] } });
      });
      expect(status(container)).toBe('failed');
      expect(header()?.getAttribute('aria-expanded')).toBe('false');
      await act(async () => { header()?.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 130)); });
      expect(container.querySelector('[data-command-group-output]')?.textContent).toContain('command output');
      expect(container.querySelector('[data-command-group-output]')?.textContent).toContain('stable output');
      expect(container.querySelector('[data-command-group-output]')?.textContent).toContain('exited (2)');
      await remount();
      expect(status(container)).toBe('failed');
      expect(header()?.getAttribute('aria-expanded')).toBe('false');
    });
  } finally { read.mockRestore(); resetBackgroundShells(); }
});

test('a grouped command does not infer stop from disappearance or a rejected stop request', async () => {
  resetBackgroundShells();
  const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockRejectedValue(new Error('unsupported'));
  try {
    await withHarness(backgrounded, false, async (store, container) => {
      await act(async () => { start(); });
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Stop command"]');
      expect(button).not.toBeNull();
      await act(async () => { button?.click(); });
      expect(stop.mock.calls).toHaveLength(1);
      expect(status(container)).toBe('running');
      await act(async () => replaceDirectoryShells('/workspace', [], backgroundShellRevision()));
      expect(status(container)).toBe('unknown');
      expect(container.querySelector('[data-command-header]')?.getAttribute('aria-expanded')).toBe('false');
      await act(async () => store.setState({ message: { parent: [completion({ state: 'cancelled' })] } }));
      expect(status(container)).toBe('stopped');
      expect(container.querySelector('[data-command-header]')?.getAttribute('aria-expanded')).toBe('false');
    });
  } finally { stop.mockRestore(); resetBackgroundShells(); }
});
