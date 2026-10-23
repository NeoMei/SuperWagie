import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { shownContextModes } from '@/lib/workspace/zones';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { noteSpaceCreationRequest, forgetSpaceCreationRequest } from '@/lib/spaces/space-creation-requests';
import { PluginPane } from './PluginPane';

const hostA = 'C:/chat A';
const hostB = 'D:/中文 空格';
const spaceA = '/spaces/aaaaaaaaaaaa/work';
const spaceB = '/spaces/bbbbbbbbbbbb/work';
type Scenario = {
  name: string; panel: string; owner: string; allowed: boolean;
  session?: boolean; pending?: 'ready' | 'preparing'; disabled?: boolean;
  path?: string; livePanel?: string;
};
const scenarios: Scenario[] = [
  { name: 'chat draft A opens registered B beside A', panel: hostA, owner: hostB, allowed: true },
  { name: 'project session A opens registered B without navigating', panel: hostA, owner: hostB, session: true, allowed: true },
  { name: 'selection after handshake supplies the live panel key', panel: hostA, livePanel: 'C:/new chat', owner: hostB, allowed: true },
  { name: 'unregistered path is refused', panel: hostA, owner: hostB, path: 'D:/outside/result.html', allowed: false },
  { name: 'disabled guest is refused', panel: hostA, owner: hostB, disabled: true, allowed: false },
  { name: 'missing panel directory is refused', panel: '', owner: hostB, allowed: false },
  { name: 'host panel refuses space file', panel: hostA, owner: spaceA, allowed: false },
  { name: 'space panel refuses host file', panel: spaceA, owner: hostB, allowed: false },
  { name: 'space panel refuses another space', panel: spaceA, owner: spaceB, allowed: false },
  { name: 'same space permits another registered folder', panel: spaceA, owner: '/spaces/aaaaaaaaaaaa/output', allowed: true },
  { name: 'ready pending space uses space content with host tab key', panel: hostA, owner: spaceA, pending: 'ready', allowed: true },
  { name: 'ready pending space refuses host file despite host tab key', panel: hostA, owner: hostB, pending: 'ready', allowed: false },
  { name: 'ready pending space refuses another space', panel: hostA, owner: spaceB, pending: 'ready', allowed: false },
  { name: 'preparing pending space refuses host file', panel: hostA, owner: hostB, pending: 'preparing', allowed: false },
  { name: 'preparing pending space refuses space file', panel: hostA, owner: spaceA, pending: 'preparing', allowed: false },
];

// Real iframe handshake/dispatch and panel stores; only network and postMessage
// transport are replaced. FilesView rendering is deliberately not claimed here.
for (const scenario of scenarios) {
  test(`openFile: ${scenario.name}`, async () => {
    const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
      localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event,
      MessageEvent: dom.MessageEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const requests: string[] = [];
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      if (url.includes('/api/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
      if (url.includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
      if (url.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ data: [] });
    });
    const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
      const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
      if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json(path.endsWith('/session/active') ? {} : { data: [] });
    } });
    const theme = getDefaultTheme(false);
    const themeContext: ThemeContextValue = {
      currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
      reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
      isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
      lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
    };
    const guest: InstalledGuest = { id: 'repro', name: 'Repro', icon: 'window', entry: 'panel/index.html',
      pageEntry: 'panel/page.html', source: 'path', capabilities: { requested: [], granted: [] } };
    const previousSession = useSessionUIStore.getState();
    const previousProjects = useProjectsStore.getState();
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    const previousUI = useUIStore.getState();
    const previousJourney = useSpacesStore.getState().journey;
    const runtimeKey = getRuntimeKey();
    useDirectoryStore.setState({ currentDirectory: scenario.panel });
    useProjectsStore.setState({ projects: [{ id: 'A', path: hostA }, { id: 'B', path: scenario.owner }], activeProjectId: 'A' });
    useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: {
      ...previousSession.newSessionDraft, open: Boolean(scenario.panel), target: 'chat',
      directoryOverride: null, bootstrapPendingDirectory: null, preparedChatDirectory: scenario.panel || null,
      pendingWorktreeRequestId: scenario.pending ? 'file-test-space' : null,
    } });
    if (scenario.pending) {
      noteSpaceCreationRequest('file-test-space', 'aaaaaaaaaaaa');
      const entry: SpaceEntry = { id: 'aaaaaaaaaaaa', name: 'Test', placeId: 'local', machine: null,
        projectDirectory: hostA, directory: spaceA, projectFolder: { path: hostA, found: true },
        state: scenario.pending === 'ready' ? 'running' : 'preparing', stoppedIdle: false, step: null,
        failure: null, network: null, grants: [], access: null, needsAccess: [], accessFailures: [], damage: null, setup: null };
      useSpacesStore.setState({ journey: new Map([[entry.id, entry]]) });
    }
    useUIStore.setState({ contextPanelByDirectory: {}, openGuestPageId: 'repro' });
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    useGuestsStore.getState().replaceCatalog([guest], runtimeKey);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const guestWindow = new Window();
    const restores: Array<() => void> = [];
    try {
      await act(async () => root.render(
        <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
          <SyncProvider sdk={sdk} directory={hostA}>
            <PluginPane mode="plugin:repro" surface="page" pinnedDirectory={hostA} />
          </SyncProvider>
        </ThemeSystemContext.Provider></I18nProvider>,
      ));
      for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      const frame = container.querySelector<HTMLIFrameElement>('iframe');
      if (!frame) throw new Error('Guest frame did not mount');
      Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
      const frameWindow = frame.contentWindow;
      if (!frameWindow) throw new Error('Guest window is missing');
      const received: HostMessage[] = [];
      const post = spyOn(frameWindow, 'postMessage').mockImplementation((data) => { received.push(hostMessageSchema.parse(data)); });
      restores.push(() => post.mockRestore());
      const send = async (message: GuestMessage) => {
        await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: message })); });
      };
      await send({ channel: 'openchamber.sdk', v: 1, type: 'hello' });
      expect(received.some((message) => message.type === 'ready')).toBe(true);
      if (scenario.session) {
        await act(async () => {
          getSyncChildStores().ensureChild(hostA, { bootstrap: false }).setState({ session: [{
            id: 'session-a', projectID: 'A', directory: hostA, title: 'A', cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
          }] });
          useSessionUIStore.setState({ currentSessionId: 'session-a', newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false } });
        });
      }
      if (scenario.livePanel) await act(async () => {
        useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, preparedChatDirectory: scenario.livePanel } });
      });
      const selection = useSessionUIStore.getState();
      const requestCount = requests.filter((url) => url.includes('/api/fs/')).length;
      const path = scenario.path ?? `${scenario.owner}/result.html`;
      const message: GuestMessage = { channel: 'openchamber.sdk', v: 1, type: 'open-file', id: 'open', payload: { path } };
      if (scenario.disabled) {
        // Revoke authority before dispatch, while the old frame still exists.
        await act(async () => {
          useGuestsStore.getState().replaceCatalog([{ ...guest, enabled: false }], runtimeKey);
          window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: message }));
        });
      } else await send(message);
      expect(received.find((entry) => entry.type === 'result' && entry.id === 'open')).toMatchObject(
        scenario.allowed ? { ok: true } : { ok: false, code: scenario.disabled ? 'DISABLED' : 'BAD_PATH' },
      );
      const ui = useUIStore.getState();
      if (scenario.allowed) {
        const panel = ui.contextPanelByDirectory[scenario.livePanel ?? scenario.panel];
        expect(panel?.isOpen).toBe(true);
        expect(panel?.tabs.some((tab) => tab.mode === 'file' && tab.targetPath === path)).toBe(true);
        expect([...shownContextModes(panel, ui.contextSurfaceZones)]).toContain('file');
        expect(ui.openGuestPageId).toBeNull();
        expect(ui.contextPanelByDirectory[scenario.owner]).toBeUndefined();
      } else {
        expect(ui.contextPanelByDirectory).toEqual({});
        expect(ui.openGuestPageId).toBe('repro');
      }
      expect(requests.filter((url) => url.includes('/api/fs/')).length).toBe(requestCount);
      expect(useSessionUIStore.getState().currentSessionId).toBe(selection.currentSessionId);
      expect(useSessionUIStore.getState().newSessionDraft).toEqual(selection.newSessionDraft);
      expect(useProjectsStore.getState().activeProjectId).toBe('A');
      expect(useDirectoryStore.getState().currentDirectory).toBe(scenario.panel);
    } finally {
      await act(async () => root.unmount());
      for (const restore of restores) restore();
      fetch.mockRestore();
      useSessionUIStore.setState(previousSession);
      useProjectsStore.setState(previousProjects);
      useDirectoryStore.setState({ currentDirectory: previousDirectory });
      useUIStore.setState(previousUI);
      useSpacesStore.setState({ journey: previousJourney });
      forgetSpaceCreationRequest('file-test-space');
      useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
      await guestWindow.happyDOM.close();
      await dom.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
