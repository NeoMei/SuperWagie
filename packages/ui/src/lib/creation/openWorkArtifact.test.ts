import { expect, spyOn, test } from 'bun:test';
import { OpenCode } from '@opencode/client';
import { win32 } from 'node:path';
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
          expect(stat.mock.calls).toEqual([[scenario.named, { directory: scenario.source }]]);
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

test('real WebFilesAPI stats the named B artifact in B workspace, opens beside A, and never lists', async () => {
  const previousSession = useSessionUIStore.getState();
  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  const previousUI = useUIStore.getState();
  const previousRuntime = getRegisteredRuntimeAPIs();
  const previousProjects = useProjectsStore.getState();
  const apis = createWebAPIs();
  registerRuntimeAPIs(apis);
  const stores = new ChildStoreManager();
  setSyncRefs(OpenCode.make({ baseUrl: 'http://unused.test' }), stores, hostB);
  const named = `${hostB}/named.html`;
  const fallback = `${hostB}/other.html`;
  stores.ensureChild(hostB, { bootstrap: false }).setState({
    message: { work: [{ id: 'answer', sessionID: 'work', role: 'assistant', time: { created: 1 },
      agent: 'build', providerID: 'test', modelID: 'test' }] },
    part: { answer: [{ id: 'text', messageID: 'answer', sessionID: 'work', type: 'text', text: `\`${named}\`` }] },
  });
  useProjectsStore.setState({ projects: [{ id: 'A', path: hostA }, { id: 'B', path: hostB }], activeProjectId: 'A' });
  useDirectoryStore.setState({ currentDirectory: hostA });
  useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: {
    ...previousSession.newSessionDraft, open: true, target: 'chat', preparedChatDirectory: hostA,
    directoryOverride: null, bootstrapPendingDirectory: null, pendingWorktreeRequestId: null,
  } });
  useUIStore.setState({ contextPanelByDirectory: {}, openGuestPageId: 'workbench' });
  const requests: Array<{ route: string; path: string; directory: string; encoding: string | null; outside: string | null; grant: string | null }> = [];
  // Keep WebFilesAPI and runtimeFetch real. This HTTP boundary implements the
  // Windows workspace containment response, rather than stubbing stat as true.
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://fs.test');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const encoding = headers.get('x-opencode-directory-encoding');
    const rawDirectory = headers.get('x-opencode-directory') ?? '';
    const directory = encoding === 'uri' ? decodeURIComponent(rawDirectory) : rawDirectory;
    const path = url.searchParams.get('path') ?? '';
    requests.push({ route: url.pathname, path, directory, encoding,
      outside: url.searchParams.get('allowOutsideWorkspace'), grant: url.searchParams.get('outsideFileGrant') });
    if (url.pathname === '/api/fs/stat') {
      const relative = win32.relative(directory, path);
      const contained = directory && !win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\');
      return contained ? Response.json({ path, isFile: true, size: 1 })
        : Response.json({ error: 'Path is outside workspace' }, { status: 400 });
    }
    if (url.pathname === '/api/fs/list') return Response.json({ directory: hostB,
      entries: [{ name: 'other.html', path: fallback, isDirectory: false }] });
    throw new Error(`Unexpected filesystem route: ${url.pathname}`);
  });
  try {
    if (!apis.files.statFile) throw new Error('WebFilesAPI must support stat');
    await expect(apis.files.statFile(named, { directory: hostA })).rejects.toThrow('Path is outside workspace');
    expect(await apis.files.statFile(named, { directory: hostB })).toMatchObject({ path: named, isFile: true });
    requests.length = 0;
    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(await openLatestWorkArtifact(hostB, 'work')).toMatchObject({ opened: true });
    const ui = useUIStore.getState();
    expect(ui.contextPanelByDirectory[hostA]?.tabs.map((tab) => tab.targetPath)).toEqual([named]);
    expect(requests).toEqual([{ route: '/api/fs/stat', path: named, directory: hostB, encoding: 'uri', outside: null, grant: null }]);
    expect(ui.contextPanelByDirectory[hostB]).toBeUndefined();
    expect([...shownContextModes(ui.contextPanelByDirectory[hostA], ui.contextSurfaceZones)]).toContain('file');
    expect(ui.openGuestPageId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useProjectsStore.getState().activeProjectId).toBe('A');
    expect(useDirectoryStore.getState().currentDirectory).toBe(hostA);
  } finally {
    fetch.mockRestore();
    registerRuntimeAPIs(previousRuntime);
    useSessionUIStore.setState(previousSession);
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    useUIStore.setState(previousUI);
    useProjectsStore.setState(previousProjects);
    for (const directory of stores.children.keys()) stores.disposeDirectory(directory);
  }
});
