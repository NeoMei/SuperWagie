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
import { shellCancellationNote, type ShellEnd } from '@/lib/opencode/background-shell';
import type { Metadata, SyntheticMessage } from '@/lib/opencode/model';
import { stopForegroundShell } from './foregroundShellStop';

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

const { default: ToolPart } = await import('@/components/chat/message/parts/ToolPart');

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
  run: (store: ReturnType<ReturnType<typeof useChildStoreManager>['ensureChild']>, container: HTMLElement, remount: (nextPart?: ToolPartData) => Promise<void>) => Promise<void>,
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
              <ToolPart key={renderKey} part={currentPart} isExpanded={isExpanded} isMobile={false} onToggle={() => {}} />
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

const shell = { shellID: 'sh_selected', shellDirectory: '/workspace', command: 'sleep 300' };
const backgrounded: ToolPartData = {
  id: 'parent-call', sessionID: 'parent', messageID: 'parent-message',
  type: 'tool', tool: 'shell', callID: 'parent-call',
  state: {
    status: 'completed', input: { command: shell.command }, output: 'Moved to background',
    metadata: { status: 'running', shellID: shell.shellID }, time: { start: 100, end: 110 },
  },
};
const cancellation = (): SyntheticMessage => {
  const note = shellCancellationNote([shell]);
  return { id: 'cancel', sessionID: 'parent', role: 'synthetic', text: note.text, metadata: note.metadata, time: { created: 120 } };
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

const reportedEnds: Array<{ name: string; metadata: Metadata; want: 'completed' | 'failed' }> = [
  { name: 'normal exit', metadata: { state: 'completed', exit: 0 }, want: 'completed' },
  { name: 'nonzero exit', metadata: { state: 'completed', exit: 2 }, want: 'failed' },
  { name: 'timeout', metadata: { state: 'completed', timeout: true }, want: 'failed' },
  { name: 'native error', metadata: { state: 'error' }, want: 'failed' },
];
for (const state of reportedEnds) test(`a requested stop preserves a later ${state.name}, including after row remount`, async () => {
  resetBackgroundShells();
  try {
    await withHarness(backgrounded, false, async (store, container, remount) => {
      await act(async () => {
        start();
        store.setState({ message: { parent: [cancellation()] } });
      });
      expect(status(container)).toBe('running');
      await act(async () => {
        end({ kind: 'exited', status: 'exited', exit: 0 });
        store.setState({ message: { parent: [cancellation(), completion(state.metadata)] } });
      });
      expect(status(container)).toBe(state.want);
      await remount();
      expect(status(container)).toBe(state.want);
      expect(container.querySelector('button[aria-label="Stop command"]')).toBeNull();
    });
  } finally { resetBackgroundShells(); }
});

for (const failureMode of ['unsupported', 'deadline'] as const) {
  test(`a foreground ${failureMode} removal cannot turn list disappearance into a stopped row`, async () => {
    resetBackgroundShells();
    const background = spyOn(opencodeClient, 'backgroundSessionWork').mockImplementation(async () => {
      applyBackgroundShellEvents('/workspace', [{ type: 'message.tool.transition', properties: {
        sessionID: 'parent', messageID: 'parent-message', partID: 'parent-call',
        transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: shell.shellID }, executed: true, end: 110 },
      } }]);
    });
    let publishNote = () => {};
    const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockImplementation(async () => {
      publishNote();
      if (failureMode === 'unsupported') throw new Error('shell.remove unsupported');
      await new Promise<void>(() => {});
    });
    try {
      await withHarness(backgrounded, false, async (store, container, remount) => {
        publishNote = () => store.setState({ message: { parent: [cancellation()] } });
        await act(async () => { start(); });
        let outcome = '';
        await act(async () => {
          outcome = await stopForegroundShell({ sessionID: 'parent', sessionDirectory: '/workspace', shell }, 8)
            .then(() => 'completed', (error: Error) => error.message);
        });
        expect(outcome).toBe(failureMode === 'unsupported' ? 'shell.remove unsupported' : 'The command stop could not be confirmed in time.');
        expect(status(container)).toBe('running');
        await act(async () => replaceDirectoryShells('/workspace', [], backgroundShellRevision()));
        expect(status(container)).toBe('unknown');
        await remount();
        expect(status(container)).toBe('unknown');
      });
    } finally { background.mockRestore(); stop.mockRestore(); resetBackgroundShells(); }
  });
}

test('the native code-less killed then deleted sequence confirms a stop only after deletion', async () => {
  resetBackgroundShells();
  try {
    await withHarness(backgrounded, false, async (store, container, remount) => {
      await act(async () => {
        start();
        applyBackgroundShellEvents('/workspace', [{ type: 'message.updated', properties: { info: cancellation() } }]);
        store.setState({ message: { parent: [cancellation()] } });
        end({ kind: 'exited', status: 'killed' });
      });
      expect(status(container)).toBe('unknown');
      await act(async () => store.setState({ message: { parent: [cancellation(), completion({ state: 'error' })] } }));
      expect(status(container)).toBe('failed');
      await act(async () => { end({ kind: 'removed' }); });
      expect(status(container)).toBe('stopped');
      await remount();
      expect(status(container)).toBe('stopped');
    });
  } finally { resetBackgroundShells(); }
});

for (const nativeStatus of ['timeout', 'killed'] as const) {
  test(`a failed removal followed by a native code-less ${nativeStatus} cannot confirm stopped`, async () => {
    resetBackgroundShells();
    let publishNote = () => {};
    const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockImplementation(async () => {
      publishNote();
      throw new Error('shell.remove unsupported');
    });
    try {
      await withHarness(backgrounded, false, async (store, container, remount) => {
        publishNote = () => {
          applyBackgroundShellEvents('/workspace', [{ type: 'message.updated', properties: { info: cancellation() } }]);
          store.setState({ message: { parent: [cancellation()] } });
        };
        await act(async () => { start(); });
        const button = container.querySelector<HTMLButtonElement>('button[aria-label="Stop command"]');
        expect(button).not.toBeNull();
        await act(async () => { button?.click(); });
        expect(status(container)).toBe('running');
        await act(async () => { end({ kind: 'exited', status: nativeStatus }); });
        expect(status(container)).toBe('unknown');
        await act(async () => store.setState({ message: { parent: [cancellation(), completion({ state: 'error' })] } }));
        expect(status(container)).toBe('failed');
        await remount();
        expect(status(container)).toBe('failed');
      });
    } finally { stop.mockRestore(); resetBackgroundShells(); }
  });
}

test('a foreground stop stays pending across the background row remount and removes the selected command once', async () => {
  resetBackgroundShells();
  const foreground: ToolPartData = { ...backgrounded, state: {
    status: 'running', input: { command: shell.command }, metadata: { shellID: shell.shellID }, time: { start: 100 },
  } };
  let moved = () => {};
  const backgroundMoved = new Promise<void>((resolve) => { moved = resolve; });
  const background = spyOn(opencodeClient, 'backgroundSessionWork').mockImplementation(async () => {
    applyBackgroundShellEvents('/workspace', [{ type: 'message.tool.transition', properties: {
      sessionID: 'parent', messageID: 'parent-message', partID: 'parent-call',
      transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: shell.shellID }, executed: true, end: 110 },
    } }]);
    moved();
  });
  let confirmRemoval = () => {};
  const removed = new Promise<void>((resolve) => { confirmRemoval = resolve; });
  const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockImplementation(() => removed);
  try {
    await withHarness(foreground, false, async (store, container, remount) => {
      await act(async () => { start(); });
      const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Stop this command"]');
      expect(button).not.toBeNull();
      await act(async () => { button?.click(); button?.click(); await backgroundMoved; });
      await remount(backgrounded);
      expect(status(container)).toBe('stopping');
      const backgroundStop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop command"]');
      expect(backgroundStop?.disabled).toBe(true);
      await act(async () => { backgroundStop?.click(); });
      expect(background).toHaveBeenCalledTimes(1);
      expect(stop.mock.calls).toHaveLength(1);
      expect(stop.mock.calls[0]?.[0].shells).toEqual([shell]);
      await act(async () => {
        end({ kind: 'removed' });
        store.setState({ message: { parent: [cancellation(), completion({ state: 'error' })] } });
        confirmRemoval();
        await removed;
      });
      expect(status(container)).toBe('stopped');
      await remount();
      expect(status(container)).toBe('stopped');
    });
  } finally { background.mockRestore(); stop.mockRestore(); resetBackgroundShells(); }
});

test('native cancellation confirms stopped without a local request or shell index', async () => {
  resetBackgroundShells();
  await withHarness(backgrounded, false, async (store, container, remount) => {
    await act(async () => store.setState({ message: { parent: [completion({ state: 'cancelled' })] } }));
    expect(status(container)).toBe('stopped');
    await remount();
    expect(status(container)).toBe('stopped');
  });
});

test('the ordinary background stop confirms removal and keeps the stopped result after remount', async () => {
  resetBackgroundShells();
  let confirm = () => {};
  const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockImplementation(async () => { confirm(); });
  try {
    await withHarness(backgrounded, false, async (store, container, remount) => {
      confirm = () => {
        applyBackgroundShellEvents('/workspace', [
          { type: 'shell.ended', properties: { shellID: shell.shellID, end: { kind: 'exited', status: 'killed' }, endedAt: 140 } },
          { type: 'shell.ended', properties: { shellID: shell.shellID, end: { kind: 'removed' }, endedAt: 141 } },
        ]);
        store.setState({ message: { parent: [cancellation(), completion({ state: 'error' })] } });
      };
      await act(async () => { start(); });
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Stop command"]');
      expect(button).not.toBeNull();
      await act(async () => { button?.click(); });
      expect(status(container)).toBe('stopped');
      expect(stop.mock.calls[0]?.[0].shells).toEqual([shell]);
      await remount();
      expect(status(container)).toBe('stopped');
      expect(container.querySelector('button[aria-label="Stop command"]')).toBeNull();
    });
  } finally { stop.mockRestore(); resetBackgroundShells(); }
});

test('a normal native completion supersedes an earlier stop observation', async () => {
  resetBackgroundShells();
  try {
    await withHarness(backgrounded, false, async (store, container) => {
      await act(async () => { start(); end({ kind: 'removed' }); });
      expect(status(container)).toBe('stopped');
      await act(async () => store.setState({ message: { parent: [cancellation(), completion({ state: 'completed', exit: 0 })] } }));
      expect(status(container)).toBe('completed');
    });
  } finally { resetBackgroundShells(); }
});

const malformedCompletions: Array<{ name: string; metadata: Metadata }> = [
  { name: 'unknown state', metadata: { state: 'unknown' } },
  { name: 'string exit', metadata: { state: 'completed', exit: '0' } },
  { name: 'empty shell identity', metadata: { state: 'cancelled', shellID: '' } },
];
for (const { name, metadata } of malformedCompletions) test(`a completion with ${name} cannot confirm a requested stop`, async () => {
  resetBackgroundShells();
  await withHarness(backgrounded, false, async (store, container, remount) => {
    await act(async () => store.setState({ message: { parent: [cancellation(), completion(metadata)] } }));
    expect(status(container)).toBe('unknown');
    await remount();
    expect(status(container)).toBe('unknown');
  });
});
