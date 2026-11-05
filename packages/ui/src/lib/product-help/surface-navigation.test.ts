import { beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGuestsStore } from '@/lib/guests/store';
import { navigateProductHelpSurface } from './surface-navigation';

beforeEach(() => {
  useDirectoryStore.setState({ currentDirectory: '/repo' });
  useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: {
    draftId: 0, open: false, directoryOverride: null, parentID: null, target: 'chat',
  } });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo' }], activeProjectId: 'project' });
  useGuestsStore.setState({ guests: [] });
  useUIStore.setState({ contextPanelByDirectory: {}, contextSurfaceZones: {}, isSidebarOpen: false,
    isScheduledTasksDialogOpen: false, isSettingsDialogOpen: false, worktreesPageProjectId: null,
    openGuestPageId: null, agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: false });
});

describe('product help surface navigation', () => {
  test('opens the requested context panel and repeated navigation leaves it open', () => {
    expect(navigateProductHelpSurface('terminal')).toBe(true);
    expect(navigateProductHelpSurface('terminal')).toBe(true);
    const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
    expect(panel.isOpen).toBe(true);
    expect(panel.tabs.map(tab => tab.mode)).toEqual(['terminal']);
  });

  test('returns to the current chat without creating a session or a draft', () => {
    useUIStore.getState().setScheduledTasksDialogOpen(true);
    expect(navigateProductHelpSurface('chat')).toBe(true);
    expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  });

  test('opens the existing session list and worktree page', () => {
    expect(navigateProductHelpSurface('sessions')).toBe(true);
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
    expect(navigateProductHelpSurface('worktrees')).toBe(true);
    expect(useUIStore.getState().worktreesPageProjectId).toBe('project');
    expect(useUIStore.getState().isNewWorktreeDialogOpen).toBe(false);
  });

  test('missing directory, missing project and disabled workflows do not change navigation', () => {
    useDirectoryStore.setState({ currentDirectory: '' });
    expect(navigateProductHelpSurface('files')).toBe(false);
    useProjectsStore.setState({ activeProjectId: null });
    expect(navigateProductHelpSurface('worktrees')).toBe(false);
    useDirectoryStore.setState({ currentDirectory: '/repo' });
    expect(navigateProductHelpSurface('workflows')).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
    expect(useUIStore.getState().agentWorkflowToolEnabled).toBe(false);
  });

  test('opens only an approved enabled workbench page', () => {
    expect(navigateProductHelpSurface('workbench')).toBe(false);
    const workbench = { id: 'openchamber-builtin-workbench', name: 'Workbench', icon: 'window',
      pageEntry: 'panel/index.html', capabilities: { requested: [], granted: [] } };
    useGuestsStore.setState({ guests: [{ ...workbench, enabled: false }] });
    expect(navigateProductHelpSurface('workbench')).toBe(false);
    useGuestsStore.setState({ guests: [workbench] });
    expect(navigateProductHelpSurface('workbench')).toBe(true);
    expect(useUIStore.getState().openGuestPageId).toBe('openchamber-builtin-workbench');
    expect(useUIStore.getState().creationIntent).toBeNull();
  });

  test('maps changes to the diff panel without invoking git operations', () => {
    expect(navigateProductHelpSurface('changes')).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].tabs.map(tab => tab.mode)).toEqual(['diff']);
  });

  test('other application shells keep their own navigation', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const mobileWindow = new Window({ url: 'http://localhost/?surface=mobile' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: mobileWindow });
    try {
      expect(navigateProductHelpSurface('scheduled-tasks')).toBe(false);
      expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(false);
      mobileWindow.location.href = 'http://localhost/?surface=desktop';
      Object.assign(mobileWindow, { __VSCODE_CONFIG__: { panelType: 'chat' } });
      expect(navigateProductHelpSurface('sessions')).toBe(false);
      expect(useUIStore.getState().isSidebarOpen).toBe(false);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      await mobileWindow.happyDOM.abort();
    }
  });
});
