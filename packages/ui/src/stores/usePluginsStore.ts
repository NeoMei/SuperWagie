import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { startConfigUpdate } from '@/lib/configUpdate';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import {
  checkPluginUpdates,
  listPluginRuntime,
  updatePluginPackage,
  type PluginRuntimeInfo,
} from '@/lib/opencode/plugins';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export type PluginScope = 'user' | 'project';
/** `control` is an OpenCode 2 entry such as `-name` or `*` that turns known plugins off or on. */
export type PluginParsedKind = 'control' | 'npm' | 'path' | 'git';

export interface PluginEntry {
  id: string;
  spec: string;
  options?: Record<string, unknown>;
  scope: PluginScope;
  kind: 'config';
  parsedKind: PluginParsedKind;
  /** The config file that declares the entry; relative path specs resolve against its directory. */
  sourcePath?: string;
  /** Host-resolved local target used only to filter duplicate discovery records. */
  resolvedPath?: string;
}

export interface PluginFile {
  id: string;
  fileName: string;
  scope: PluginScope;
  /** `file` is a `.ts`/`.js` OpenChamber can open; `package` is a plugin directory (or a v1 `plugin/` file) OpenCode loads but the page only lists. */
  kind: 'file' | 'package';
  absolutePath?: string;
  /** Host-resolved local target used only to filter duplicate discovery records. */
  resolvedPath?: string;
}

export interface PluginDraft {
  mode: 'entry' | 'file';
  scope: PluginScope;
  spec: string;
  optionsJson: string;
  fileName: string;
  content: string;
}

export type PluginMutationResult = {
  ok: boolean;
  reloadFailed?: boolean;
  message?: string;
  warning?: string;
  requiresManualRestart?: boolean;
  /** The server refused the spec: OpenCode cannot load it. Nothing was written. */
  invalidSpec?: boolean;
};

export type RegistryResult =
  | { kind: 'npm-ok'; spec: string; name: string; currentVersion: string | null; latestVersion: string | null; versions: string[]; hasUpdate: boolean }
  | { kind: 'npm-missing-version'; spec: string; name: string; currentVersion: string; latestVersion: string | null; versions: string[] }
  | { kind: 'npm-missing-package'; spec: string; name: string; error: string }
  | { kind: 'npm-malformed'; spec: string; error: string }
  | { kind: 'npm-network'; spec: string; error: string }
  | { kind: 'path-ok'; spec: string; absolutePath: string }
  | { kind: 'path-missing'; spec: string; absolutePath: string }
  | { kind: 'path-unreadable'; spec: string; absolutePath: string }
  /** A Git package spec: OpenCode resolves it itself, so there is nothing to check. */
  | { kind: 'git-ok'; spec: string };

/**
 * What OpenCode reported for the plugins of one directory and runtime
 * (`scope`, see `getPluginsScopeKey`). `failed` means the read failed: every
 * plugin's status is unknown, never "all fine" and never "all failed".
 */
type PluginRuntimeSnapshot =
  | { kind: 'idle' }
  | { kind: 'ready'; scope: string; plugins: PluginRuntimeInfo[] }
  | { kind: 'failed'; scope: string };

/** An update this client started, keyed by `getPluginUpdateKey`. */
export type PluginPackageUpdate =
  | { kind: 'running' }
  | { kind: 'failed'; error: string };

interface PluginsStore {
  entries: PluginEntry[];
  loadedDirectory: string | null | undefined;
  loadedRuntimeKey: string | undefined;
  loadedOwner?: () => boolean;
  files: PluginFile[];
  selectedId: string | null;
  isLoading: boolean;
  registryInfo: Record<string, RegistryResult>;
  isLoadingRegistry: boolean;
  draft: PluginDraft | null;
  runtime: PluginRuntimeSnapshot;
  isCheckingUpdates: boolean;
  packageUpdates: Record<string, PluginPackageUpdate>;

  setSelected: (id: string | null) => void;
  setDraft: (draft: PluginDraft | null) => void;
  loadPlugins: (options?: { force?: boolean }) => Promise<boolean>;
  loadRegistryInfo: (opts?: { specs?: string[]; force?: boolean }) => Promise<boolean>;
  updateToLatest: (id: string) => Promise<PluginMutationResult>;
  loadRuntime: () => Promise<boolean>;
  checkUpdates: () => Promise<boolean>;
  updatePackage: (target: string) => Promise<boolean>;
  createEntry: (input: { spec: string; options?: Record<string, unknown>; scope: PluginScope }) => Promise<PluginMutationResult>;
  updateEntry: (id: string, input: { spec?: string; options?: Record<string, unknown> }) => Promise<PluginMutationResult>;
  deleteEntry: (id: string) => Promise<PluginMutationResult>;
  readFile: (id: string) => Promise<{ fileName: string; scope: PluginScope; content: string } | null>;
  createFile: (input: { fileName: string; content: string; scope: PluginScope }) => Promise<PluginMutationResult>;
  updateFile: (id: string, input: { content: string }) => Promise<PluginMutationResult>;
  deleteFile: (id: string) => Promise<PluginMutationResult>;
  getById: (id: string) => PluginEntry | PluginFile | undefined;
}

type PluginsListResponse = {
  entries?: PluginEntry[];
  files?: PluginFile[];
};

type RegistryInfoResponse = {
  results?: RegistryResult[];
};

type PluginMutationPayload = {
  success?: boolean;
  requiresReload?: boolean;
  requiresManualRestart?: boolean;
  message?: string;
  reloadDelayMs?: number;
  reloadFailed?: boolean;
  warning?: string;
  error?: string;
  code?: string;
};

type PluginFileContent = {
  fileName: string;
  scope: PluginScope;
  content: string;
};

export const getPluginsConfigDirectory = (): string | null => {
  try {
    const projectsStore = useProjectsStore.getState();
    const activeProject = projectsStore.getActiveProject?.();
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (err) {
    console.warn('[PluginsStore] Error resolving config directory:', err);
  }
  return null;
};

const CLIENT_RELOAD_DELAY_MS = 800;
const PLUGINS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_PLUGINS_CACHE_KEY = '__default__';
const pluginsLastLoadedAt = new Map<string, number>();
const pluginsLoadInFlight = new Map<string, { request: Promise<boolean>; owns: () => boolean }>();
const REGISTRY_SPECS_CHUNK_LIMIT = 1500;

const getPluginCacheKey = (directory: string | null): string => {
  return JSON.stringify([getRuntimeKey(), directory?.trim() || DEFAULT_PLUGINS_CACHE_KEY]);
};

/** Identifies the directory and runtime a runtime snapshot or update belongs to. */
export const getPluginsScopeKey = getPluginCacheKey;

export const getPluginUpdateKey = (scope: string, target: string): string => JSON.stringify([scope, target]);

// Only the newest runtime read may commit: a slower earlier one (or one for a
// directory the user already left) would put back an older inventory.
let runtimeReadGeneration = 0;
let registryReadGeneration = 0;
let updateCheckGeneration = 0;
let directoryGeneration = 0;
let selectionGeneration = 0;

/** Captures the existing active-project-first resolver and its runtime visit. */
export const capturePluginsOwner = (): (() => boolean) => {
  ensurePluginScopeTracking();
  const ownsRuntime = captureRuntimeInstance();
  const directory = getPluginsConfigDirectory();
  const generation = directoryGeneration;
  return () => ownsRuntime() && generation === directoryGeneration && directory === getPluginsConfigDirectory();
};

const invalidatePluginCache = (directory: string | null) => {
  pluginsLastLoadedAt.delete(getPluginCacheKey(directory));
};

export const usePluginsStore = create<PluginsStore>()(
  devtools(
    persist(
      (set, get) => ({
        entries: [],
        loadedDirectory: undefined,
        loadedRuntimeKey: undefined,
        loadedOwner: undefined,
        files: [],
        selectedId: null,
        isLoading: false,
        registryInfo: {},
        isLoadingRegistry: false,
        draft: null,
        runtime: { kind: 'idle' },
        isCheckingUpdates: false,
        packageUpdates: {},

        setSelected: (id) => set({ selectedId: id }),

        setDraft: (draft) => set({ draft }),

        loadPlugins: async (options) => {
          const configDirectory = getPluginsConfigDirectory();
          const owns = capturePluginsOwner();
          const runtimeKey = getRuntimeKey();
          const cacheKey = getPluginCacheKey(configDirectory);
          const now = Date.now();
          const loadedAt = pluginsLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedPlugins = (get().loadedOwner?.() ?? true) && get().loadedRuntimeKey === runtimeKey && get().loadedDirectory === configDirectory
            && (get().entries.length > 0 || get().files.length > 0);

          if (!options?.force && hasCachedPlugins && now - loadedAt < PLUGINS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = pluginsLoadInFlight.get(cacheKey);
          if (!options?.force && inFlight?.owns()) {
            return inFlight.request;
          }

          void get().loadRuntime();

          const request = (async () => {
            set({ isLoading: true });
            try {
              const response = await runtimeFetch(buildPluginsUrl('/api/config/plugins', configDirectory), {
                headers: buildDirectoryHeaders(configDirectory),
              });
              if (!owns()) return false;
              if (!response.ok) {
                throw new Error('Failed to load plugins');
              }
              const data = await readJson<PluginsListResponse>(response);
              if (!owns()) return false;
              set({ entries: data.entries ?? [], files: data.files ?? [], loadedDirectory: configDirectory, loadedRuntimeKey: runtimeKey, loadedOwner: owns, isLoading: false });
              pluginsLastLoadedAt.set(cacheKey, Date.now());
              if (!options?.force) {
                void get().loadRegistryInfo();
              }
              return true;
            } catch (error) {
              if (!owns()) return false;
              console.error('[PluginsStore] Failed to load plugins:', error);
              set({ isLoading: false });
              return false;
            }
          })();

          pluginsLoadInFlight.set(cacheKey, { request, owns });
          try {
            return await request;
          } finally {
            if (pluginsLoadInFlight.get(cacheKey)?.request === request) pluginsLoadInFlight.delete(cacheKey);
          }
        },

        loadRegistryInfo: async (opts) => {
          const owns = capturePluginsOwner();
          const generation = ++registryReadGeneration;
          const isCurrent = () => owns() && generation === registryReadGeneration;
          const configDirectory = getPluginsConfigDirectory();
          const specs = dedupeSpecs(opts?.specs ?? get().entries.map((entry) => entry.spec));
          if (specs.length === 0) {
            set({ isLoadingRegistry: false });
            return true;
          }

          set({ isLoadingRegistry: true });
          try {
            const nextRegistryInfo: Record<string, RegistryResult> = { ...get().registryInfo };
            for (const chunk of chunkSpecs(specs)) {
              if (!isCurrent()) return false;
              const response = await runtimeFetch(buildRegistryUrl(chunk, opts?.force === true, configDirectory), {
                headers: buildDirectoryHeaders(configDirectory),
              });
              if (!isCurrent()) return false;
              if (!response.ok) {
                throw new Error('Failed to load plugin registry info');
              }
              const data = await readJson<RegistryInfoResponse>(response);
              if (!isCurrent()) return false;
              for (const result of data.results ?? []) {
                nextRegistryInfo[result.spec] = result;
              }
            }
            set({ registryInfo: nextRegistryInfo, isLoadingRegistry: false });
            return true;
          } catch (error) {
            if (!isCurrent()) return false;
            console.error('[PluginsStore] Failed to load plugin registry info:', error);
            set({ isLoadingRegistry: false });
            return false;
          }
        },

        loadRuntime: async () => {
          const owns = capturePluginsOwner();
          const configDirectory = getPluginsConfigDirectory();
          const scope = getPluginsScopeKey(configDirectory);
          const generation = ++runtimeReadGeneration;
          try {
            const plugins = await listPluginRuntime(configDirectory);
            if (!owns() || generation !== runtimeReadGeneration) return false;
            set({ runtime: { kind: 'ready', scope, plugins } });
            return true;
          } catch (error) {
            if (!owns() || generation !== runtimeReadGeneration) return false;
            console.error('[PluginsStore] Failed to read plugin status from OpenCode:', error);
            set({ runtime: { kind: 'failed', scope } });
            return false;
          }
        },

        checkUpdates: async () => {
          const owns = capturePluginsOwner();
          const generation = ++updateCheckGeneration;
          const isCurrent = () => owns() && generation === updateCheckGeneration;
          const configDirectory = getPluginsConfigDirectory();
          const scope = getPluginsScopeKey(configDirectory);
          set({ isCheckingUpdates: true });
          try {
            const plugins = await checkPluginUpdates(configDirectory);
            // A check returns the whole inventory, so once it lands it
            // supersedes list reads still in flight. Claiming the generation
            // only on success keeps a failed check from discarding them.
            if (!isCurrent()) return false;
            runtimeReadGeneration += 1;
            set({ runtime: { kind: 'ready', scope, plugins } });
            return true;
          } catch (error) {
            if (!isCurrent()) return false;
            // The inventory already on screen is still what OpenCode loaded;
            // only its update flags were not refreshed. The caller reports it.
            console.error('[PluginsStore] Failed to check plugin updates:', error);
            return false;
          } finally {
            if (isCurrent()) set({ isCheckingUpdates: false });
          }
        },

        updatePackage: async (target) => {
          const owns = capturePluginsOwner();
          const configDirectory = getPluginsConfigDirectory();
          const key = getPluginUpdateKey(getPluginsScopeKey(configDirectory), target);
          if (get().packageUpdates[key]?.kind === 'running') return false;
          set({ packageUpdates: { ...get().packageUpdates, [key]: { kind: 'running' } } });
          try {
            await updatePluginPackage(configDirectory, target);
            if (!owns()) return false;
            // OpenCode announces the reload with `plugin.updated`; reading now
            // clears the update flag even when that event is missed. The row
            // stays running until then so the stale flag can't offer a rerun.
            await get().loadRuntime();
            if (!owns()) return false;
            const next = { ...get().packageUpdates };
            delete next[key];
            set({ packageUpdates: next });
            return true;
          } catch (error) {
            if (!owns()) return false;
            const message = error instanceof OpencodeApiError ? error.detail : error instanceof Error ? error.message : String(error);
            set({ packageUpdates: { ...get().packageUpdates, [key]: { kind: 'failed', error: message } } });
            return false;
          }
        },

        updateToLatest: async (id) => {
          const entry = get().entries.find((plugin) => plugin.id === id);
          if (!entry) return { ok: false };
          const info = get().registryInfo[entry.spec];
          if (!info || info.kind !== 'npm-ok' || !info.hasUpdate || !info.latestVersion) {
            return { ok: false };
          }
          return await get().updateEntry(id, { spec: `${info.name}@${info.latestVersion}` });
        },

        createEntry: async (input) => {
          const owns = capturePluginsOwner();
          const result = await runPluginMutation('Creating plugin entry…', async (configDirectory) => {
            const response = await runtimeFetch(buildPluginsUrl('/api/config/plugins/entry', configDirectory), {
              method: 'POST',
              headers: buildJsonHeaders(configDirectory),
              body: JSON.stringify(buildEntryBody(input)),
            });
            return response;
          }, get);
          if (!owns()) return { ok: false };
          if (result.ok) {
            void get().loadRegistryInfo({ specs: [input.spec], force: true });
          }
          return result;
        },

        updateEntry: async (id, input) => {
          const owns = capturePluginsOwner();
          const existingSpec = get().entries.find((plugin) => plugin.id === id)?.spec;
          const nextSpec = input.spec ?? existingSpec;
          const result = await runPluginMutation('Updating plugin entry…', async (configDirectory) => {
            const response = await runtimeFetch(buildPluginsUrl(`/api/config/plugins/entry/${encodeURIComponent(id)}`, configDirectory), {
              method: 'PATCH',
              headers: buildJsonHeaders(configDirectory),
              body: JSON.stringify(buildEntryBody(input)),
            });
            return response;
          }, get);
          if (!owns()) return { ok: false };
          if (result.ok && nextSpec) {
            void get().loadRegistryInfo({ specs: [nextSpec], force: true });
          }
          return result;
        },

        deleteEntry: async (id) => {
          const owns = capturePluginsOwner();
          const selectedVisit = selectionGeneration;
          const draft = get().draft;
          const entryToDelete = get().entries.find((plugin) => plugin.id === id);
          const result = await runPluginMutation('Deleting plugin entry…', async (configDirectory) => {
            const response = await runtimeFetch(buildPluginsUrl(`/api/config/plugins/entry/${encodeURIComponent(id)}`, configDirectory), {
              method: 'DELETE',
              headers: buildDirectoryHeaders(configDirectory),
            });
            return response;
          }, get);

          if (!owns()) return { ok: false };
          if (result.ok && selectedVisit === selectionGeneration && get().selectedId === id && (get().draft === draft || get().draft === null)) {
            set({ selectedId: null });
          }
          if (result.ok && entryToDelete) {
            const nextRegistryInfo = { ...get().registryInfo };
            delete nextRegistryInfo[entryToDelete.spec];
            set({ registryInfo: nextRegistryInfo });
          }
          return result;
        },

        readFile: async (id) => {
          const owns = capturePluginsOwner();
          const configDirectory = getPluginsConfigDirectory();
          try {
            const response = await runtimeFetch(buildPluginsUrl(`/api/config/plugins/file/${encodeURIComponent(id)}`, configDirectory), {
              headers: buildDirectoryHeaders(configDirectory),
            });
            if (!owns()) return null;
            if (!response.ok) {
              throw new Error('Failed to read plugin file');
            }
            const content = await readJson<PluginFileContent>(response);
            return owns() ? content : null;
          } catch (error) {
            if (!owns()) return null;
            console.error('[PluginsStore] Failed to read plugin file:', error);
            return null;
          }
        },

        createFile: async (input) => {
          return runPluginMutation('Creating plugin file…', async (configDirectory) => {
            const response = await runtimeFetch(buildPluginsUrl('/api/config/plugins/file', configDirectory), {
              method: 'POST',
              headers: buildJsonHeaders(configDirectory),
              body: JSON.stringify(input),
            });
            return response;
          }, get);
        },

        updateFile: async (id, input) => {
          return runPluginMutation('Updating plugin file…', async (configDirectory) => {
            const response = await runtimeFetch(buildPluginsUrl(`/api/config/plugins/file/${encodeURIComponent(id)}`, configDirectory), {
              method: 'PUT',
              headers: buildJsonHeaders(configDirectory),
              body: JSON.stringify(input),
            });
            return response;
          }, get);
        },

        deleteFile: async (id) => {
          const owns = capturePluginsOwner();
          const selectedVisit = selectionGeneration;
          const draft = get().draft;
          const result = await runPluginMutation('Deleting plugin file…', async (configDirectory) => {
            const response = await runtimeFetch(buildPluginsUrl(`/api/config/plugins/file/${encodeURIComponent(id)}`, configDirectory), {
              method: 'DELETE',
              headers: buildDirectoryHeaders(configDirectory),
            });
            return response;
          }, get);

          if (!owns()) return { ok: false };
          if (result.ok && selectedVisit === selectionGeneration && get().selectedId === id && (get().draft === draft || get().draft === null)) {
            set({ selectedId: null });
          }
          return result;
        },

        getById: (id) => {
          return get().entries.find((plugin) => plugin.id === id) ?? get().files.find((plugin) => plugin.id === id);
        },
      }),
      {
        name: 'plugins-store',
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({ selectedId: state.selectedId }),
      },
    ),
    { name: 'plugins-store' },
  ),
);

let pluginScopeTracking = false;
function ensurePluginScopeTracking() {
  if (pluginScopeTracking) return;
  pluginScopeTracking = true;
  let observedDirectory = getPluginsConfigDirectory();
  let observedRuntime = captureRuntimeInstance();
  const retireScope = () => {
    usePluginsStore.setState({ isLoading: false, isLoadingRegistry: false, isCheckingUpdates: false, packageUpdates: {} });
  };
  useProjectsStore.subscribe(() => {
    const directory = getPluginsConfigDirectory();
    if (directory === observedDirectory) return;
    observedDirectory = directory;
    directoryGeneration += 1;
    retireScope();
  });
  subscribeRuntimeEndpointChanged(() => {
    if (observedRuntime()) return;
    observedRuntime = captureRuntimeInstance();
    retireScope();
  });
}
usePluginsStore.subscribe((state, previous) => {
  if (state.selectedId !== previous.selectedId) selectionGeneration += 1;
});

function buildPluginsUrl(path: string, directory: string | null): string {
  const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return `${path}${queryParams}`;
}

function buildRegistryUrl(specs: string[], force: boolean, directory: string | null): string {
  const params = new URLSearchParams();
  if (force) params.set('refresh', 'true');
  if (directory) params.set('directory', directory);
  const suffix = params.toString();
  const specsParam = `specs=${specs.map(encodeURIComponent).join(',')}`;
  return `/api/config/plugins/registry?${specsParam}${suffix ? `&${suffix}` : ''}`;
}

function dedupeSpecs(specs: string[]): string[] {
  return Array.from(new Set(specs.map((spec) => spec.trim()).filter(Boolean)));
}

function chunkSpecs(specs: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const spec of specs) {
    const encodedSpec = encodeURIComponent(spec);
    const nextLength = current.length === 0 ? encodedSpec.length : currentLength + 1 + encodedSpec.length;
    if (current.length > 0 && nextLength > REGISTRY_SPECS_CHUNK_LIMIT) {
      chunks.push(current);
      current = [spec];
      currentLength = encodedSpec.length;
    } else {
      current.push(spec);
      currentLength = nextLength;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function buildDirectoryHeaders(directory: string | null): HeadersInit | undefined {
  return directory ? { 'x-opencode-directory': directory } : undefined;
}

function buildJsonHeaders(directory: string | null): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...(directory ? { 'x-opencode-directory': directory } : {}),
  };
}

function buildEntryBody(input: { spec?: string; options?: Record<string, unknown>; scope?: PluginScope }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.spec !== undefined) body.spec = input.spec;
  if (input.options !== undefined) body.options = input.options;
  if (input.scope !== undefined) body.scope = input.scope;
  return body;
}

async function runPluginMutation(
  progressMessage: string,
  request: (configDirectory: string | null) => Promise<Response>,
  get: () => PluginsStore,
): Promise<PluginMutationResult> {
  const owns = capturePluginsOwner();
  try {
    const configDirectory = getPluginsConfigDirectory();
    const response = await request(configDirectory);
    if (!owns()) return { ok: false };
    const payload = await readJson<PluginMutationPayload | null>(response).catch(() => null);
    if (!owns()) return { ok: false };

    if (!response.ok) {
      if (payload?.code === 'UNLOADABLE_SPEC') return { ok: false, invalidSpec: true };
      throw new Error(payload?.error || 'Failed to update plugin configuration');
    }

    invalidatePluginCache(configDirectory);

    if (payload?.requiresManualRestart) {
      await get().loadPlugins({ force: true });
      if (!owns()) return { ok: false };
      return {
        ok: true,
        requiresManualRestart: true,
        reloadFailed: payload?.reloadFailed === true,
        message: payload?.message,
        warning: payload?.warning,
      };
    }

    if (payload?.requiresReload) {
      startConfigUpdate(progressMessage);
      await refreshAfterOpenCodeRestart({
        message: payload.message,
        delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
        scopes: ['all'],
        isCurrentRuntime: owns,
      });
      if (!owns()) return { ok: false };
    }

    await get().loadPlugins({ force: true });
    if (!owns()) return { ok: false };
    return {
      ok: true,
      reloadFailed: payload?.reloadFailed === true,
      message: payload?.message,
      warning: payload?.warning,
    };
  } catch (error) {
    if (!owns()) return { ok: false };
    console.error('[PluginsStore] Failed to update plugin configuration:', error);
    return { ok: false };
  }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
