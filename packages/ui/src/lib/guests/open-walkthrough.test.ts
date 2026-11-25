import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWebGitAPI } from '../../../../web/src/api/git';
import type { GitAPI, SourceControlBindingRead } from '@/lib/api/types';
import { markWorktreeBootstrapPending, clearWorktreeBootstrapState } from '@/lib/worktrees/worktreeBootstrap';
import { captureRuntimeInstance, getRuntimeKey, getRuntimeApiBaseUrl, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';

import { openGuestWalkthrough, readWalkthroughRepository, supportsGuestWalkthrough, type WalkthroughRepository } from './open-walkthrough';

const repository: WalkthroughRepository = {
  directory: '/repo',
  autoSelected: false,
  branch: 'topic',
  branches: ['topic', 'main', 'remotes/origin/main', 'remotes/origin/topic', 'remotes/other/main'],
  remoteNames: new Set(['origin', 'other']),
  primaryRemote: 'origin',
};
const open = (base: string, overrides: Partial<Parameters<typeof openGuestWalkthrough>[0]> = {}) => openGuestWalkthrough({
  base, directory: '/repo', supported: true, ownsScope: () => true, readRepository: async () => repository, ...overrides,
});
const targetAt = (directory = '/repo') => useWalkthroughStore.getState().getRequestedTarget(directory);
const tabsAt = (directory = '/repo') => useUIStore.getState().contextPanelByDirectory[directory]?.tabs;
const binding: SourceControlBindingRead = {
  status: 'missing', revision: 0, binding: null,
  repository: { repositoryId: 'walkthrough-test', configRevision: 'fixture', bare: false, remotes: [] },
};
const sourceControl = { repositoryBinding: async () => binding };
const gitStatus = (current: string) => ({ current, tracking: null, ahead: 0, behind: 0, files: [], isClean: true });

afterEach(() => {
  useGitBaseBranchStore.setState({ overrides: {} });
  useGitStore.setState({ nestedRepoSelection: new Map() });
  useWalkthroughStore.setState({ requestedTargets: {} });
  useUIStore.setState({ contextPanelByDirectory: {} });
});

describe('guest walkthrough', () => {
  test('resolves a branch in the actual repository and opens a scoped walkthrough target', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'walkthrough-refs-'));
    const git = (...args: string[]) => execFileSync(
      'git', ['-C', directory, '-c', `core.hooksPath=${join(directory, 'unused-hooks')}`, ...args], { encoding: 'utf8' },
    ).trim();
    try {
      git('init', '-q', '-b', 'main');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
      git('switch', '-qc', 'topic');
      git('branch', 'release/2026');
      git('tag', 'release-tag');
      const gitApi: GitAPI = {
        ...createWebGitAPI(),
        checkIsGitRepository: async (scope) => {
          expect(scope).toBe(directory);
          return git('rev-parse', '--is-inside-work-tree') === 'true';
        },
        getGitStatus: async (scope, options) => {
          expect(scope).toBe(directory);
          expect(options).toEqual({ fresh: true });
          return gitStatus(git('branch', '--show-current'));
        },
        getGitBranches: async (scope, options) => {
          expect(scope).toBe(directory);
          expect(options).toEqual({ remote: 'local' });
          return {
            all: git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n'),
            current: git('branch', '--show-current'),
            branches: {},
          };
        },
      };
      const readRepository = (scope: string, isCurrent: () => boolean) =>
        readWalkthroughRepository(gitApi, sourceControl, scope, isCurrent);
      expect(await open('release-tag', { directory, readRepository })).toMatchObject({ code: 'NOT_FOUND' });
      expect(tabsAt(directory)).toBeUndefined();
      expect(await open('release/2026', { directory, readRepository })).toEqual({ ok: true });
      expect(targetAt(directory)?.source).toEqual({ kind: 'branch', baseRef: 'refs/heads/release/2026', headRef: 'topic' });
      expect(tabsAt(directory)?.map((tab) => tab.mode)).toContain('walkthrough');
      git('branch', '-D', 'release/2026');
      expect(await open('release/2026', { directory, readRepository })).toMatchObject({ code: 'NOT_FOUND' });
      git('switch', '-q', '--detach');
      expect(await open('main', { directory, readRepository })).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('uses the bound remote and preserves the chosen base when a request is refused', async () => {
    expect(await open('main')).toEqual({ ok: true });
    expect(targetAt()?.source).toEqual({ kind: 'branch', baseRef: 'origin/main', headRef: 'topic' });
    for (const base of ['topic', 'refs/remotes/origin/topic', 'other/main', 'refs/remotes/origin/missing', 'HEAD~1']) {
      expect(await open(base)).toMatchObject({ code: 'NOT_FOUND' });
    }
    const localOnly = { ...repository, branches: ['topic', 'main'] };
    expect(await open('refs/remotes/origin/main', { readRepository: async () => localOnly })).toMatchObject({ code: 'NOT_FOUND' });
    expect(useGitBaseBranchStore.getState().getOverride('/repo', 'topic')).toBe('origin/main');
    expect(await open('refs/heads/main')).toEqual({ ok: true });
    expect(targetAt()?.source).toEqual({ kind: 'branch', baseRef: 'refs/heads/main', headRef: 'topic' });
  });

  test('refuses an explicit remote ref if the picker would reinterpret its name', async () => {
    const readRepository = async () => ({
      ...repository, branches: [...repository.branches, 'origin/main', 'remotes/origin/origin/main'],
    });
    expect(await open('refs/remotes/origin/main', { readRepository })).toMatchObject({ code: 'NOT_FOUND' });
    expect(targetAt()).toBeUndefined();
  });

  test('rejects unsupported and missing hosts before reading Git', async () => {
    let reads = 0;
    const readRepository = async () => { reads += 1; return repository; };
    expect(await open('main', { supported: false, readRepository })).toMatchObject({ code: 'UNSUPPORTED' });
    expect(await open('main', { directory: null, readRepository })).toMatchObject({ code: 'NO_DIRECTORY' });
    expect(await open('main', { readRepository: null })).toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(reads).toBe(0);
  });

  test('recognizes the unsupported Mini Chat, VS Code, hosted-mobile and Capacitor surfaces', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const setWindow = (value: {
      __OPENCHAMBER_SURFACE__: 'desktop' | 'mobile';
      __VSCODE_CONFIG__?: { panelType: 'chat' };
      Capacitor?: { isNativePlatform: () => boolean };
    }) => {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        location: new URL('https://walkthrough.example.test/'), ...value,
      } });
    };
    try {
      setWindow({ __OPENCHAMBER_SURFACE__: 'desktop' });
      expect(supportsGuestWalkthrough(false)).toBe(true);
      expect(supportsGuestWalkthrough(true)).toBe(false);
      setWindow({ __OPENCHAMBER_SURFACE__: 'desktop', __VSCODE_CONFIG__: { panelType: 'chat' } });
      expect(supportsGuestWalkthrough(false)).toBe(false);
      setWindow({ __OPENCHAMBER_SURFACE__: 'mobile' });
      expect(supportsGuestWalkthrough(false)).toBe(false);
      setWindow({ __OPENCHAMBER_SURFACE__: 'desktop', Capacitor: { isNativePlatform: () => true } });
      expect(supportsGuestWalkthrough(false)).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'window', original);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('refuses if fresh status and the branch list observe different checkouts', async () => {
    const gitApi: GitAPI = {
      ...createWebGitAPI(),
      checkIsGitRepository: async () => true,
      getGitStatus: async () => gitStatus('topic'),
      getGitBranches: async () => ({ all: ['main', 'topic'], current: 'main', branches: {} }),
    };
    const readRepository = (scope: string, isCurrent: () => boolean) =>
      readWalkthroughRepository(gitApi, sourceControl, scope, isCurrent);
    expect(await open('main', { readRepository })).toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(tabsAt()).toBeUndefined();
  });

  test('declines a pending worktree before using any Git API', async () => {
    const gitApi: GitAPI = { ...createWebGitAPI(), checkIsGitRepository: async () => { throw new Error('unexpected Git read'); } };
    let reads = 0;
    const readRepository = (scope: string, isCurrent: () => boolean) =>
      readWalkthroughRepository({
        ...gitApi, checkIsGitRepository: async () => { reads += 1; return true; },
      }, sourceControl, scope, isCurrent);
    markWorktreeBootstrapPending('/repo');
    try {
      expect(await open('main', { readRepository })).toMatchObject({ code: 'HOST_UNAVAILABLE' });
      expect(reads).toBe(0);
    } finally {
      clearWorktreeBootstrapState('/repo');
    }
  });

  test('does not open a walkthrough after the frame scope has changed', async () => {
    let active = true;
    const readRepository = async () => { active = false; return repository; };
    expect(await open('main', { ownsScope: () => active, readRepository })).toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(targetAt()).toBeUndefined();
    expect(tabsAt()).toBeUndefined();
  });

  test('retains changes to nested selection even if the original selection is restored', async () => {
    useGitStore.setState({ nestedRepoSelection: new Map([['/repo', '/repo/nested']]) });
    const readRepository = async () => {
      useGitStore.setState({ nestedRepoSelection: new Map([['/repo', '/repo/other']]) });
      useGitStore.setState({ nestedRepoSelection: new Map([['/repo', '/repo/nested']]) });
      return { ...repository, directory: '/repo/nested' };
    };
    expect(await open('main', { readRepository })).toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(targetAt('/repo/nested')).toBeUndefined();
  });

  test('rejects a runtime round trip even when the original runtime key returns', async () => {
    const original = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    const initial = captureRuntimeInstance();
    const readRepository = async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://walkthrough-fixture.invalid', runtimeKey: 'walkthrough-fixture' });
      switchRuntimeEndpoint(original);
      expect(initial()).toBe(false);
      return repository;
    };
    expect(await open('main', { readRepository })).toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(targetAt()).toBeUndefined();
  });

  test('addresses the selected nested repository through the frame directory', async () => {
    useGitStore.setState({ nestedRepoSelection: new Map([['/repo', '/repo/nested']]) });
    expect(await open('main', { readRepository: async () => ({ ...repository, directory: '/repo/nested' }) })).toEqual({ ok: true });
    expect(targetAt('/repo/nested')?.source.kind).toBe('branch');
    expect(targetAt()).toBeUndefined();
    expect(tabsAt()?.some((tab) => tab.mode === 'walkthrough')).toBe(true);
  });
});
