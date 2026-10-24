import { describe, expect, test } from 'bun:test';
import type { SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildSessionSidebarRowModel, type SessionSidebarRowModelArgs } from './sessionSidebarRowModel';

const views: NonNullable<SessionSidebarRowModelArgs['viewMode']>[] = ['projects', 'timeline'];

const project = (directory = '/workspace/repo'): ProjectSection => {
  const session: SessionNode = {
    session: {
      id: 'session-a', projectID: 'project-a', directory, title: 'Project task', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    },
    children: [],
    worktree: null,
  };
  return {
    project: { id: 'project-a', label: 'repo', normalizedPath: directory },
    groups: [{
      id: 'main', label: 'main', branch: null, description: null, isMain: true,
      worktree: null, directory, folderScopeKey: directory, sessions: [session],
    }],
  };
};

const args = (sections: ProjectSection[], viewMode: SessionSidebarRowModelArgs['viewMode'] = 'projects'): SessionSidebarRowModelArgs => ({
  mode: 'normal', viewMode, listGrouping: 'project', sections, authoritativeSections: sections,
  chatGroup: null,
  timelineItems: sections.flatMap((section) => section.groups.flatMap((group) => group.sessions.map((node) => ({
    node, projectId: section.project.id, groupDirectory: group.directory,
    secondaryMeta: { projectLabel: section.project.label ?? 'repo', branchLabel: 'main' },
  })))),
  foldersMap: {}, groupSearchDataByGroup: new WeakMap(), normalizedQuery: '',
  collapsedProjects: new Set(), collapsedGroups: new Set(), collapsedFolders: new Set(),
  collapsedActivities: new Set(), collapsedCategories: new Set(), expandedParents: new Set(),
  visibleCountByContainer: new Map(), pinnedSessionIds: new Set(), sessionOrderIndex: new Map(),
  groupStatusByKey: new Map(),
  folderAuthorityByOwner: new Map(sections.map((section) => [section.project.id, {
    scopeKeys: [section.project.normalizedPath], complete: true,
  }])),
  activeProjectId: null, singleProjectMode: false, singleProjectId: null,
  showOnlyMainWorkspace: false, hideDirectoryControls: false,
});

describe('sidebar project entry rows', () => {
  for (const view of views) {
    test(`${view} keeps the Projects entry without any projects`, () => {
      const model = buildSessionSidebarRowModel(args([], view));
      expect(model.rows.find((row) => row.key === 'category:projects')).toMatchObject({
        kind: 'category-header', category: 'projects', collapsed: false,
      });
      expect(model.selectionEntries).toEqual([]);
    });

    test(`${view} keeps the general Projects entry with only creation projects`, () => {
      const creation = project('/Users/demo/Documents/SuperWagie/文档/report');
      const model = buildSessionSidebarRowModel(args([creation], view));
      expect(model.rows.filter((row) => row.key === 'category:projects')).toHaveLength(1);
      expect(model.rows.find((row) => row.kind === 'project-header')).toMatchObject({ section: creation });
    });

    test(`${view} expands and folds the project children while retaining the entry`, () => {
      const input = args([project()], view);
      const open = buildSessionSidebarRowModel(input);
      expect(open.rows.some((row) => row.kind === 'project-header')).toBe(true);
      expect(open.rows.some((row) => row.kind === 'session' && row.node.session.id === 'session-a')).toBe(true);

      input.collapsedCategories = new Set(['projects']);
      const closed = buildSessionSidebarRowModel(input);
      expect(closed.rows.find((row) => row.key === 'category:projects')).toMatchObject({ collapsed: true });
      expect(closed.rows.some((row) => row.kind === 'project-header' || row.kind === 'session')).toBe(false);
    });

    test(`${view} keeps the project entry during an empty search without inventing matches`, () => {
      const input = args([], view);
      input.authoritativeSections = [project()];
      input.mode = 'search';
      input.normalizedQuery = 'does not match';
      const model = buildSessionSidebarRowModel(input);
      expect(model.rows.find((row) => row.key === 'category:projects')).toMatchObject({ forceExpanded: true });
      expect(model.searchMatchCount).toBe(0);
      expect(model.selectionEntries).toEqual([]);
      expect(model.rows.some((row) => row.kind === 'session' || row.kind === 'project-header')).toBe(false);
    });

    test(`${view} does not create directory-backed rows when directory controls are hidden`, () => {
      const input = args([], view);
      input.hideDirectoryControls = true;
      const model = buildSessionSidebarRowModel(input);
      expect(model.rows.some((row) => row.kind === 'session' || row.kind === 'project-header' || row.kind === 'group-header')).toBe(false);
      expect(model.folderAuthorityByOwner.size).toBe(0);
      expect(model.selectionEntries).toEqual([]);
    });

    test(`${view} keeps the single-project view without an extra category`, () => {
      const selected = project();
      const input = args([selected], view);
      input.singleProjectMode = true;
      input.singleProjectId = selected.project.id;
      const model = buildSessionSidebarRowModel(input);
      expect(model.rows.some((row) => row.kind === 'category-header')).toBe(false);
      expect(model.rows.find((row) => row.kind === 'project-header')).toMatchObject({ section: selected });
    });

    test(`${view} leaves the workspace-only view without an extra category`, () => {
      const input = args([project()], view);
      input.showOnlyMainWorkspace = true;
      expect(buildSessionSidebarRowModel(input).rows.some((row) => row.kind === 'category-header')).toBe(false);
    });
  }

  test('the empty time list keeps its Projects header', () => {
    const input = args([], 'timeline');
    input.listGrouping = 'time';
    const model = buildSessionSidebarRowModel(input);
    expect(model.rows.find((row) => row.key === 'activity:timeline:header')).toMatchObject({
      kind: 'activity-header', activityKey: 'timeline', collapsed: false,
    });
    expect(model.selectionEntries).toEqual([]);
  });

  test('an empty time-list search does not force a Projects header or fabricate results', () => {
    const input = args([], 'timeline');
    input.listGrouping = 'time';
    input.mode = 'search';
    input.normalizedQuery = 'does not match';
    const model = buildSessionSidebarRowModel(input);
    expect(model.rows.some((row) => row.key === 'activity:timeline:header')).toBe(false);
    expect(model.searchMatchCount).toBe(0);
    expect(model.selectionEntries).toEqual([]);
  });
});
