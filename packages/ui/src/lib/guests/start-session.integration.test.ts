import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { createRuntimeOpencodeClient, opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import * as sessionActions from '@/sync/session-actions';
import * as persistence from '@/lib/persistence';
import { startGuestSession } from './start-session';
import * as worktreeCreate from '@/lib/worktrees/worktreeCreate';
import * as worktreeBootstrap from '@/lib/worktrees/worktreeBootstrap';
import * as projectConfig from '@/lib/openchamberConfig';
import * as sharedTrust from '@/lib/sharedTrustConfirmation';

const created: Session = {
  id: 'background-session', directory: '/project-b', title: 'Task', projectID: 'b', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
};
afterEach(() => mock.restore());
const realSendMessage = useSessionUIStore.getState().sendMessage;
const setup = () => {
  const create = spyOn(opencodeClient, 'createSession').mockImplementation(async (_input, directory) => ({ ...created, directory: directory ?? created.directory }));
  spyOn(sessionActions, 'setLinkedIssue').mockResolvedValue(created);
  useProjectsStore.setState({ hasServerSnapshot: true, projects: [{ id: 'a', path: '/project-a', addedAt: 1 }, { id: 'b', path: '/project-b', addedAt: 1 }], activeProjectId: 'a' });
  useSessionUIStore.setState({ currentSessionId: 'existing-chat', currentSessionDirectory: '/project-a', sendMessage: realSendMessage });
  useUIStore.getState().setOpenGuestPage('board');
  return create;
};

test('a guest session in another project registers without changing the open page or chat', async () => {
  const create = setup();
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-1', title: 'Task', url: 'https://example.com/task', projectId: 'b' } });
  expect(create.mock.calls[0]?.[1]).toBe('/project-b');
  expect(result).toMatchObject({ sessionId: created.id, directory: '/project-b', sent: 'skipped', linked: true });
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
  expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/project-a');
  expect(useProjectsStore.getState().activeProjectId).toBe('a');
  expect(useUIStore.getState().openGuestPageId).toBe('board');
  expect(useGlobalSessionsStore.getState().entityById.get(created.id)?.directory).toBe('/project-b');
});

test('a disabled required creation skill stops the entry before opening or sending a plain chat', async () => {
  const create = setup();
  const readPolicy = spyOn(opencodeClient, 'getIntegrationPolicies').mockResolvedValue([
    { resource: 'skill:superweb', effect: 'deny', path: null },
  ]);
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  const options = {
    directory: '/project-a', t: (key: string) => key, assertAuthorized: () => {},
    request: { providerId: 'creation', id: 'Work', title: 'Website', url: 'https://superwagie.local/work/page', projectId: 'b', navigation: 'open' as const, text: 'Build a small website.' },
    creationIntent: 'page' as const,
  };
  await expect(startGuestSession(options)).rejects.toMatchObject({ code: 'NOT_GRANTED' });
  expect(readPolicy).toHaveBeenCalledWith('/project-b');
  expect(create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
  expect(useUIStore.getState().openGuestPageId).toBe('board');
});

test.each([
  ['deck', 'superppt'],
  ['doc', 'superwriter'],
  ['video', 'supervideo'],
  ['page', 'superweb'],
] as const)('%s activates %s before sending editable text or opening the chat', async (kind, skill) => {
  setup();
  spyOn(opencodeClient, 'getIntegrationPolicies').mockResolvedValue([]);
  const config = useConfigStore.getState();
  useConfigStore.setState({ currentProviderId: 'fixture', currentModelId: 'fixture' });
  const stages: string[] = [];
  const activate = spyOn(opencodeClient, 'activateSessionSkill').mockImplementation(async () => {
    expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
    stages.push('activate');
  });
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockImplementation(async () => {
    expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
    stages.push('prompt');
  });
  const text = 'The user completely replaced the draft.';
  try {
    const result = await startGuestSession({
      directory: '/project-a', creationIntent: kind, t: (key) => key, assertAuthorized: () => {},
      request: { providerId: 'creation', id: 'Work', title: 'Draft', url: `https://superwagie.local/work/${kind}`, projectId: 'b', navigation: 'open', text },
    });
    expect(result).toMatchObject({ sessionId: created.id, sent: 'sent' });
    expect(activate).toHaveBeenCalledWith(created.id, skill, '/project-b');
    expect(send.mock.calls[0]?.[0]).toBe(text);
    expect(stages).toEqual(['activate', 'prompt']);
    expect(useSessionUIStore.getState().currentSessionId).toBe(created.id);
  } finally {
    useConfigStore.setState({ currentProviderId: config.currentProviderId, currentModelId: config.currentModelId });
  }
});

test('a failed native creation skill activation does not send or open the unprepared chat', async () => {
  setup();
  spyOn(opencodeClient, 'getIntegrationPolicies').mockResolvedValue([]);
  spyOn(opencodeClient, 'activateSessionSkill').mockRejectedValue(new Error('Skill not found'));
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  await expect(startGuestSession({
    directory: '/project-a', creationIntent: 'video', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'creation', id: 'Work', title: 'Video', url: 'https://superwagie.local/work/video', projectId: 'b', navigation: 'open', text: 'Make a video.' },
  })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'creation.start.skillUnavailable' });
  expect(send).not.toHaveBeenCalled();
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
  expect(useUIStore.getState().openGuestPageId).toBe('board');
});

test('named worktrees forward the base ref through existing creation and keep bootstrap failures explicit', async () => {
  const create = setup();
  const createTree = spyOn(worktreeCreate, 'createWorktreeWithDefaults').mockResolvedValue({
    path: '/isolated-fix', projectDirectory: '/project-b', branch: 'fix-login', label: 'fix-login', name: 'fix-login', worktreeStatus: 'pending',
  });
  spyOn(sharedTrust, 'resolveWorktreeSetupCommands').mockResolvedValue([]);
  spyOn(projectConfig, 'getWorktreeSetupWaitEnabled').mockResolvedValue(true);
  spyOn(worktreeBootstrap, 'waitForWorktreeBootstrap').mockRejectedValue(new Error('Setup failed'));
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-2', title: 'Task', url: 'https://example.com/task', projectId: 'b', worktree: { kind: 'new', name: 'fix-login', baseBranch: 'release' } } });
  expect(createTree.mock.calls[0]?.[0]).toMatchObject({ id: 'b', path: '/project-b' });
  expect(createTree.mock.calls[0]?.[1]).toMatchObject({ branchName: 'fix-login', worktreeName: 'fix-login', startRef: 'release' });
  expect(create.mock.calls.length).toBe(0);
  expect(result).toMatchObject({ sessionId: null, failure: 'bootstrap-failed', directory: '/isolated-fix', worktree: { branch: 'fix-login' } });
  expect(useUIStore.getState().openGuestPageId).toBe('board');
});

test('existing worktrees create sessions in their directory without creating or scanning worktrees', async () => {
  const create = setup();
  useSessionUIStore.setState({ availableWorktreesByProject: new Map([['/project-b', [{
    path: '/existing', projectDirectory: '/project-b', branch: 'existing', label: 'existing', worktreeStatus: 'ready',
  }]]]) });
  const tree = spyOn(worktreeCreate, 'createWorktreeWithDefaults');
  spyOn(projectConfig, 'getWorktreeSetupWaitEnabled').mockResolvedValue(false);
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'board', id: 'TASK-3', title: 'Task', url: 'https://example.com/task', projectId: 'b', worktree: { kind: 'existing', directory: '/existing' } } });
  expect(create.mock.calls[0]?.[1]).toBe('/existing');
  expect(tree.mock.calls.length).toBe(0);
  expect(result).toMatchObject({ sessionId: created.id, directory: '/existing', worktree: { branch: 'existing' } });
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
});

test('a project the server just registered is found after one settings sync', async () => {
  const create = setup();
  useProjectsStore.setState({ projects: [{ id: 'a', path: '/project-a', addedAt: 1 }] });
  const sync = spyOn(persistence, 'syncDesktopSettings').mockImplementation(async () => {
    useProjectsStore.setState({ projects: [...useProjectsStore.getState().projects, { id: 'fresh', path: '/project-fresh', addedAt: 1 }] });
  });
  const result = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'creation', id: '作品', title: '季度汇报', url: 'https://example.com/work/deck', projectId: 'fresh' } });
  expect(sync.mock.calls.length).toBe(1);
  expect(create.mock.calls[0]?.[1]).toBe('/project-fresh');
  expect(result).toMatchObject({ sessionId: created.id, directory: '/project-fresh' });
});

test('a project still unknown after the sync fails as not found', async () => {
  setup();
  const sync = spyOn(persistence, 'syncDesktopSettings').mockResolvedValue(undefined);
  const failure = await startGuestSession({ directory: '/project-a', t: (key) => key, assertAuthorized: () => {},
    request: { providerId: 'creation', id: '作品', title: '季度汇报', url: 'https://example.com/work/deck', projectId: 'missing' } })
    .catch((error: Error) => error);
  expect(failure).toMatchObject({ code: 'NOT_FOUND' });
  expect(sync.mock.calls.length).toBe(1);
});

test('a replaced SDK client cannot publish a late creation even when the runtime key is unchanged', async () => {
  const create = setup();
  let client = createRuntimeOpencodeClient({ baseUrl: 'http://localhost:1' });
  spyOn(opencodeClient, 'getSdkClient').mockImplementation(() => client);
  create.mockImplementation(async () => {
    client = createRuntimeOpencodeClient({ baseUrl: 'http://localhost:2' });
    return { ...created, id: 'late-session' };
  });
  const result = await sessionActions.createSession('Late', '/project-b', undefined, undefined, undefined, 'preserve');
  expect(result).toBeNull();
  expect(useGlobalSessionsStore.getState().entityById.has('late-session')).toBe(false);
  expect(useSessionUIStore.getState().currentSessionId).toBe('existing-chat');
});
