/**
 * Knowledge library runtime.
 *
 * Owns the pieces the routes and the agent tool call: settings-driven
 * enablement, the backend supervisor, provisioning, library records, the
 * reconcile/ingest loop, and search. It is the only module that knows how the
 * the embedded knowledge client, the ledger, the watcher and the queue fit together.
 *
 * Everything that reaches the network or the clock is injected, so the whole
 * flow can be exercised against a fake backend in one process.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import fsPromises from 'node:fs/promises';
import fsp from 'node:fs/promises';
import fs from 'node:fs';

import { createEmbeddedKnowledgeClient } from '../embedded-knowledge/client.js';
import { createEmbeddedKnowledgeSupervisor } from '../embedded-knowledge/supervisor.js';
import { DEFAULTS_VERSION, ProvisionError, provisionKnowledgeBackend } from '../embedded-knowledge/provision.js';
import { readLocalDefaults } from '../embedded-knowledge/local-defaults.js';
import { createKnowledgeModelBindings, knowledgeBindingProtocols, knowledgeModelParameters, knowledgeParserConfiguration } from '../embedded-knowledge/model-bindings.js';
import { createKnowledgeLibraryStore } from './store.js';
import { shouldIndex, summarizeLibrary, walkLibrary } from './scan.js';
import { createIngestQueue } from './ingest.js';
import { createLibraryWatcher } from './watcher.js';
import { createSearch } from './search.js';
import { isEnterpriseMode } from '../enterprise-mode.js';

import { z } from 'zod';

const DEFAULT_BACKEND_PORT = 17_808;
const STABILITY_MS = 1_500;
const INGEST_PUMP_MS = 2_000;
const MANAGED_BY = 'conversation-memory';
const managedIdentitySchema = z.object({
  projectId: z.string().min(1).max(200).regex(/^[a-z\d][a-z\d._:-]*$/i),
  id: z.string().min(1).max(200).regex(/^[a-z\d][a-z\d._:-]*$/i),
});
const managedDocumentSchema = managedIdentitySchema.extend({
  title: z.string().trim().min(1).max(500),
  markdown: z.string().min(1).max(2_000_000),
});
const knowledgeBaseDerivationPoliciesSchema = z.array(z.object({
  id: z.string(),
  indexing_strategy: z.object({
    wiki_enabled: z.boolean().optional(),
    graph_enabled: z.boolean().optional(),
  }).optional().catch(undefined),
}));
const hashText = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const slugify = (value) =>
  value
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'library';

const shortId = () => crypto.randomBytes(3).toString('hex');

export function resolveEmbeddedKnowledgeBinaryPath({ settingsPath = null, env = process.env } = {}) {
  if (env.EMBEDDED_KNOWLEDGE_BIN) return env.EMBEDDED_KNOWLEDGE_BIN;
  if (settingsPath) return settingsPath;
  return null;
}

/**
 * A missing backend is a normal state, not an error: the feature reports
 * `not-installed` and every other part of the app keeps working.
 */
export function createKnowledgeLibraryRuntime({
  dataDir,
  readSettings,
  saveSettings = async () => {},
  resolveBinaryPath,
  resolveModelBinding = async () => null,
  defaultPort = DEFAULT_BACKEND_PORT,
  fetchImpl = fetch,
  spawnImpl,
  fsPromises: fsImpl = fsPromises,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  onChanged = () => {},
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!dataDir) throw new Error('knowledge library runtime requires a data dir');
  if (!z.function().safeParse(readSettings).success) throw new Error('knowledge library runtime requires readSettings');

  const store = createKnowledgeLibraryStore({ dataDir, fsPromises: fsImpl, log });
  const managedRoot = path.join(store.directory, 'managed');
  const backendDir = path.join(dataDir, 'embedded-knowledge');
  const secretsFile = path.join(backendDir, 'secrets.json');

  let settings = {};
  let enabled = false;
  let supported = false;
  let provisionError = null;
  let startError = null;
  let supervisor = null;
  let supervisorEnv = null;
  let client = null;
  let ingest = null;
  let search = null;
  let watcher = null;
  let pumpTimer = null;
  let pumpBusy = false;
  let started = false;
  let consumerQueue = Promise.resolve();

  const notify = (event) => {
    try {
      onChanged(event);
    } catch {
      /* a listener must not fail a request */
    }
  };

  const loadSettings = async () => {
    settings = (await readSettings()) ?? {};
    return settings;
  };

  const knowledgeBaseId = () => settings.embeddedKnowledgeBaseId ?? null;
  const provisioned = () => Boolean(settings.embeddedKnowledgeApiKey && settings.embeddedKnowledgeBaseId);
  const isManaged = (entry) => entry?.managedBy === MANAGED_BY;
  const scopedIngestStore = (includes) => ({
    readDocuments: async () => Object.fromEntries(Object.entries(await store.readDocuments()).filter(([, document]) => includes(document))),
    writeDocuments: async (updates) => {
      const documents = await store.readDocuments();
      for (const [id, document] of Object.entries(updates)) documents[id] = document;
      await store.writeDocuments(documents);
    },
  });

  const status = () => ({
    supported,
    enabled,
    provisioned: provisioned(),
    backend: {
      state: supervisor?.getState() ?? (supported ? 'stopped' : 'not-installed'),
      port: Number(settings.embeddedKnowledgePort) || defaultPort,
      error: startError ?? supervisor?.getError() ?? null,
      logPath: path.join(backendDir, 'app.log'),
    },
    error: provisionError,
    stats: {
      libraries: librariesRef.length,
      files: librariesRef.reduce((total, library) => total + (library.stats?.files ?? 0), 0),
      indexable: librariesRef.reduce((total, library) => total + (library.stats?.indexable ?? 0), 0),
      skipped: librariesRef.reduce((total, library) => total + (library.stats?.skipped ?? 0), 0),
    },
  });

  // ── backend ────────────────────────────────────────────────────────────────

  const ensureSecrets = async () => {
    await fsImpl.mkdir(backendDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fsImpl.readFile(secretsFile, 'utf8'));
      if (parsed?.systemAesKey && parsed?.jwtSecret) return parsed;
    } catch {
      /* create below */
    }
    const created = {
      systemAesKey: crypto.randomBytes(16).toString('hex'),
      jwtSecret: crypto.randomBytes(48).toString('base64url'),
    };
    await fsImpl.writeFile(secretsFile, JSON.stringify(created), { mode: 0o600 });
    return created;
  };

  const resolveBackendModelHosts = async () => {
    const modelHosts = new Set();
    for (const purpose of ['embedding', 'rerank', 'vision', 'ocr']) {
      const binding = await resolveModelBinding(purpose, { supportedProtocols: knowledgeBindingProtocols(purpose) });
      if (!binding) continue;
      const hostname = new URL(binding.baseUrl).hostname.replace(/^\[|\]$/g, '');
      // The backend parses this environment value as rules separated by commas.
      // A selected endpoint may authorize only its literal host.
      if (!/^[a-z\d._:-]+$/i.test(hostname)) {
        throw new ProvisionError('model_configuration_invalid_input', 'The selected knowledge endpoint has an invalid hostname');
      }
      modelHosts.add(hostname);
    }
    return modelHosts;
  };

  const buildBackendEnv = async ({ port }) => {
    const secrets = await ensureSecrets();
    const modelHosts = new Set([
      'dashscope.aliyuncs.com',
      'paddleocr.aistudio-app.com',
      'paddleocr-store.bj.bcebos.com',
      'paddleocr-store-2.bj.bcebos.com',
      'paddleocr-store-3.bj.bcebos.com',
      ...(readLocalDefaults()?.hosts ?? []),
      ...await resolveBackendModelHosts(),
    ]);
    return {
      GIN_MODE: 'release',
      LOG_LEVEL: 'warn',
      SERVER_HOST: '127.0.0.1',
      SERVER_PORT: String(port),
      DB_DRIVER: 'sqlite',
      DB_PATH: path.join(backendDir, 'embedded-knowledge.db'),
      RETRIEVE_DRIVER: 'sqlite',
      STORAGE_TYPE: 'local',
      LOCAL_STORAGE_BASE_DIR: path.join(backendDir, 'files'),
      LOG_PATH: path.join(backendDir, 'app.log'),
      SYSTEM_AES_KEY: secrets.systemAesKey,
      JWT_SECRET: secrets.jwtSecret,
      NEO4J_ENABLE: 'false',
      ENABLE_GRAPH_RAG: 'false',
      CONCURRENCY_POOL_SIZE: '3',
      // Model hosts must be reachable through the backend SSRF guard; on machines
      // with fake-IP DNS the public name resolves into a restricted range.
      SSRF_WHITELIST_EXTRA: [...modelHosts].join(','),
    };
  };

  const createBackendClient = ({ sessionToken } = {}) =>
    createEmbeddedKnowledgeClient({
      baseUrl: `http://127.0.0.1:${Number(settings.embeddedKnowledgePort) || defaultPort}`,
      apiKey: sessionToken ? null : settings.embeddedKnowledgeApiKey ?? null,
      tenantId: settings.embeddedKnowledgeTenantId ?? null,
      sessionToken: sessionToken ?? null,
      fetchImpl,
    });

  const modelBindings = createKnowledgeModelBindings({
    createClient: createBackendClient,
    getState: () => ({
      email: settings.embeddedKnowledgeLocalEmail,
      password: settings.embeddedKnowledgeLocalPassword,
      knowledgeBaseId: knowledgeBaseId(),
      backendReady: supervisor?.getState() === 'running',
    }),
    readDocuments: () => store.readDocuments(),
    resolveModelBinding,
  });

  const refreshBackendModelHosts = async () => {
    const requestedHosts = await resolveBackendModelHosts();
    if (!supervisor || !supervisorEnv) return;
    const environmentHosts = new Set(supervisorEnv.SSRF_WHITELIST_EXTRA.split(','));
    if (![...requestedHosts].some((hostname) => !environmentHosts.has(hostname))) return;
    const previousEnv = supervisorEnv;
    supervisorEnv = { ...previousEnv, SSRF_WHITELIST_EXTRA: [...new Set([...environmentHosts, ...requestedHosts])].join(',') };
    try {
      const state = await supervisor.restartOwned();
      if (state === null) {
        throw new ProvisionError('model_configuration_knowledge_restart_required', 'Restart the adopted knowledge backend from its original owner to apply the selected model host');
      }
      if (state !== 'running') {
        throw new ProvisionError('model_configuration_knowledge_not_ready', 'The knowledge backend did not restart with the selected model host');
      }
    } catch (error) {
      supervisorEnv = previousEnv;
      throw error;
    }
    modelBindings.reset();
  };

  const syncConfiguredModels = async () => {
    try {
      await refreshBackendModelHosts();
      await modelBindings.syncModelBindings();
      if (provisionError?.startsWith('model_configuration_')) provisionError = null;
    } catch (error) {
      if (error.code === 'backend_error' && supervisor && !supervisor.ownsProcess()) {
        error = new ProvisionError(error.code, 'The adopted knowledge backend rejected model configuration; check its original owner environment and backend logs', { cause: error });
      }
      provisionError = error.code || 'model_configuration_knowledge_not_ready';
      notify({ type: 'status' });
      throw error;
    }
  };

  const consumeBackend = (consume) => {
    const operation = consumerQueue.then(consume);
    consumerQueue = operation.catch(() => {});
    return operation;
  };

  const withConfiguredModels = (consume = async () => {}) =>
    consumeBackend(async () => {
      await syncConfiguredModels();
      return consume();
    });

  const startIngestLoop = () => {
    if (!ingest || pumpTimer || pumpBusy) return;
    pumpBusy = true;
    withConfiguredModels(() => ingest?.processOnce())
      .catch((error) => log.warn?.('[KnowledgeLibrary] ingest pass failed', error?.message ?? error))
      .finally(async () => {
        pumpBusy = false;
        const stats = ingest ? await ingest.getStats().catch(() => null) : null;
        if (stats && (stats.queued > 0 || stats.parsing > 0)) {
          pumpTimer = schedule(() => {
            pumpTimer = null;
            startIngestLoop();
          }, INGEST_PUMP_MS);
          pumpTimer?.unref?.();
        }
        notify({ type: 'progress' });
      });
  };

  const startWatching = async () => {
    const libraries = await store.readLibraries();
    for (const library of libraries) {
      if (library.enabled === false || isManaged(library)) continue;
      watcher.watch(library.root);
    }
  };

  const startRuntime = async () => {
    await loadSettings();
    enabled = settings.knowledgeLibraryEnabled !== false;
    const binaryPath = resolveBinaryPath?.({ settingsPath: settings.embeddedKnowledgeBinaryPath ?? null }) ?? null;
    supported = Boolean(binaryPath);

    if (!enabled || !supported) {
      await stop();
      notify({ type: 'status' });
      return status();
    }
    if (started) return status();

    const port = Number(settings.embeddedKnowledgePort) || defaultPort;
    supervisorEnv = await buildBackendEnv({ port });

    const supervisorOptions = {
      resolveBinaryPath: () => binaryPath,
      buildEnv: () => supervisorEnv,
      spawnArgs: () => [],
      port,
      dataDir: backendDir,
      // The Lite binary resolves `config/` and `migrations/` from its working
      // directory, so it must not inherit the server's cwd.
      cwd: path.dirname(binaryPath),
      fetchImpl,
      onStateChange: () => notify({ type: 'status' }),
      log,
    };
    if (spawnImpl) supervisorOptions.spawnImpl = spawnImpl;
    supervisor = createEmbeddedKnowledgeSupervisor(supervisorOptions);

    watcher = createLibraryWatcher({
      schedule,
      cancelSchedule,
      now,
      onDirty: (root) => {
        const library = librariesRef.find((entry) => entry.root === root);
        if (library) void reconcileLibrary(library).catch((error) => log.warn?.('[KnowledgeLibrary] reconcile failed', error?.message ?? error));
      },
    });

    started = true;
    await supervisor.start();
    if (supervisor.getState() !== 'running') {
      notify({ type: 'status' });
      return status();
    }

    // A local WeKnora Lite installation supplies working model credentials, so
    // a fresh backend can provision itself without asking the user for a key,
    // and an already-provisioned one picks up extended defaults once. Without
    // that installation the model-key prompt stays in charge.
    const configuredEmbedding = await resolveModelBinding('embedding', { supportedProtocols: knowledgeBindingProtocols('embedding') });
    const staleDefaults = (settings.embeddedKnowledgeDefaultsVersion ?? 0) < DEFAULTS_VERSION;
    if ((!provisioned() || staleDefaults) && (configuredEmbedding || readLocalDefaults()?.models?.embedding)) {
      await provisionBackend(null).catch((error) => {
        log.warn?.('[KnowledgeLibrary] automatic provisioning skipped', error?.message ?? error);
      });
    }

    if (!provisioned()) {
      notify({ type: 'status' });
      return status();
    }

    client = createBackendClient();
    await syncConfiguredModels();
    ingest = createIngestQueue({
      client,
      store: scopedIngestStore((document) => !isManaged(document)),
      getLibraries: async () => (await store.readLibraries()).map((library) => ({ ...library, knowledgeBaseId: knowledgeBaseId() })),
      onDocumentChange: (document) => notify({ type: 'document', documentId: document.id }),
      fsPromises: fsImpl,
      now,
    });
    search = createSearch({ client, store, getKnowledgeBaseId: knowledgeBaseId });
    await startWatching();
    notify({ type: 'status' });
    return status();
  };

  const start = async () => {
    startError = null;
    try {
      return await startRuntime();
    } catch (error) {
      startError = error?.code ?? 'backend_start_failed';
      notify({ type: 'status' });
      throw error;
    }
  };

  const stop = async () => {
    started = false;
    startError = null;
    modelBindings.reset();
    if (pumpTimer) cancelSchedule(pumpTimer);
    pumpTimer = null;
    watcher?.stop();
    watcher = null;
    ingest = null;
    search = null;
    client = null;
    if (supervisor) await supervisor.stop().catch(() => {});
    supervisor = null;
    supervisorEnv = null;
  };

  // ── libraries ──────────────────────────────────────────────────────────────

  let librariesRef = [];

  const readLibraries = async () => {
    librariesRef = await store.readLibraries();
    return librariesRef;
  };

  const validateRoot = async (root) => {
    const parsedRoot = z.string().safeParse(root);
    if (!parsedRoot.success || !path.isAbsolute(parsedRoot.data)) return { error: 'path_not_absolute' };
    let stat;
    try {
      stat = await fsImpl.stat(root);
    } catch {
      return { error: 'path_missing' };
    }
    if (!stat.isDirectory()) return { error: 'path_not_directory' };
    try {
      await fsImpl.access(root, fs.constants.R_OK);
    } catch {
      return { error: 'path_unreadable' };
    }
    return { root };
  };

  const managedPathsForRoot = async (root) => {
    const canonicalRoot = await fsImpl.realpath(root);
    let canonicalManaged = path.resolve(managedRoot);
    try {
      canonicalManaged = await fsImpl.realpath(managedRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { canonicalRoot, canonicalManaged };
  };

  const ordinaryFiles = async (root) => {
    const { canonicalRoot, canonicalManaged } = await managedPathsForRoot(root);
    if (isWithin(canonicalManaged, canonicalRoot)) return [];
    return (await walkLibrary(root, { fsPromises: fsImpl }))
      .filter((file) => !isWithin(canonicalManaged, path.join(canonicalRoot, file.relPath)));
  };

  /**
   * What adding this folder would do, without touching the ledger. The panel
   * asks before the first indexing run because that run costs a remote call
   * per file.
   */
  const previewLibrary = async (root) => {
    const validated = await validateRoot(root);
    if (validated.error) return { error: validated.error };
    let files;
    try {
      files = await ordinaryFiles(validated.root);
    } catch {
      return { error: 'path_unreadable' };
    }
    return summarizeLibrary(files);
  };

  const addLibrary = async (root) => {
    if (!provisioned()) throw new ProvisionError('not_provisioned', 'The knowledge backend is not ready');
    const validated = await validateRoot(root);
    if (validated.error) return { error: validated.error };
    const { canonicalRoot, canonicalManaged } = await managedPathsForRoot(validated.root);
    if (isWithin(canonicalManaged, canonicalRoot)) return { error: 'managed_path' };

    const libraries = await store.readLibraries();
    if (libraries.some((library) => library.root === validated.root)) return { error: 'already_added' };

    const base = path.basename(validated.root);
    const library = {
      id: crypto.randomUUID(),
      root: validated.root,
      name: base,
      slug: `${slugify(base)}-${shortId()}`,
      enabled: true,
      createdAt: now(),
      lastScanAt: null,
    };
    libraries.push(library);
    await store.writeLibraries(libraries);
    librariesRef = libraries;
    watcher?.watch(library.root);
    notify({ type: 'libraries' });
    await reconcileLibraryOnce(library);
    return { library };
  };

  const removeLibrary = async (id, { deleteRemote = false } = {}) => {
    const libraries = await store.readLibraries();
    const library = libraries.find((entry) => entry.id === id);
    if (!library || isManaged(library)) return { error: 'not_found' };

    const documents = await store.readDocuments();
    const owned = Object.values(documents).filter((document) => document.libraryId === id);
    if (deleteRemote && client) {
      for (const document of owned) {
        if (!document.knowledgeId) continue;
        await client.deleteKnowledge(document.knowledgeId).catch(() => {});
      }
    }
    for (const document of owned) delete documents[document.id];
    await store.writeDocuments(documents);

    watcher?.unwatch(library.root);
    const next = libraries.filter((entry) => entry.id !== id);
    await store.writeLibraries(next);
    librariesRef = next;
    notify({ type: 'libraries' });
    return { ok: true };
  };

  const setLibraryEnabled = async (id, nextEnabled) => {
    const libraries = await store.readLibraries();
    const library = libraries.find((entry) => entry.id === id);
    if (!library || isManaged(library)) return { error: 'not_found' };
    library.enabled = nextEnabled === true;
    await store.writeLibraries(libraries);
    librariesRef = libraries;
    if (library.enabled) {
      watcher?.watch(library.root);
      await reconcileLibraryOnce(library);
    } else {
      watcher?.unwatch(library.root);
    }
    notify({ type: 'libraries' });
    return { library };
  };

  const reconcileLibraryOnce = async (library) => {
    if (library.enabled === false || isManaged(library)) return { scanned: 0 };
    let files;
    try {
      files = await ordinaryFiles(library.root);
    } catch (error) {
      log.warn?.('[KnowledgeLibrary] could not read library', library.root, error?.message ?? error);
      return { error: 'path_unreadable' };
    }

    const documents = await store.readDocuments();
    const existing = new Map(
      Object.values(documents)
        .filter((document) => document.libraryId === library.id)
        .map((document) => [document.relPath, document]),
    );
    const seen = new Set();
    const ignored = new Set(Array.isArray(library.ignoredPaths) ? library.ignoredPaths : []);
    let indexableCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      seen.add(file.relPath);
      const rule = shouldIndex(file.relPath, { size: file.size });
      const previous = existing.get(file.relPath);

      // A file removed from the library stays on disk but must not come back
      // on the next scan.
      if (ignored.has(file.relPath)) {
        if (previous) delete documents[previous.id];
        continue;
      }

      if (!rule.ok) {
        // Unsupported and ignored files are not documents. Listing them made
        // the tree a dump of the folder instead of the index, so only the
        // count survives; a record left by an older build is dropped.
        skippedCount += 1;
        if (previous) delete documents[previous.id];
        continue;
      }
      indexableCount += 1;

      const settled = now() - file.mtimeMs > STABILITY_MS;
      if (!previous) {
        const id = crypto.randomUUID();
        documents[id] = {
          id,
          libraryId: library.id,
          relPath: file.relPath,
          absPath: file.absPath,
          size: file.size,
          mtimeMs: file.mtimeMs,
          state: settled ? 'queued' : 'pending',
          attempts: 0,
        };
        continue;
      }

      previous.absPath = file.absPath;
      // A file first seen while it was still being written stays `pending`
      // until a later pass confirms it has settled. Its stat was already
      // recorded then, so the size/mtime comparison below would never fire.
      if (previous.state === 'pending') {
        if (settled) previous.state = 'queued';
        continue;
      }
      if (previous.state === 'missing') {
        previous.size = file.size;
        previous.mtimeMs = file.mtimeMs;
        previous.state = settled ? 'queued' : 'pending';
      } else if (previous.size !== file.size || previous.mtimeMs !== file.mtimeMs) {
        previous.size = file.size;
        previous.mtimeMs = file.mtimeMs;
        previous.state = settled ? 'queued' : 'pending';
      }
    }

    for (const [relPath, document] of existing) {
      if (!seen.has(relPath)) document.state = 'missing';
    }

    await store.writeDocuments(documents);
    const pending = Object.values(documents).filter((document) => document.libraryId === library.id && document.state === 'pending');
    if (pending.length > 0) {
      const retry = schedule(() => {
        const current = librariesRef.find((entry) => entry.id === library.id);
        if (current) void reconcileLibrary(current).catch(() => {});
      }, STABILITY_MS);
      retry?.unref?.();
    }

    const stats = {
      files: files.length,
      indexable: indexableCount,
      skipped: skippedCount,
      scannedAt: now(),
    };
    const nextLibraries = (await store.readLibraries()).map((entry) =>
      entry.id === library.id ? { ...entry, lastScanAt: now(), stats } : entry,
    );
    await store.writeLibraries(nextLibraries);
    librariesRef = nextLibraries;

    startIngestLoop();
    notify({ type: 'documents' });
    return { scanned: files.length };
  };

  const reconcileLibrary = (library) => consumeBackend(() => reconcileLibraryOnce(library));

  const rescan = async (libraryId) => {
    const libraries = await store.readLibraries();
    const library = libraryId ? libraries.find((entry) => entry.id === libraryId) : null;
    if (libraryId && !library) return { error: 'not_found' };
    const targets = library ? [library] : libraries;
    for (const target of targets) await reconcileLibraryOnce(target);
    return { ok: true };
  };

  const visibleDocuments = async (projectId) => {
    const libraries = new Map((await store.readLibraries()).map((library) => [library.id, library]));
    return Object.values(await store.readDocuments()).filter((document) => {
      const library = libraries.get(document.libraryId);
      if (!isManaged(document) && !isManaged(library)) return true;
      return Boolean(projectId) && (library?.projectId ?? document.projectId) === projectId && document.state !== 'deleting';
    });
  };

  const listDocuments = async ({ libraryId, projectId, state, limit = 200, offset = 0 } = {}) => {
    const documents = (await visibleDocuments(projectId))
      .filter((document) => (libraryId ? document.libraryId === libraryId : true))
      .filter((document) => (state ? document.state === state : true))
      .sort((left, right) => left.relPath.localeCompare(right.relPath));
    return {
      total: documents.length,
      documents: documents.slice(offset, offset + limit).map((document) => ({
        id: document.id,
        libraryId: document.libraryId,
        relPath: document.relPath,
        absPath: document.absPath,
        size: document.size ?? 0,
        state: document.state,
        parseStatus: document.parseStatus ?? null,
        lastError: document.lastError ?? null,
      })),
    };
  };

  const retryDocument = async (id) => {
    const documents = await store.readDocuments();
    const document = documents[id];
    if (!document || isManaged(document)) return { error: 'not_found' };
    // A retry is a fresh index, not a reparse of the same record: a parse can
    // fail because the backend's parser configuration changed, and reparse
    // keeps the task's original engine choice. Dropping the record makes the
    // next pass register the file again with the current configuration.
    if (document.knowledgeId && client) {
      await client.deleteKnowledge(document.knowledgeId).catch(() => {});
    }
    document.knowledgeId = null;
    document.sha256 = null;
    document.parseStatus = undefined;
    document.state = 'queued';
    document.attempts = 0;
    document.lastError = undefined;
    await store.writeDocuments(documents);
    startIngestLoop();
    return { ok: true };
  };

  const removeDocument = async (id) => {
    const documents = await store.readDocuments();
    const document = documents[id];
    if (!document || isManaged(document)) return { error: 'not_found' };
    if (document.knowledgeId && client) {
      await client.deleteKnowledge(document.knowledgeId).catch(() => {});
    }
    delete documents[id];

    // The source file stays on disk; remember the path so a rescan does not
    // register it again.
    const libraries = await store.readLibraries();
    const library = libraries.find((entry) => entry.id === document.libraryId);
    if (library) {
      const ignored = new Set(Array.isArray(library.ignoredPaths) ? library.ignoredPaths : []);
      ignored.add(document.relPath);
      library.ignoredPaths = [...ignored];
      await store.writeLibraries(libraries);
      librariesRef = libraries;
    }
    await store.writeDocuments(documents);
    notify({ type: 'documents' });
    return { ok: true };
  };

  /**
   * Retry every failed document in one ledger write. Calling the single
   * retry for each one races the ingest pass and the other retries: each is a
   * read-modify-write of the whole map, so the last writer wins and most
   * retries disappear. One write cannot lose them.
   */
  const retryFailed = async () => {
    const documents = await store.readDocuments();
    let queued = 0;
    for (const document of Object.values(documents)) {
      if (document.state !== 'failed' || isManaged(document)) continue;
      if (document.knowledgeId && client) {
        await client.deleteKnowledge(document.knowledgeId).catch(() => {});
      }
      document.knowledgeId = null;
      document.sha256 = null;
      document.parseStatus = undefined;
      document.state = 'queued';
      document.attempts = 0;
      document.lastError = undefined;
      queued += 1;
    }
    if (queued > 0) {
      await store.writeDocuments(documents);
      startIngestLoop();
    }
    return { queued };
  };

  const cleanMissing = async () => {
    const documents = await store.readDocuments();
    let removed = 0;
    for (const [id, document] of Object.entries(documents)) {
      if (document.state !== 'missing' || isManaged(document)) continue;
      if (document.knowledgeId && client) await client.deleteKnowledge(document.knowledgeId).catch(() => {});
      delete documents[id];
      removed += 1;
    }
    await store.writeDocuments(documents);
    notify({ type: 'documents' });
    return { removed };
  };

  // ── documents ──────────────────────────────────────────────────────────────

  const readDocument = async (id, projectId) => {
    return (await visibleDocuments(projectId)).find((document) => document.id === id) ?? null;
  };

  const findDocument = async ({ id, path: absPath, projectId } = {}) => {
    const documents = await visibleDocuments(projectId);
    if (id) return documents.find((document) => document.id === id) ?? null;
    if (!absPath) return null;
    return documents.find((document) => document.absPath === absPath) ?? null;
  };

  const readContent = async (id, { maxChars = 100_000, projectId } = {}) => {
    const document = await readDocument(id, projectId);
    if (!document?.knowledgeId || (isManaged(document) && document.state !== 'ready')) return { error: 'not_indexed' };
    if (!client) return { error: 'backend_unavailable' };
    const chunks = await client.listChunks(document.knowledgeId);
    const ordered = (Array.isArray(chunks) ? chunks : []).slice().sort((left, right) => (left.seq_id ?? 0) - (right.seq_id ?? 0));
    const text = ordered.map((chunk) => chunk.content ?? '').join('\n\n');
    return {
      documentId: document.id,
      relPath: document.relPath,
      content: text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated]` : text,
      truncated: text.length > maxChars,
    };
  };

  const getFile = async (id, { projectId } = {}) => {
    const document = await readDocument(id, projectId);
    if (!document) return { error: 'not_found' };
    try {
      await fsImpl.access(document.absPath, fs.constants.R_OK);
      return {
        stream: fs.createReadStream(document.absPath),
        fileName: path.basename(document.absPath),
      };
    } catch {
      if (!document.knowledgeId || !client) return { error: 'not_found' };
      const response = await client.previewKnowledge(document.knowledgeId);
      return {
        stream: response.body,
        fileName: path.basename(document.relPath),
        contentType: response.headers.get('content-type') ?? undefined,
      };
    }
  };

  // ── wiki, gallery and provisioning ─────────────────────────────────────────

  // Image bytes and wiki file proxies only accept a tenant session, not the
  // scoped runtime API key, so the runtime logs in with the generated local
  // account and keeps that session for these reads.
  let adminClient = null;
  const getAdminClient = async () => {
    if (adminClient) return adminClient;
    const anonymous = createBackendClient();
    const session = await anonymous.login(
      String(settings.embeddedKnowledgeLocalEmail ?? ''),
      String(settings.embeddedKnowledgeLocalPassword ?? ''),
    );
    adminClient = createBackendClient({ sessionToken: session.token });
    return adminClient;
  };

  const listImages = async ({ page = 1, pageSize = 24 } = {}) => {
    if (!client) return { error: 'backend_unavailable' };
    const payload = await client.listImages({ knowledgeBaseId: knowledgeBaseId(), page, pageSize });
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const documents = Object.values(await store.readDocuments());
    const sourcesByKnowledgeId = new Map(documents
      .filter((document) => document.state === 'ready' && document.knowledgeId)
      .map((document) => [document.knowledgeId, {
        documentId: document.id,
        path: document.absPath,
        relPath: document.relPath,
      }]));
    return {
      images: rows.map((row) => ({
        id: String(row?.id ?? ''),
        source: sourcesByKnowledgeId.get(row?.knowledge_id) ?? null,
        sourceName: String(row?.source_name ?? ''),
        caption: String(row?.caption ?? ''),
        url: String(row?.url ?? ''),
      })),
      total: Number(payload?.total ?? rows.length),
    };
  };

  const readImage = async (url) => {
    if (!client) return { error: 'backend_unavailable' };
    if (!url.startsWith('resource://')) return { error: 'not_found' };
    const admin = await getAdminClient();
    const response = await admin.fetchFile({ knowledgeBaseId: knowledgeBaseId(), filePath: url });
    return {
      stream: Readable.fromWeb(response.body),
      contentType: response.headers.get('content-type') ?? undefined,
    };
  };

  const listWikiPages = async ({ page = 1, pageSize = 200 } = {}) => {
    if (!client) return { error: 'backend_unavailable' };
    try {
      const payload = await client.wikiPages({ knowledgeBaseId: knowledgeBaseId(), page, pageSize });
      const rows = Array.isArray(payload?.pages) ? payload.pages : [];
      return {
        enabled: true,
        total: Number(payload?.total ?? rows.length),
        pages: rows.map((row) => ({
          slug: String(row?.slug ?? ''),
          title: String(row?.title ?? row?.slug ?? ''),
          pageType: String(row?.page_type ?? ''),
          status: String(row?.status ?? ''),
          summary: String(row?.summary ?? ''),
          content: String(row?.content ?? ''),
          folderId: String(row?.folder_id ?? ''),
          categoryPath: Array.isArray(row?.category_path) ? row.category_path.map(String) : [],
          updatedAt: String(row?.updated_at ?? ''),
        })),
      };
    } catch (error) {
      // A disabled wiki answers 400; that is an empty state, not a failure.
      if (error?.status === 400) return { enabled: false, pages: [], total: 0 };
      throw error;
    }
  };

  const listWikiFolders = async () => {
    if (!client) return { error: 'backend_unavailable' };
    try {
      const payload = await client.wikiFolders({ knowledgeBaseId: knowledgeBaseId() });
      const rows = Array.isArray(payload?.folders) ? payload.folders : [];
      return {
        enabled: true,
        folders: rows.map((row) => ({
          id: String(row?.id ?? ''),
          name: String(row?.name ?? ''),
          path: String(row?.path ?? ''),
          parentId: String(row?.parent_id ?? ''),
          pageCount: Number(row?.page_count ?? 0),
        })),
      };
    } catch (error) {
      if (error?.status === 400) return { enabled: false, folders: [] };
      throw error;
    }
  };

  const readWikiPage = async (slug) => {
    if (!client) return { error: 'backend_unavailable' };
    if (!slug) return { error: 'not_found' };
    const payload = await client.wikiPage({ knowledgeBaseId: knowledgeBaseId(), slug });
    return {
      slug: String(payload?.slug ?? slug),
      title: String(payload?.title ?? slug),
      pageType: String(payload?.page_type ?? ''),
      categoryPath: Array.isArray(payload?.category_path) ? payload.category_path.map(String) : [],
      summary: String(payload?.summary ?? ''),
      content: String(payload?.content ?? ''),
      updatedAt: String(payload?.updated_at ?? ''),
    };
  };

  const readWikiGraph = async () => {
    if (!client) return { error: 'backend_unavailable' };
    try {
      const payload = await client.wikiGraph({ knowledgeBaseId: knowledgeBaseId() });
      return {
        enabled: true,
        nodes: Array.isArray(payload?.nodes) ? payload.nodes : [],
        edges: Array.isArray(payload?.edges) ? payload.edges : [],
      };
    } catch (error) {
      if (error?.status === 400) return { enabled: false, nodes: [], edges: [] };
      throw error;
    }
  };

  // ── search and provisioning ────────────────────────────────────────────────

  const managedLocation = ({ projectId, id }) => {
    const projectKey = hashText(projectId);
    const documentKey = hashText(id);
    const root = path.join(managedRoot, projectKey);
    return {
      root,
      libraryId: `conversation-memory:${projectKey}`,
      documentId: `conversation-memory:${projectKey}:${documentKey}`,
      relPath: `${documentKey}.md`,
      absPath: path.join(root, `${documentKey}.md`),
    };
  };

  const managedResult = (document) => {
    const result = {
      documentId: document.id,
      state: ['ready', 'parsing', 'failed'].includes(document.state) ? document.state : document.state === 'deleting' ? 'failed' : 'pending',
    };
    if (document.knowledgeId) result.knowledgeId = document.knowledgeId;
    if (document.lastError) result.error = document.lastError;
    return result;
  };

  const assertManagedAccess = () => {
    if (isEnterpriseMode()) throw new ProvisionError('enterprise_mode', 'Conversation memory indexing is unavailable in enterprise mode');
  };

  const assertManagedDerivationScope = async () => {
    const unavailable = () => new ProvisionError('managed_derivation_scope_unavailable', 'The current knowledge base must explicitly disable Wiki and graph derivation before indexing conversation memory');
    let parsed;
    try {
      parsed = knowledgeBaseDerivationPoliciesSchema.safeParse(await client.listKnowledgeBases());
    } catch {
      throw unavailable();
    }
    const strategy = parsed.success ? parsed.data.find((base) => base.id === knowledgeBaseId())?.indexing_strategy : null;
    if (strategy?.wiki_enabled !== false || strategy?.graph_enabled !== false) throw unavailable();
  };

  // Managed entries advance only through explicit calls from conversation memory.
  // Ordinary sweeps and the user-library pump cannot recreate or index them.
  const indexManagedDocument = async (documentId) => {
    const documents = await store.readDocuments();
    const document = documents[documentId];
    if (!document || document.state === 'deleting') return null;
    if (!client || !enabled || !provisioned()) {
      return { ...managedResult(document), error: { code: 'backend_unavailable' } };
    }
    try {
      assertManagedAccess();
      await syncConfiguredModels();
      if (['pending', 'queued', 'failed'].includes(document.state)) await assertManagedDerivationScope();
      const markdown = await fsImpl.readFile(managedLocation({ projectId: document.projectId, id: document.managedId }).absPath, 'utf8');
      if (hashText(markdown) !== document.contentHash) {
        throw new ProvisionError('managed_document_write_incomplete', 'Write the stored managed document again before indexing it');
      }
      if (document.state === 'failed' || document.state === 'pending') {
        const retryFailedParse = document.state === 'failed';
        document.state = 'queued';
        // A failed parse must run again even when its bytes have not changed.
        if (retryFailedParse) document.sha256 = null;
        document.lastError = undefined;
        await store.writeDocuments(documents);
      }
      if (document.state !== 'ready') {
        const queue = createIngestQueue({
          client,
          store: scopedIngestStore((entry) => entry.id === documentId),
          getLibraries: async () => (await store.readLibraries()).map((library) => ({ ...library, knowledgeBaseId: knowledgeBaseId() })),
          fsPromises: fsImpl,
          now,
          onDocumentChange: (entry) => notify({ type: 'document', documentId: entry.id }),
        });
        await queue.processOnce();
      }
    } catch (error) {
      const current = await store.readDocuments();
      current[documentId].state = 'failed';
      current[documentId].lastError = { code: error?.code ?? 'ingest_failed' };
      await store.writeDocuments(current);
    }
    return managedResult((await store.readDocuments())[documentId]);
  };

  const upsertManagedDocument = (input) => consumeBackend(async () => {
    const parsed = managedDocumentSchema.parse(input);
    assertManagedAccess();
    const location = managedLocation(parsed);
    await fsImpl.mkdir(location.root, { recursive: true, mode: 0o700 });
    await fsImpl.chmod(managedRoot, 0o700);
    await fsImpl.chmod(location.root, 0o700);
    const libraries = await store.readLibraries();
    let library = libraries.find((entry) => entry.id === location.libraryId);
    if (!library) {
      library = {
        id: location.libraryId, root: location.root, name: 'Conversation memory',
        slug: `conversation-memory-${hashText(parsed.projectId)}`, enabled: true,
        managedBy: MANAGED_BY, projectId: parsed.projectId, createdAt: now(), lastScanAt: null,
      };
      libraries.push(library);
      await store.writeLibraries(libraries);
      librariesRef = libraries;
    }
    const documents = await store.readDocuments();
    const previous = documents[location.documentId];
    if (previous?.state === 'deleting') throw new ProvisionError('cleanup_pending', 'Remove the previous managed document before indexing it again');
    const contentHash = hashText(parsed.markdown);
    let existingMarkdown = null;
    if (previous) {
      try {
        existingMarkdown = await fsImpl.readFile(location.absPath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (!previous || previous.contentHash !== contentHash || existingMarkdown !== parsed.markdown) {
      documents[location.documentId] = {
        ...previous,
        id: location.documentId, libraryId: location.libraryId,
        relPath: location.relPath, absPath: location.absPath,
        managedBy: MANAGED_BY, projectId: parsed.projectId, managedId: parsed.id,
        title: parsed.title, contentHash, size: Buffer.byteLength(parsed.markdown),
        state: 'pending', attempts: 0, lastError: undefined,
      };
      // Hide the old revision before replacing its local reference. A failed
      // ledger commit after rename must leave no ready citation to stale bytes.
      await store.writeDocuments(documents);
      const temporary = `${location.absPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fsImpl.writeFile(temporary, parsed.markdown, { mode: 0o600 });
        await fsImpl.rename(temporary, location.absPath);
      } finally {
        await fsImpl.rm(temporary, { force: true });
      }
      const stat = await fsImpl.stat(location.absPath);
      Object.assign(documents[location.documentId], { size: stat.size, mtimeMs: stat.mtimeMs, state: 'queued' });
      await store.writeDocuments(documents);
    } else if (previous.title !== parsed.title) {
      previous.title = parsed.title;
      await store.writeDocuments(documents);
    }
    return indexManagedDocument(location.documentId);
  });

  const ensureManagedDocumentIndexed = (input) => consumeBackend(async () => {
    const identity = managedIdentitySchema.parse(input);
    return indexManagedDocument(managedLocation(identity).documentId);
  });

  const readManagedDocument = async (input) => {
    const identity = managedIdentitySchema.parse(input);
    const location = managedLocation(identity);
    const document = (await store.readDocuments())[location.documentId];
    if (!document || document.state === 'deleting') return null;
    return { ...managedResult(document), title: document.title, markdown: await fsImpl.readFile(location.absPath, 'utf8') };
  };

  const removeManagedDocument = (input) => consumeBackend(async () => {
    const identity = managedIdentitySchema.parse(input);
    const location = managedLocation(identity);
    const documents = await store.readDocuments();
    const document = documents[location.documentId];
    if (!document) return { removed: false };
    document.state = 'deleting';
    document.lastError = { code: 'cleanup_pending' };
    await store.writeDocuments(documents);
    notify({ type: 'document', documentId: document.id });
    if (document.knowledgeId) {
      if (!client) throw new ProvisionError('backend_unavailable', 'The knowledge backend is unavailable for cleanup');
      try {
        await client.deleteKnowledge(document.knowledgeId);
      } catch (error) {
        if (error?.code !== 'not_found') throw error;
      }
    }
    await fsImpl.rm(location.absPath, { force: true });
    delete documents[document.id];
    await store.writeDocuments(documents);
    notify({ type: 'document', documentId: document.id });
    return { removed: true, documentId: document.id };
  });

  const searchManagedDocuments = async (input) => {
    const { projectId } = managedIdentitySchema.pick({ projectId: true }).parse(input);
    assertManagedAccess();
    return searchDocuments({ ...input, projectId, managedOnly: true, limit: input.limit ?? 5 });
  };

  const searchDocuments = async (input) => {
    if (!search) return { error: 'backend_unavailable' };
    return withConfiguredModels(() => search.search(isEnterpriseMode() ? { ...input, projectId: undefined } : input));
  };

  const provisionBackend = async (modelApiKey) => {
    const bindings = {};
    for (const purpose of ['embedding', 'rerank', 'vision']) {
      const binding = await resolveModelBinding(purpose, { supportedProtocols: knowledgeBindingProtocols(purpose) });
      if (binding) bindings[purpose] = { name: binding.model, parameters: knowledgeModelParameters(purpose, binding) };
    }
    const ocr = await resolveModelBinding('ocr', { supportedProtocols: knowledgeBindingProtocols('ocr') });
    return provisionKnowledgeBackend({
      createClient: createBackendClient,
      getState: () => ({
        tenantId: settings.embeddedKnowledgeTenantId ?? null,
        email: settings.embeddedKnowledgeLocalEmail ?? null,
        password: settings.embeddedKnowledgeLocalPassword ?? null,
        knowledgeBaseId: settings.embeddedKnowledgeBaseId ?? null,
        apiKey: settings.embeddedKnowledgeApiKey ?? null,
        defaultsVersion: settings.embeddedKnowledgeDefaultsVersion ?? null,
      }),
      saveState: async (patch) => {
        const mapped = {};
        if (patch.tenantId !== undefined) mapped.embeddedKnowledgeTenantId = patch.tenantId;
        if (patch.email !== undefined) mapped.embeddedKnowledgeLocalEmail = patch.email;
        if (patch.password !== undefined) mapped.embeddedKnowledgeLocalPassword = patch.password;
        if (patch.knowledgeBaseId !== undefined) mapped.embeddedKnowledgeBaseId = patch.knowledgeBaseId;
        if (patch.apiKey !== undefined) mapped.embeddedKnowledgeApiKey = patch.apiKey;
        if (patch.defaultsVersion !== undefined) mapped.embeddedKnowledgeDefaultsVersion = patch.defaultsVersion;
        await saveSettings(mapped);
        Object.assign(settings, mapped);
      },
      modelApiKey,
      deepSeekApiKey: settings.embeddedKnowledgeDeepSeekApiKey ?? null,
      modelBindings: bindings,
      parserConfiguration: ocr ? knowledgeParserConfiguration(ocr) : undefined,
    });
  };

  const provision = (modelApiKey) => consumeBackend(async () => {
    provisionError = null;
    try {
      await refreshBackendModelHosts();
      const result = await provisionBackend(modelApiKey);
      await stop();
      await start();
      return { ok: true, knowledgeBaseId: result.knowledgeBaseId };
    } catch (error) {
      provisionError = error?.code ?? 'provision_failed';
      return { error: provisionError };
    }
  });

  const reconnect = async () => {
    await stop();
    try {
      return await start();
    } catch (error) {
      startError = error?.code ?? 'backend_start_failed';
      notify({ type: 'status' });
      return status();
    }
  };

  const rebuild = async () => {
    const documents = await store.readDocuments();
    for (const document of Object.values(documents)) {
      if (isManaged(document)) continue;
      if (document.state === 'ready' || document.state === 'failed') document.state = 'queued';
    }
    await store.writeDocuments(documents);
    await rescan();
    return { ok: true };
  };

  const ingestStats = async () => (ingest ? ingest.getStats() : { queued: 0, parsing: 0, ready: 0, failed: 0, skipped: 0, missing: 0 });

  return {
    start,
    stop,
    status,
    getStatus: async ({ includeModelConfiguration = false } = {}) => ({
      ...status(), indexing: await ingestStats(),
      ...(includeModelConfiguration ? { modelConfiguration: supervisor?.getState() === 'running' && provisioned()
        ? await modelBindings.readModelConfiguration()
        : { status: 'unavailable', reason: 'backend_unavailable' } } : {}),
    }),
    previewLibrary,
    addLibrary: (root) => consumeBackend(() => addLibrary(root)),
    removeLibrary: (id, options) => consumeBackend(() => removeLibrary(id, options)),
    setLibraryEnabled: (id, nextEnabled) => consumeBackend(() => setLibraryEnabled(id, nextEnabled)),
    rescan: (id) => consumeBackend(() => rescan(id)),
    listDocuments,
    retryDocument: (id) => consumeBackend(() => retryDocument(id)),
    removeDocument: (id) => consumeBackend(() => removeDocument(id)),
    retryFailed: () => consumeBackend(retryFailed),
    listImages,
    readImage,
    listWikiPages,
    listWikiFolders,
    readWikiPage,
    readWikiGraph,
    cleanMissing: () => consumeBackend(cleanMissing),
    readContent,
    findDocument,
    getFile,
    upsertManagedDocument,
    ensureManagedDocumentIndexed,
    readManagedDocument,
    removeManagedDocument,
    searchManagedDocuments,
    search: searchDocuments,
    provision,
    prepareModelBindingChange: async (purpose, next) => {
      await loadSettings();
      return modelBindings.prepareModelBindingChange(purpose, next);
    },
    syncModelBindings: () => withConfiguredModels(),
    reconnect,
    rebuild: () => consumeBackend(rebuild),
    readLibraries: async ({ projectId } = {}) => (await readLibraries()).filter((library) => !isManaged(library) || (projectId && library.projectId === projectId)),
    isReady: () => supervisor?.getState() === 'running' && provisioned(),
  };
}
