import { expect, spyOn, test } from 'bun:test';
import { OpenCode } from '@opencode/client';
import { createWebAPIs } from '../../../../web/src/api';
import { getRegisteredRuntimeAPIs, registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { shownContextModes } from '@/lib/workspace/zones';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { noteSpaceCreationRequest, forgetSpaceCreationRequest } from '@/lib/spaces/space-creation-requests';
import { latestArtifactPath } from './latestArtifact';
import { openLatestWorkArtifact } from './openWorkArtifact';

const hostA = 'C:/chat A';
const hostB = 'D:/中文 空格';
const spaceA = '/spaces/aaaaaaaaaaaa/work';
const spaceB = '/spaces/bbbbbbbbbbbb/work';
type Scenario = {
  name: string; panel: string; source: string; allowed: boolean;
  named?: string; pending?: 'ready' | 'preparing'; empty?: boolean;
  foreignEntry?: string; switchDuringRead?: 'directory' | 'space'; registered?: boolean;
  noRead?: boolean;
};
const scenarios: Scenario[] = [
  { name: 'named artifact opens beside chat A without navigating to registered B', panel: hostA, source: hostB, named: `${hostB}/result.html`, registered: true, allowed: true },
  { name: 'unregistered work remains supported', panel: hostA, source: hostB, named: `${hostB}/result.html`, allowed: true },
  { name: 'folder convention still discovers deliverables', panel: hostA, source: hostB, allowed: true },
  { name: 'no deliverable reports not-found without clearing overlay', panel: hostA, source: hostB, empty: true, allowed: false },
  { name: 'no panel refuses before discovery', panel: '', source: hostB, noRead: true, allowed: false },
  { name: 'host refuses space work', panel: hostA, source: spaceA, noRead: true, allowed: false },
  { name: 'space refuses host work', panel: spaceA, source: hostB, noRead: true, allowed: false },
  { name: 'space refuses other space work', panel: spaceA, source: spaceB, noRead: true, allowed: false },
  { name: 'same space opens another work folder', panel: spaceA, source: '/spaces/aaaaaaaaaaaa/output', allowed: true },
  { name: 'named foreign artifact is refused before stat or fallback', panel: hostA, source: hostB, named: `${spaceA}/result.html`, noRead: true, allowed: false },
  { name: 'foreign folder from listing is not traversed', panel: hostA, source: hostB, foreignEntry: spaceA, allowed: false },
  { name: 'ready pending space uses host tab key and space content', panel: hostA, source: spaceA, pending: 'ready', allowed: true },
  { name: 'ready pending space stats named file with explicit space directory', panel: hostA, source: spaceA, named: `${spaceA}/result.html`, pending: 'ready', allowed: true },
  { name: 'ready pending space refuses host source', panel: hostA, source: hostB, pending: 'ready', noRead: true, allowed: false },
  { name: 'ready pending space refuses other space source', panel: hostA, source: spaceB, pending: 'ready', noRead: true, allowed: false },
  { name: 'preparing pending space refuses host source', panel: hostA, source: hostB, pending: 'preparing', noRead: true, allowed: false },
  { name: 'preparing pending space refuses space source', panel: hostA, source: spaceA, pending: 'preparing', noRead: true, allowed: false },
  { name: 'selection change during stat cannot open or start fallback reads', panel: hostA, source: hostB, named: `${hostB}/result.html`, switchDuringRead: 'directory', allowed: false },
  { name: 'pending space change during stat cannot open or start fallback reads', panel: hostA, source: hostB, named: `${hostB}/result.html`, switchDuringRead: 'space', allowed: false },
];

for (const scenario of scenarios) {
  test(`openLatestWorkArtifact: ${scenario.name}`, async () => {
    const previousSession = useSessionUIStore.getState();
    const previousProjects = useProjectsStore.getState();
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    const previousUI = useUIStore.getState();
    const previousJourney = useSpacesStore.getState().journey;
    const previousRuntime = getRegisteredRuntimeAPIs();
    const apis = createWebAPIs();
    registerRuntimeAPIs(apis);
    const stores = new ChildStoreManager();
    const sdk = OpenCode.make({ baseUrl: 'http://unused.test' });
    setSyncRefs(sdk, stores, scenario.source);
    useDirectoryStore.setState({ currentDirectory: scenario.panel });
    useProjectsStore.setState({ projects: scenario.registered ? [{ id: 'B', path: hostB }] : [], activeProjectId: 'A' });
    useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: {
      ...previousSession.newSessionDraft, open: Boolean(scenario.panel), target: 'chat',
      preparedChatDirectory: scenario.panel || null, directoryOverride: null, bootstrapPendingDirectory: null,
      pendingWorktreeRequestId: scenario.pending ? 'artifact-test-space' : null,
    } });
    const setPendingSpace = (state: 'ready' | 'preparing') => {
      noteSpaceCreationRequest('artifact-test-space', 'aaaaaaaaaaaa');
      const entry: SpaceEntry = { id: 'aaaaaaaaaaaa', name: 'Test', placeId: 'local', machine: null,
        projectDirectory: hostA, directory: spaceA, projectFolder: { path: hostA, found: true },
        state: state === 'ready' ? 'running' : 'preparing', stoppedIdle: false, step: null,
        failure: null, network: null, grants: [], access: null, needsAccess: [], accessFailures: [], damage: null, setup: null };
      useSpacesStore.setState({ journey: new Map([[entry.id, entry]]) });
    };
    if (scenario.pending) setPendingSpace(scenario.pending);
    useUIStore.setState({ contextPanelByDirectory: {}, openGuestPageId: 'workbench' });
    if (scenario.named) {
      stores.ensureChild(scenario.source, { bootstrap: false }).setState({
        message: { work: [{ id: 'answer', sessionID: 'work', role: 'assistant', time: { created: 1 },
          agent: 'build', providerID: 'test', modelID: 'test' }] },
        part: { answer: [{ id: 'text', messageID: 'answer', sessionID: 'work', type: 'text', text: `\`${scenario.named}\`` }] },
      });
      expect(latestArtifactPath('work', scenario.source)).toBe(scenario.named);
    }
    const stat = spyOn(apis.files, 'statFile').mockImplementation(async (path) => {
      if (scenario.switchDuringRead === 'directory') {
        useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, preparedChatDirectory: 'C:/other chat' } });
      } else if (scenario.switchDuringRead === 'space') {
        setPendingSpace('preparing');
        useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, pendingWorktreeRequestId: 'artifact-test-space' } });
      }
      return { path, isFile: true, size: 1 };
    });
    const list = spyOn(apis.files, 'listDirectory').mockImplementation(async (path) => ({ directory: path, entries:
      scenario.empty ? [] : scenario.foreignEntry ? [{ name: '交付', path: scenario.foreignEntry, isDirectory: true }]
        : path === scenario.source ? [{ name: '交付', path: `${path}/交付`, isDirectory: true }]
          : [{ name: 'old.html', path: `${path}/old.html`, isDirectory: false, modifiedTime: 1 },
            { name: 'result.html', path: `${path}/result.html`, isDirectory: false, modifiedTime: 2 }],
    }));
    // No network may escape this filesystem-boundary test.
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected network request'); });
    try {
      const selection = useSessionUIStore.getState();
      expect(await openLatestWorkArtifact(scenario.source, scenario.named ? 'work' : null)).toMatchObject(
        scenario.allowed ? { opened: true } : { opened: false, reason: scenario.empty ? 'not-found' : 'refused' },
      );
      const ui = useUIStore.getState();
      if (scenario.allowed) {
        const panel = ui.contextPanelByDirectory[scenario.panel];
        expect(panel?.isOpen).toBe(true);
        expect(panel?.tabs.some((tab) => tab.targetPath === (scenario.named ?? `${scenario.source}/交付/result.html`))).toBe(true);
        expect([...shownContextModes(panel, ui.contextSurfaceZones)]).toContain('file');
        expect(ui.contextPanelByDirectory[scenario.source]).toBeUndefined();
        expect(ui.openGuestPageId).toBeNull();
        if (scenario.named) {
          expect(stat.mock.calls).toEqual([[scenario.named, { directory: scenario.pending === 'ready' ? spaceA : scenario.panel }]]);
          expect(list.mock.calls.length).toBe(0);
        }
      } else {
        expect(ui.contextPanelByDirectory).toEqual({});
        expect(ui.openGuestPageId).toBe('workbench');
      }
      if (scenario.noRead) {
        expect(stat.mock.calls.length).toBe(0);
        expect(list.mock.calls.length).toBe(0);
      }
      if (scenario.foreignEntry) expect(list.mock.calls.length).toBe(1);
      if (scenario.switchDuringRead) {
        expect(stat.mock.calls.length).toBe(1);
        expect(list.mock.calls.length).toBe(0);
      } else expect(useSessionUIStore.getState().newSessionDraft).toEqual(selection.newSessionDraft);
      expect(useSessionUIStore.getState().currentSessionId).toBe(selection.currentSessionId);
      expect(useProjectsStore.getState().activeProjectId).toBe('A');
      expect(useDirectoryStore.getState().currentDirectory).toBe(scenario.panel);
      expect(fetch.mock.calls.length).toBe(0);
    } finally {
      stat.mockRestore();
      list.mockRestore();
      fetch.mockRestore();
      registerRuntimeAPIs(previousRuntime);
      useSessionUIStore.setState(previousSession);
      useProjectsStore.setState(previousProjects);
      useDirectoryStore.setState({ currentDirectory: previousDirectory });
      useUIStore.setState(previousUI);
      useSpacesStore.setState({ journey: previousJourney });
      forgetSpaceCreationRequest('artifact-test-space');
      for (const directory of stores.children.keys()) stores.disposeDirectory(directory);
    }
  });
}
