import React, { act } from 'react';
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
import { useUIStore } from '@/stores/useUIStore';
import { opencodeClient } from '@/lib/opencode/client';
import { subagentCancellationNote } from '@/lib/opencode/subagent-run';
import { applyBackgroundShellEvents, resetBackgroundShells } from '@/sync/background-shells';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { applyGlobalSessionStatusEvents, replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { readHostBlockingRequestsSnapshot, resetGlobalBlockingRequests, useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import type { SyncEvent } from '@/lib/opencode/events';

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

const { default: ToolPart } = await import('./ToolPart');
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

const parent: ToolPartData = {
  id: 'parent-call', sessionID: 'parent', messageID: 'parent-message',
  type: 'tool', tool: 'subagent', callID: 'parent-call',
  state: {
    status: 'completed', input: { description: 'Update files', agent: 'explore' },
    output: '<subagent sessionID="child" state="completed">\nFound two files\n</subagent>',
    metadata: { sessionID: 'child' }, time: { start: 1_000, end: 63_000 },
  },
};

const patchPart = (paths: string[]): ToolPartData => ({
  id: 'patch-call', sessionID: 'child', messageID: 'child-message',
  type: 'tool', tool: 'patch', callID: 'patch-call',
  state: {
    status: 'completed',
    input: { patchText: ['*** Begin Patch', ...paths.flatMap((path) => [
      `*** Add File: ${path}`, '+content',
    ]), '*** End Patch'].join('\n') },
    output: '', metadata: {}, time: { start: 1, end: 2 },
  },
});

const withHarness = async (
  toolPart: ToolPartData,
  isExpanded: boolean,
  run: (store: ReturnType<ReturnType<typeof useChildStoreManager>['ensureChild']>, container: HTMLElement) => Promise<void>,
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

  const previousPreference = useUIStore.getState().expandReasoningWhileStreaming;
  useUIStore.setState({ expandReasoningWhileStreaming: false });
  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  let manager: ReturnType<typeof useChildStoreManager> | undefined;
  const CaptureManager = () => { manager = useChildStoreManager(); return null; };
  const CallRow = () => {
    const [expanded, setExpanded] = React.useState(isExpanded);
    const toggle = () => setExpanded((current) => !current);
    return toolPart.tool === 'shell'
      ? <CommandActivityGroup id={toolPart.id} parts={[toolPart]} isExpanded={expanded} onToggle={toggle} isMobile={false} />
      : <ToolPart part={toolPart} isExpanded={expanded} isMobile={false} onToggle={toggle} />;
  };
  try {
    replaceGlobalSessionStatusById(new Map());
    resetGlobalBlockingRequests();
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <CallRow />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });

    if (!manager) throw new Error('Sync manager did not mount');
    await run(manager.ensureChild('/workspace', { bootstrap: false }), container);
  } finally {
    await act(async () => { root.unmount(); });
    useUIStore.setState({ expandReasoningWhileStreaming: previousPreference });
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

const childSession = (id: string, created: number) => ({
  id, parentID: 'parent', projectID: 'p', directory: '/workspace', title: id, agent: 'explore',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, updated: created },
});

const childActivity = (sessionID: string) => ({
  message: { [sessionID]: [{
    id: `${sessionID}-message`, sessionID, role: 'assistant' as const,
    agent: 'explore', providerID: 'test', modelID: 'test',
    time: { created: 121, completed: 122 },
  }] },
  part: { [`${sessionID}-message`]: [{ ...patchPart(['src/child-work.ts']), sessionID, messageID: `${sessionID}-message` }] },
});

const openButton = (container: HTMLElement) => container.querySelector('button[aria-label="Open Explore subtask"]');
const stopButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-label="Stop subagent"]');
const title = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="button"] span[title]');
const busy = (container: HTMLElement) => title(container)?.classList.contains('opacity-70') ?? false;
const failed = (container: HTMLElement) => title(container)?.style.color === 'var(--status-error)';
const expand = async (container: HTMLElement) => {
  await act(async () => container.querySelector<HTMLElement>('[role="button"]')?.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
};


test('a finished subagent is one row with its duration and an open action, never its child activity', async () => {
  await withHarness(parent, false, async (store, container) => {
    await act(async () => store.setState(childActivity('child')));
    expect(container.textContent).toContain('Update files');
    expect(container.textContent).toContain('62.0s');
    expect(openButton(container) !== null).toBe(true);
    expect(container.textContent).not.toContain('child-work.ts');
    expect(container.textContent).not.toContain('Found two files');
  });
});

test('a running subagent without the progress join resolves its child session from the store', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Look around', agent: 'explore', sessionID: '  ' }, time: { start: 100 } },
  };
  await withHarness(running, false, async (store, container) => {
    expect(openButton(container) === null).toBe(true);
    await act(async () => store.setState({ session: [childSession('child', 120)], ...childActivity('child') }));
    expect(openButton(container) !== null).toBe(true);
    expect(container.textContent).not.toContain('child-work.ts');
  });
});

test('a resumed subagent opens its explicit child even when that child predates the call', async () => {
  const running: ToolPartData = {
    ...parent,
    state: {
      status: 'running',
      input: { description: 'Look around', agent: 'explore', sessionID: 'child' },
      time: { start: 100 },
    },
  };
  await withHarness(running, false, async (store, container) => {
    await act(async () => store.setState({ session: [childSession('child', 50)] }));
    expect(openButton(container) !== null).toBe(true);
  });
});

test('a running subagent delegates its scoped native stop once and retains its open action', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Look around', agent: 'explore' }, metadata: { sessionID: 'child' }, time: { start: 100 } },
  };
  const stop = spyOn(opencodeClient, 'stopSubagent').mockResolvedValue(undefined);
  try {
    await withHarness(running, false, async (_store, container) => {
      const button = container.querySelector('button[aria-label="Stop subagent"]');
      if (!(button instanceof HTMLElement)) throw new Error('Stop action is missing');
      await act(async () => { button.click(); });
      expect(stop.mock.calls).toEqual([[{ sessionID: 'parent', directory: '/workspace', childSessionID: 'child', description: 'Look around' }]]);
      expect(stopButton(container) === null).toBe(true);
      expect(openButton(container) !== null).toBe(true);
    });
  } finally {
    stop.mockRestore();
  }
});

test('a subagent the user stopped reads as stopped, not failed, and offers no stop', async () => {
  const cancelled: ToolPartData = {
    ...parent,
    id: 'stopped-call',
    state: {
      status: 'error', input: { description: 'Look around', agent: 'explore' },
      error: 'Subagent cancelled (sessionID: stopped-child)', metadata: { sessionID: 'stopped-child' }, time: { start: 100, end: 200 },
    },
  };
  const note = subagentCancellationNote({ childSessionID: 'stopped-child', description: 'Look around' });
  await withHarness(cancelled, false, async (store, container) => {
    await act(async () => store.setState({
      message: { parent: [{ id: 'note', sessionID: 'parent', role: 'synthetic', time: { created: 150 }, text: note.text, description: note.description, metadata: note.metadata }] },
    }));
    expect(container.textContent).toContain('stopped');
    expect(failed(container)).toBe(false);
    expect(stopButton(container) === null).toBe(true);
  });
});

test('a background subagent drops the background label once its report arrives', async () => {
  const backgrounded: ToolPartData = {
    ...parent,
    id: 'background-call',
    state: {
      status: 'completed', input: { description: 'Look around', agent: 'explore' },
      output: 'The subagent is working in the background.', metadata: { status: 'running', sessionID: 'bg-child' }, time: { start: 100, end: 110 },
    },
  };
  await withHarness(backgrounded, false, async (store, container) => {
    await act(async () => store.setState({
      message: { parent: [{
        id: 'report', sessionID: 'parent', role: 'synthetic', time: { created: 900 },
        text: '<subagent sessionID="bg-child" state="completed" description="Look around">\nDone.\n</subagent>',
        description: 'Look around', metadata: { source: 'subagent', childID: 'bg-child', agent: 'explore', state: 'completed' },
      }] },
    }));
    expect(container.textContent).toContain('Look around');
    expect(container.textContent).not.toContain('in background');
    expect(stopButton(container) === null).toBe(true);
  });
});

test('live child permission, form and retry events preserve the native running row and open action', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Review files', agent: 'explore' }, metadata: { sessionID: 'child' }, time: { start: 100 } },
  };
  await withHarness(running, false, async (store, container) => {
    const publish = async (event: SyncEvent) => act(async () => {
      store.setState((current) => {
        const next = { ...current, permission: { ...current.permission }, form: { ...current.form }, session_status: { ...current.session_status } };
        applyDirectoryEvent(next, event);
        return next;
      });
      applyGlobalSessionStatusEvents('/workspace', [event]);
    });
    expect(stopButton(container) !== null).toBe(true);
    await publish({ type: 'permission.asked', properties: { id: 'permission', sessionID: 'child', action: 'edit', resources: [] } });
    expect(stopButton(container) !== null).toBe(true);
    expect(store.getState().permission.child?.[0]?.id).toBe('permission');
    await publish({ type: 'form.created', properties: { form: { id: 'form', sessionID: 'child', title: 'Choose a source', fields: [{ key: 'answer', type: 'string' }] } } });
    await publish({ type: 'permission.replied', properties: { sessionID: 'child', requestID: 'permission' } });
    expect(stopButton(container) !== null).toBe(true);
    expect(store.getState().form.child?.[0]?.id).toBe('form');
    expect(container.textContent).not.toContain('Choose a source');
    await publish({ type: 'form.settled', properties: { sessionID: 'child', formID: 'form' } });
    await publish({ type: 'session.status', properties: { sessionID: 'child', status: { type: 'retry', attempt: 2, message: 'Temporarily unavailable', next: Date.now() + 1000 } } });
    expect(stopButton(container) !== null).toBe(true);
    expect(store.getState().session_status.child?.type).toBe('retry');
    await publish({ type: 'session.status', properties: { sessionID: 'child', status: { type: 'busy' } } });
    expect(stopButton(container) !== null).toBe(true);
    expect(store.getState().session_status.child?.type).toBe('busy');
    expect(openButton(container) !== null).toBe(true);
  });
});

test('launch permissions retain their exact source without fabricating a child or a stop action', async () => {
  const waiting: ToolPartData = {
    ...parent,
    id: 'tool:call-awaiting-launch',
    callID: 'call-awaiting-launch',
    state: { status: 'running', input: { description: 'Review files', agent: 'explore' }, time: { start: Date.now() - 1000 } },
  };
  await withHarness(waiting, false, async (store, container) => {
    await act(async () => store.setState({ session: [] }));
    const publish = async (event: SyncEvent) => act(async () => {
      store.setState((current) => {
        const next = { ...current, permission: { ...current.permission } };
        applyDirectoryEvent(next, event);
        return next;
      });
    });
    expect(openButton(container) === null).toBe(true);
    expect(busy(container)).toBe(true);
    expect(stopButton(container) === null).toBe(true);
    await publish({ type: 'permission.asked', properties: {
      id: 'another-tool', sessionID: parent.sessionID, action: 'subagent', resources: ['general'],
      source: { type: 'tool', messageID: waiting.messageID, id: 'another-call' },
    } });
    expect(busy(container)).toBe(true);
    expect(stopButton(container) === null).toBe(true);
    await publish({ type: 'permission.asked', properties: {
      id: 'another-message', sessionID: parent.sessionID, action: 'subagent', resources: ['general'],
      source: { type: 'tool', messageID: 'another-message', id: waiting.callID },
    } });
    expect(busy(container)).toBe(true);
    expect(stopButton(container) === null).toBe(true);
    await publish({ type: 'permission.asked', properties: {
      id: 'launch-permission', sessionID: parent.sessionID, action: 'subagent', resources: ['general'],
      source: { type: 'tool', messageID: waiting.messageID, id: waiting.callID },
    } });
    expect(busy(container)).toBe(true);
    expect(stopButton(container) === null).toBe(true);
    expect(openButton(container) === null).toBe(true);
    expect(store.getState().permission.parent?.find((request) => request.id === 'launch-permission')?.source).toEqual({ type: 'tool', messageID: waiting.messageID, id: waiting.callID });
    await publish({ type: 'permission.replied', properties: { sessionID: parent.sessionID, requestID: 'launch-permission' } });
    expect(busy(container)).toBe(true);
    expect(stopButton(container) === null).toBe(true);
    expect(store.getState().permission.parent?.some((request) => request.id === 'launch-permission')).toBe(false);
    expect(stopButton(container) === null).toBe(true);
  });
});

test('a background child follows live busy and idle status until its terminal report supplies the result', async () => {
  const backgrounded: ToolPartData = {
    ...parent,
    state: { status: 'completed', input: { description: 'Review files', agent: 'explore' }, output: 'The subagent is working in the background.', metadata: { status: 'running', sessionID: 'child' }, time: { start: 100, end: 110 } },
  };
  await withHarness(backgrounded, false, async (store, container) => {
    expect(stopButton(container) === null).toBe(true);
    expect(container.textContent).not.toContain('0.1s');
    await act(async () => applyGlobalSessionStatusEvents('/workspace', [{ type: 'session.status', properties: { sessionID: 'child', status: { type: 'busy' } } }]));
    expect(stopButton(container) !== null).toBe(true);
    expect(container.textContent).toContain('in background');
    await act(async () => applyGlobalSessionStatusEvents('/workspace', [{ type: 'session.status', properties: { sessionID: 'child', status: { type: 'idle' } } }]));
    expect(stopButton(container) === null).toBe(true);
    expect(container.textContent).not.toContain('in background');
    expect(container.textContent).not.toContain('0.1s');
    await act(async () => store.setState({ message: { parent: [{
      id: 'report', sessionID: 'parent', role: 'synthetic', time: { created: 900 },
      text: '<subagent sessionID="child" state="completed" description="Review files">\nReviewed.\n</subagent>',
      description: 'Review files', metadata: { source: 'subagent', childID: 'child', agent: 'explore', state: 'completed' },
    }] } }));
    expect(container.textContent).toContain('0.8s');
    expect(failed(container)).toBe(false);
    await expand(container);
    expect(container.textContent).toContain('Reviewed.');
    expect(stopButton(container) === null).toBe(true);
  });
});

for (const state of ['pending', 'completed', 'error'] as const) {
  test(`a ${state} subagent retains upstream activity and error styling with its output folded`, async () => {
    const input = { description: 'Review files', agent: 'explore' };
    const part: ToolPartData = { ...parent, state: state === 'pending'
      ? { status: 'pending', input, raw: '' }
      : state === 'error'
        ? { status: 'error', input, error: 'Review failed', time: { start: 100, end: 200 } }
        : { status: 'completed', input, output: 'Reviewed.', time: { start: 100, end: 200 } } };
    await withHarness(part, false, async (_store, container) => {
      expect(busy(container)).toBe(state === 'pending');
      expect(failed(container)).toBe(state === 'error');
      expect(container.textContent).toContain('Review files');
      expect(container.textContent).not.toContain(state === 'error' ? 'Review failed' : 'Reviewed.');
    });
  });
}

for (const state of ['error', 'cancelled'] as const) {
  test(`a background child report exposes ${state} without opening the result`, async () => {
    const backgrounded: ToolPartData = {
      ...parent,
      state: { status: 'completed', input: { description: 'Review files', agent: 'explore' }, output: 'The subagent is working in the background.', metadata: { status: 'running', sessionID: 'child' }, time: { start: 100, end: 110 } },
    };
    await withHarness(backgrounded, false, async (store, container) => {
      await act(async () => store.setState({ message: { parent: [{
        id: 'report', sessionID: 'parent', role: 'synthetic', time: { created: 900 },
        text: 'The child ended.', description: 'Review files',
        metadata: { source: 'subagent', childID: 'child', agent: 'explore', state },
      }] } }));
      expect(failed(container)).toBe(state === 'error');
      if (state === 'cancelled') expect(container.textContent).toContain('stopped');
      await expand(container);
      expect(container.textContent).toContain('The child ended.');
      expect(stopButton(container) === null).toBe(true);
    });
  });
}

test('a completed child keeps its completion when another run in that session is waiting', async () => {
  await withHarness(parent, false, async (store, container) => {
    await act(async () => store.setState({ permission: { child: [{ id: 'later-permission', sessionID: 'child', action: 'edit', resources: [] }] } }));
    expect(failed(container)).toBe(false);
    expect(busy(container)).toBe(false);
    expect(container.textContent).toContain('62.0s');
    expect(stopButton(container) === null).toBe(true);
  });
});

test('a child in an unopened worktree shows its host-seeded permission without bootstrapping that directory', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Review files', agent: 'explore' }, metadata: { sessionID: 'child' }, time: { start: 100 } },
  };
  await withHarness(running, false, async (store, container) => {
    // The parent directory's complete empty bucket has no authority over the child worktree.
    await act(async () => store.setState({ status: 'complete', session: [] }));
    await act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
      sessions: {},
      pending: { child: { permissions: [{ id: 'seeded-permission', sessionID: 'child', action: 'edit', resources: [] }], forms: [], pages: [] } },
      serverTime: 0,
    }), () => '/worktrees/child') });
    expect(useGlobalBlockingRequestsStore.getState().bySession.get('child')?.permissions[0]?.id).toBe('seeded-permission');
    expect(stopButton(container) !== null).toBe(true);
    expect(openButton(container) !== null).toBe(true);
  });
});

test('a live child directory outranks a stale directory and request from the host index', async () => {
  const running: ToolPartData = {
    ...parent,
    state: { status: 'running', input: { description: 'Review files', agent: 'explore' }, metadata: { sessionID: 'child' }, time: { start: 100 } },
  };
  await withHarness(running, false, async (store, container) => {
    await act(async () => store.setState({ status: 'complete', session: [childSession('child', 120)] }));
    await act(async () => { await readHostBlockingRequestsSnapshot(async () => ({
      sessions: {},
      pending: { child: { permissions: [{ id: 'old-permission', sessionID: 'child', action: 'edit', resources: [] }], forms: [], pages: [] } },
      serverTime: 0,
    }), () => '/worktrees/old') });
    expect(store.getState().session.some((session) => session.id === 'child')).toBe(true);
    expect(stopButton(container) !== null).toBe(true);
    expect(container.textContent).not.toContain('Waiting for approval');
  });
});

for (const state of ['pending', 'running', 'completed', 'error'] as const) {
  test(`a ${state} shell keeps command and outcome within the shared disclosure`, async () => {
    const input = { command: 'node --version', description: 'Check runtime version' };
    const part: ToolPartData = { ...parent, tool: 'shell', state: state === 'pending'
      ? { status: 'pending', input, raw: '' }
      : state === 'running'
        ? { status: 'running', input, time: { start: Date.now() - 2000 } }
        : state === 'error'
          ? { status: 'error', input, error: 'Runtime unavailable', time: { start: 100, end: 200 } }
          : { status: 'completed', input, output: 'v24.18.0', time: { start: 100, end: 200 } } };
    await withHarness(part, false, async (_store, container) => {
      expect(container.querySelector('[data-command-header]') !== null).toBe(true);
      expect(container.querySelector('[data-command-header]')?.textContent).not.toContain('node --version');
      expect(container.querySelector('[role="button"]')?.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('[data-command-output]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden') ?? 'true').toBe('true');
      await expand(container);
      expect(container.querySelector('[data-command-output]')?.textContent).toContain('node --version');
      if (state === 'completed') expect(container.querySelector('[data-command-output]')?.textContent).toContain('v24.18.0');
      if (state === 'error') expect(container.querySelector('[data-command-output]')?.textContent).toContain('Runtime unavailable');
    });
  });
}


test('a live foreground shell offers an explicit single-command stop with its side effect', async () => {
  const running: ToolPartData = { ...parent, tool: 'shell', state: {
    status: 'running', input: { command: 'sleep 300' }, metadata: { shellID: 'sh_selected' }, time: { start: 100 },
  } };
  const receipts: string[] = [];
  const background = spyOn(opencodeClient, 'backgroundSessionWork').mockImplementation(async () => {
    receipts.push('background');
    applyBackgroundShellEvents('/workspace', [{ type: 'message.tool.transition', properties: {
      sessionID: 'parent', messageID: 'parent-message', partID: 'parent-call',
      transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: 'sh_selected' }, executed: true, end: 200 },
    } }]);
  });
  const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockImplementation(async () => { receipts.push('stop'); });
  try {
    await withHarness(running, false, async (_store, container) => {
      await act(async () => applyBackgroundShellEvents('/workspace', [{ type: 'shell.started', properties: { shell: {
        id: 'sh_selected', sessionID: 'parent', command: 'sleep 300', file: '/tmp/selected', startedAt: 100,
      } } }]));
      await expand(container);
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Stop command"]');
      expect(button !== null).toBe(true);
      await act(async () => { button?.click(); button?.click(); });
      expect(receipts).toEqual(['background', 'stop']);
      expect(background).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop.mock.calls[0]?.[0].shells).toEqual([{ shellID: 'sh_selected', shellDirectory: '/workspace', command: 'sleep 300' }]);
    });
  } finally { background.mockRestore(); stop.mockRestore(); resetBackgroundShells(); }
});
