import type { HostRequestErrorCode } from '@openchamber/sdk';

import { resolveBranchComparisonBase } from '@/components/views/git/baseBranch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import type { GitAPI, SourceControlAPI } from '@/lib/api/types';
import { chooseAutoNestedRepo, discoversNestedRepos } from '@/lib/nestedRepositories';
import { isAbsoluteFilePath, isFilePathWithinDirectory } from '@/lib/path-utils';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { repositoryBindingOwner } from '@/lib/source-control/repository-binding';
import { getWorktreeBootstrapState } from '@/lib/worktrees/worktreeBootstrap';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';

export const supportsGuestWalkthrough = (isMiniChat: boolean): boolean =>
  !isMiniChat && !isVSCodeRuntime() && !isCapacitorApp() && !isMobileSurfaceRuntime();

export type GuestOpenWalkthroughResult =
  | { ok: true }
  | { ok: false; code: HostRequestErrorCode; message: string };

export type WalkthroughRepository = {
  directory: string;
  autoSelected: boolean;
  branch: string | null;
  branches: readonly string[];
  remoteNames: ReadonlySet<string>;
  primaryRemote: string | null | undefined;
};

type OpenGuestWalkthroughOptions = {
  base: string;
  directory: string | null;
  readRepository: ((directory: string, isCurrent: () => boolean) => Promise<WalkthroughRepository | null>) | null;
  ownsScope: () => boolean;
  supported: boolean;
};

function resolveRequestedBase(base: string, repository: WalkthroughRepository, branch: string) {
  const { branches, remoteNames, primaryRemote } = repository;
  const localBranches = branches.filter((name) => !name.startsWith('remotes/'));
  const remoteBranches = branches.filter((name) => name.startsWith('remotes/')).map((name) => name.slice('remotes/'.length));
  const ref = base.trim();
  const stripped = ref.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '');
  const remote = stripped.split('/', 1)[0] ?? '';
  // A qualified request names a specific remote-tracking ref. The shared
  // picker can fall back to a local branch for a missing remote ref.
  const explicitRemote = stripped !== ref || (ref.includes('/') && remoteNames.has(remote) && !localBranches.includes(ref));
  if (explicitRemote && (stripped === `${remote}/HEAD` || !remoteBranches.includes(stripped))) return null;
  const resolved = resolveBranchComparisonBase({ chosen: ref, pullRequest: null, createdFrom: null, defaultBranch: null }, {
    localBranches, remoteBranches, remoteNames, primaryRemote, headBranch: branch,
  });
  return resolved && (!explicitRemote || resolved.ref === stripped) ? resolved.ref : null;
}

export async function openGuestWalkthrough({
  base, directory, readRepository, ownsScope, supported,
}: OpenGuestWalkthroughOptions): Promise<GuestOpenWalkthroughResult> {
  if (!supported) return { ok: false, code: 'UNSUPPORTED', message: 'Changes Walkthrough is unavailable on this surface.' };
  if (!directory || !isAbsoluteFilePath(directory)) return { ok: false, code: 'NO_DIRECTORY', message: 'No project is open.' };
  if (!readRepository) return { ok: false, code: 'HOST_UNAVAILABLE', message: 'Git is not available yet.' };

  const isRuntimeCurrent = captureRuntimeInstance();
  let selectionChanged = false;
  const unsubscribe = useGitStore.subscribe((state, previous) => {
    if (state.nestedRepoSelection.get(directory) !== previous.nestedRepoSelection.get(directory)) selectionChanged = true;
  });
  const isCurrent = () => !selectionChanged && isRuntimeCurrent() && ownsScope();
  const retired = { ok: false, code: 'HOST_UNAVAILABLE', message: 'The project or connection changed.' } satisfies GuestOpenWalkthroughResult;
  let repository: WalkthroughRepository | null;
  try {
    if (!isCurrent()) return retired;
    repository = await readRepository(directory, isCurrent);
    if (!isCurrent()) return retired;
  } catch {
    return isCurrent() ? { ok: false, code: 'HOST_UNAVAILABLE', message: 'Could not read this repository.' } : retired;
  } finally {
    unsubscribe();
  }

  if (!repository) return { ok: false, code: 'NOT_FOUND', message: 'This project has no Git repository.' };
  const { directory: gitDirectory, autoSelected, branch } = repository;
  if (!isFilePathWithinDirectory(gitDirectory, directory)) return retired;
  if (!branch) return { ok: false, code: 'NOT_FOUND', message: 'No branch is checked out.' };
  const baseRef = resolveRequestedBase(base, repository, branch);
  if (!baseRef) return { ok: false, code: 'NOT_FOUND', message: 'That base is unavailable for the checked-out branch.' };

  if (autoSelected) useGitStore.getState().selectNestedRepo(directory, gitDirectory);
  useGitBaseBranchStore.getState().setOverride(gitDirectory, branch, baseRef);
  useWalkthroughStore.getState().requestTarget(gitDirectory, { source: { kind: 'branch', baseRef, headRef: branch } });
  useUIStore.getState().openContextPanelTab(directory, { mode: 'walkthrough' });
  return { ok: true };
}

async function locateRepository(git: GitAPI, root: string, isCurrent: () => boolean) {
  const store = useGitStore.getState();
  const selected = store.nestedRepoSelection.get(root);
  if (selected) return { directory: selected, autoSelected: false };

  const rootIsRepository = await git.checkIsGitRepository(root);
  if (!isCurrent()) throw new Error('Project scope changed');
  if (rootIsRepository) return { directory: root, autoSelected: false };
  if (!discoversNestedRepos(root, useDirectoryStore.getState().homeDirectory)) return null;

  await store.ensureNestedRepos(root);
  const { nestedReposByRoot, staleClearedSelections } = useGitStore.getState();
  const candidates = nestedReposByRoot.get(root);
  if (candidates === null) throw new Error('Nested repositories could not be listed');
  if (!Array.isArray(candidates)) return null;
  const rejected = staleClearedSelections.get(root);
  const directory = chooseAutoNestedRepo(root, candidates.filter((item) => !rejected?.has(item)));
  return directory ? { directory, autoSelected: true } : null;
}

function assertRepositoryReady(directory: string, isCurrent: () => boolean) {
  if (!isCurrent() || getWorktreeBootstrapState(directory)?.status === 'pending') {
    throw new Error('Repository is unavailable');
  }
}

export async function readWalkthroughRepository(
  git: GitAPI, sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>, root: string, isCurrent: () => boolean,
): Promise<WalkthroughRepository | null> {
  assertRepositoryReady(root, isCurrent);
  const location = await locateRepository(git, root, isCurrent);
  if (!location) return null;
  const { directory } = location;
  if (!isFilePathWithinDirectory(directory, root)) throw new Error('Repository is outside the project');
  assertRepositoryReady(directory, isCurrent);

  const [status, branches, binding] = await Promise.all([
    git.getGitStatus(directory, { fresh: true }),
    git.getGitBranches(directory, { remote: 'local' }),
    repositoryBindingOwner.read(repositoryBindingOwner.scope(directory), sourceControl, true),
  ]);
  assertRepositoryReady(directory, isCurrent);
  if (binding.status !== 'ready') throw new Error('Repository binding is unavailable');
  const branch = status.current && status.current !== 'HEAD' && !status.unborn ? status.current : null;
  if (branch && (branches.current !== branch || !branches.all.includes(branch))) {
    throw new Error('Checked-out branch changed during the read');
  }

  // Publish the same snapshots to the existing Walkthrough view. Its picker
  // shares these caches and can otherwise still see the previous branch/base.
  if (branch) {
    const snapshots = {
      ...git,
      checkIsGitRepository: async () => true,
      getGitStatus: async () => status,
      getGitBranches: async () => branches,
    };
    const store = useGitStore.getState();
    await Promise.all([
      store.fetchStatus(directory, snapshots, { force: true, silent: true, throwOnError: true }),
      store.fetchBranches(directory, snapshots),
    ]);
    assertRepositoryReady(directory, isCurrent);
  }
  return {
    ...location, branch, branches: branches.all,
    remoteNames: new Set(binding.read.repository.remotes.map((remote) => remote.name)),
    primaryRemote: binding.contexts[0]?.primaryRemote,
  };
}
