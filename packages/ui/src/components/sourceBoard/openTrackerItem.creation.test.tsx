import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { createWebAPIs } from '../../../../web/src/api';
import { registerRuntimeAPIs, getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { noteSpaceCreationRequest, forgetSpaceCreationRequest, draftSpaceTarget, panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { shownContextModes } from '@/lib/workspace/zones';
import { getRelativeFilePath } from '@/lib/path-utils';
import { CREATION_WORK_URL_PREFIX } from '@/lib/creation';
import { useOpenTrackerItem } from './openTrackerItem';

const host = 'C:/chat A';
const work = 'D:/中文 空格';
const space = '/spaces/aaaaaaaaaaaa/work';
type Scenario = { name: string; panel: string; source: string; pending?: 'ready' | 'preparing'; named?: string;
  fallback?: 'native' | 'panel'; noDesktop?: boolean; navigateDuringRead?: boolean; nativeNavigation?: boolean; repeat?: boolean };
const scenarios: Scenario[] = [
  { name: 'cross-side refusal never opens a host folder', panel: host, source: space },
  { name: 'space refuses host folder fallback', panel: space, source: work },
  { name: 'different spaces refuse fallback', panel: space, source: '/spaces/bbbbbbbbbbbb/work' },
  { name: 'preparing space never falls back to host folder', panel: host, source: work, pending: 'preparing' },
  { name: 'missing panel never opens a folder', panel: '', source: work },
  { name: 'foreign named artifact never falls back to its host work folder', panel: host, source: work, named: `${space}/result.html` },
  { name: 'navigation during discovery refuses fallback', panel: host, source: work, navigateDuringRead: true },
  { name: 'missing artifact still opens the native host folder', panel: host, source: work, fallback: 'native' },
  { name: 'different host root without native opening refuses internal fallback', panel: host, source: work, noDesktop: true },
  { name: 'same content root still opens file surface without desktop', panel: work, source: work, noDesktop: true, fallback: 'panel' },
  { name: 'opening the same folder again keeps the panel and tree visible', panel: work, source: work, noDesktop: true, fallback: 'panel', repeat: true },
  { name: 'Windows-equivalent content root uses captured tab key', panel: 'D:/Work', source: 'd:/work', noDesktop: true, fallback: 'panel' },
  { name: 'ready space folder uses host tab key and actual space root', panel: host, source: space, pending: 'ready', fallback: 'panel' },
  { name: 'ready space refuses internal fallback for another folder', panel: host, source: '/spaces/aaaaaaaaaaaa/other', pending: 'ready' },
  { name: 'space folder fallback never goes to host shell', panel: space, source: space, fallback: 'panel' },
  { name: 'navigation during failed native open prevents panel fallback', panel: host, source: work, nativeNavigation: true },
];

for (const scenario of scenarios) {
  test(`creation link: ${scenario.name}`, async () => {
    const dom = new Window({ url: 'http://localhost/' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
      localStorage: dom.localStorage, Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const nativePaths: string[] = [];
    if (!scenario.noDesktop) Object.assign(dom, {
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_DESKTOP__: { invoke: async (command: string, args: { path?: string }) => {
        if (command === 'desktop_open_path' && args.path) nativePaths.push(args.path);
        if (scenario.nativeNavigation) {
          useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, preparedChatDirectory: space } });
          throw new Error('Test native open unavailable after navigation');
        }
        return null;
      } },
    });
    const previousSession = useSessionUIStore.getState();
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    const previousUI = useUIStore.getState();
    const previousProject = useProjectsStore.getState().activeProjectId;
    const previousRuntime = getRegisteredRuntimeAPIs();
    const previousJourney = useSpacesStore.getState().journey;
    useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: {
      ...previousSession.newSessionDraft, open: Boolean(scenario.panel), target: 'chat', directoryOverride: null,
      bootstrapPendingDirectory: null, preparedChatDirectory: scenario.panel || null,
      pendingWorktreeRequestId: scenario.pending ? 'caller-space' : null,
    } });
    if (scenario.pending) {
      noteSpaceCreationRequest('caller-space', 'aaaaaaaaaaaa');
      const entry: SpaceEntry = { id: 'aaaaaaaaaaaa', name: 'Test', placeId: 'local', machine: null,
        projectDirectory: host, directory: space, projectFolder: { path: host, found: true },
        state: scenario.pending === 'ready' ? 'running' : 'preparing', stoppedIdle: false, step: null,
        failure: null, network: null, grants: [], access: null, needsAccess: [], accessFailures: [], damage: null, setup: null };
      useSpacesStore.setState({ journey: new Map([[entry.id, entry]]) });
    }
    useDirectoryStore.setState({ currentDirectory: scenario.panel });
    useUIStore.setState({ contextPanelByDirectory: {}, openGuestPageId: 'workbench', contextEditorTreeVisible: false });
    const apis = createWebAPIs();
    registerRuntimeAPIs(apis);
    const stores = new ChildStoreManager();
    setSyncRefs(OpenCode.make({ baseUrl: 'http://unused.test' }), stores, scenario.source);
    if (scenario.named) stores.ensureChild(scenario.source, { bootstrap: false }).setState({
      message: { work: [{ id: 'answer', sessionID: 'work', role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'test', modelID: 'test' }] },
      part: { answer: [{ id: 'text', messageID: 'answer', sessionID: 'work', type: 'text', text: `\`${scenario.named}\`` }] },
    });
    const list = spyOn(apis.files, 'listDirectory').mockImplementation(async (directory) => {
      if (scenario.navigateDuringRead) useSessionUIStore.setState({ newSessionDraft: {
        ...useSessionUIStore.getState().newSessionDraft, preparedChatDirectory: space,
      } });
      return { directory, entries: [] };
    });
    const stat = spyOn(apis.files, 'statFile').mockImplementation(async (path) => ({ path, isFile: true, size: 1 }));
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected network'); });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Link() {
      const open = useOpenTrackerItem();
      return <button onClick={() => open(`${CREATION_WORK_URL_PREFIX}test`, scenario.source, undefined, scenario.named ? 'work' : null)}>Open work</button>;
    }
    try {
      const selection = useSessionUIStore.getState();
      await act(async () => root.render(<Link />));
      await act(async () => { container.querySelector('button')?.click(); });
      if (scenario.repeat) await act(async () => { container.querySelector('button')?.click(); });
      expect(nativePaths).toEqual(scenario.fallback === 'native' || scenario.nativeNavigation ? [scenario.source] : []);
      const ui = useUIStore.getState();
      if (scenario.fallback === 'panel') {
        const panel = ui.contextPanelByDirectory[scenario.panel];
        expect(panel?.isOpen).toBe(true);
        expect(ui.contextEditorTreeVisible).toBe(true);
        expect([...shownContextModes(panel, ui.contextSurfaceZones)]).toContain('file');
        const draft = useSessionUIStore.getState().newSessionDraft;
        const contentRoot = panelContentDirectory(draftSpaceTarget(draft.pendingWorktreeRequestId, useSpacesStore.getState().journey), scenario.panel);
        expect(getRelativeFilePath(scenario.source, contentRoot)).toBe('.');
        if (scenario.source !== scenario.panel) expect(ui.contextPanelByDirectory[scenario.source]).toBeUndefined();
      } else expect(ui.contextPanelByDirectory).toEqual({});
      expect(ui.openGuestPageId).toBe(scenario.fallback === 'panel' ? null : 'workbench');
      expect(useProjectsStore.getState().activeProjectId).toBe(previousProject);
      expect(useDirectoryStore.getState().currentDirectory).toBe(scenario.panel);
      expect(useSessionUIStore.getState().currentSessionId).toBe(selection.currentSessionId);
      if (!scenario.navigateDuringRead && !scenario.nativeNavigation) expect(useSessionUIStore.getState().newSessionDraft).toEqual(selection.newSessionDraft);
      if (!scenario.fallback && !scenario.navigateDuringRead && !scenario.nativeNavigation
        && !scenario.noDesktop && scenario.pending !== 'ready') {
        expect(list.mock.calls.length).toBe(0);
        expect(stat.mock.calls.length).toBe(0);
      }
      expect(fetch.mock.calls.length).toBe(0);
    } finally {
      await act(async () => root.unmount());
      list.mockRestore();
      stat.mockRestore();
      fetch.mockRestore();
      registerRuntimeAPIs(previousRuntime);
      useSessionUIStore.setState(previousSession);
      useDirectoryStore.setState({ currentDirectory: previousDirectory });
      useUIStore.setState(previousUI);
      useSpacesStore.setState({ journey: previousJourney });
      forgetSpaceCreationRequest('caller-space');
      for (const directory of stores.children.keys()) stores.disposeDirectory(directory);
      await dom.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
