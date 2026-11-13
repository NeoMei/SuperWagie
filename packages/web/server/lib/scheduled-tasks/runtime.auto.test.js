import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createScheduledTasksRuntime } from './runtime.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createRoutingRuntime } from '../routing/runtime.js';
import { resolveEffectiveConfig } from '../routing/store.js';

const cleanups = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// The engine fixture rejects the Auto sentinel and records the session state
// observed by the prompt and goal store. Only external IO is replaced.
const setup = async ({ useDefaults = false, classifier = 'typesafe', enterprise = false, unavailable = false, rejectAt = null, gate = null, pinned = false, classifierError = false } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scheduled-auto-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const projects = ['a', 'b'].map((id) => ({ id, path: path.join(root, id) }));
  await Promise.all(projects.map((project) => fs.mkdir(project.path)));
  const configRuntime = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'config'), createTaskID: () => 'nightly' });
  for (const project of projects) await configRuntime.upsertScheduledTask(project.id, {
    id: 'nightly', name: 'Nightly', enabled: false,
    schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
    execution: {
      prompt: 'Review this project', agent: 'build', goalEnabled: true,
      providerID: pinned ? 'byok' : 'openchamber', modelID: pinned ? 'pinned' : 'auto',
      variant: 'stale', useDefaults,
    },
  });
  const sessions = new Map();
  const requests = [];
  const deliveries = [];
  const goals = [];
  vi.stubGlobal('fetch', async (input, init = {}) => {
    const pathname = new URL(String(input)).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    const directory = decodeURIComponent(new Headers(init.headers).get('x-opencode-directory') ?? '');
    requests.push({ pathname, body, directory });
    const respond = (data, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
    if (pathname === '/api/session') {
      if (body.model?.providerID === 'openchamber') return respond({ error: 'Auto sentinel reached the engine' }, 400);
      const id = `ses_${sessions.size + 1}`;
      sessions.set(id, { directory, model: body.model ?? { providerID: 'byok', id: 'engine-default' }, agent: body.agent ?? 'build' });
      return respond({ id });
    }
    if (pathname === '/api/command') return respond([]);
    const id = pathname.split('/')[3];
    const session = sessions.get(id);
    if (pathname.endsWith('/model')) {
      if (rejectAt === 'permission') return respond({ error: 'permission denied' }, 403);
      session.model = body.model;
      return new Response(null, { status: 204 });
    }
    if (pathname.endsWith('/agent')) {
      session.agent = body.agent;
      return new Response(null, { status: 204 });
    }
    if (pathname.endsWith('/prompt')) {
      deliveries.push({ id, ...structuredClone(session), text: body.text });
      if (rejectAt === 'unknown') throw new Error('Connection lost after prompt dispatch; result unknown');
      if (rejectAt === 'quota') return respond({ error: 'quota denied' }, 402);
    }
    return respond({});
  });
  const config = resolveEffectiveConfig(null);
  config.enabled = true;
  config.preserveCache = false;
  config.fallback = { model: { providerID: 'byok', modelID: 'safe' }, variant: 'low' };
  config.categories = config.categories.map((category) => category.id === 'hard'
    ? { ...category, model: { providerID: 'byok', modelID: 'deep' }, variant: 'high', agent: 'plan' }
    : category);
  const decisions = [];
  const routing = createRoutingRuntime({
    dataDir: root,
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/', getOpenCodeAuthHeaders: () => ({}),
    store: {
      readConfig: async () => config, readToken: async () => 'fixture-only',
      readClassifierSource: async () => classifier, readCustomEndpoint: async () => null,
    },
    jev: { ask: async () => { if (gate) await gate; if (classifierError) throw new Error('classifier unavailable'); return { answers: { category: { choice: 'hard', confidence: 0.99 } }, ms: 1 }; } },
    enterpriseMode: () => enterprise, readPinnedEndpoint: () => null,
    readProviderKeys: async () => ({}), resolveModelBinding: async () => null,
    listCatalogModels: async (directory) => unavailable
      ? [{ providerID: 'account', modelID: 'safe', variants: [] }]
      : [
        { providerID: 'byok', modelID: 'safe', variants: [{ id: 'low' }] },
        ...(directory === projects[0].path ? [{ providerID: 'byok', modelID: 'deep', variants: [{ id: 'high' }] }] : []),
      ],
    readSessionHistory: async () => ({ history: [], lastAnswer: null }),
    broadcastGlobalUiEvent: (event) => decisions.push(event),
  });
  const runtime = createScheduledTasksRuntime({
    projectConfigRuntime: configRuntime, listProjects: async () => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/', getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    readSessionDefaults: async () => ({ providerID: 'openchamber', modelID: 'auto', agent: 'build', variant: 'stale' }),
    resolveAutoSelection: (input) => routing.resolveAutoSelection(input),
    persistSessionGoal: async (id, directory, goal) => goals.push({ id, directory, goal, selection: structuredClone(sessions.get(id)) }),
    logger: { info() {}, warn() {}, error() {} },
  });
  cleanups.push(() => runtime.stop());
  await runtime.start();
  return { runtime, projects, configRuntime, sessions, requests, deliveries, goals, decisions };
};

describe('scheduled Auto first dispatch', () => {
  it.each([false, true])('resolves pinned/default Auto in each run directory before its goal and prompt (defaults=%s)', async (useDefaults) => {
    const { runtime, projects, deliveries, goals, requests, configRuntime } = await setup({ useDefaults });
    const first = await runtime.runNow('a', 'nightly');
    expect(first.error).toBeUndefined();
    expect(first.ok).toBe(true);
    expect((await runtime.runNow('b', 'nightly')).ok).toBe(true);
    expect(deliveries).toEqual([
      { id: 'ses_1', directory: projects[0].path, model: { providerID: 'byok', id: 'deep', variant: 'high' }, agent: 'plan', text: 'Review this project' },
      { id: 'ses_2', directory: projects[1].path, model: { providerID: 'byok', id: 'safe', variant: 'low' }, agent: 'plan', text: 'Review this project' },
    ]);
    expect(goals.map(({ id, directory, selection, goal }) => ({ id, directory, selection, status: goal.status }))).toEqual(deliveries.map(({ id, directory, model, agent }) => ({ id, directory, selection: { directory, model, agent }, status: 'active' })));
    expect(requests.filter((request) => request.pathname === '/api/session').every((request) => !request.body.model)).toBe(true);
    expect((await configRuntime.listScheduledTasks('a'))[0].state).toMatchObject({ lastStatus: 'success', lastSessionId: 'ses_1' });
  });

  it.each([{ classifier: 'off' }, { enterprise: true }])('fails before sending when Auto is not ready (%j)', async (options) => {
    const { runtime, configRuntime, deliveries, goals } = await setup(options);
    const result = await runtime.runNow('a', 'nightly');
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not ready/i) });
    expect(deliveries).toEqual([]);
    expect(goals).toEqual([]);
    expect((await configRuntime.listScheduledTasks('a'))[0].state).toMatchObject({ lastStatus: 'error', lastSessionId: 'ses_1' });
  });

  it('uses only the configured fallback after a classifier error', async () => {
    const { runtime, deliveries } = await setup({ classifierError: true });
    expect((await runtime.runNow('a', 'nightly')).ok).toBe(true);
    expect(deliveries[0]).toMatchObject({ model: { providerID: 'byok', id: 'safe', variant: 'low' }, agent: 'build' });
  });

  it('refuses an unavailable BYOK fallback even when another payer exposes the same model ID', async () => {
    const { runtime, deliveries, goals, requests } = await setup({ unavailable: true });
    expect(await runtime.runNow('a', 'nightly')).toMatchObject({ ok: false, error: expect.stringContaining('fallback model is unavailable') });
    expect(deliveries).toEqual([]);
    expect(goals).toEqual([]);
    expect(requests.filter((request) => request.pathname.endsWith('/model'))).toEqual([]);
  });

  it.each(['permission', 'quota', 'unknown'])('keeps %s refusal/unknown as a failed dispatch without replay', async (rejectAt) => {
    const { runtime, deliveries, requests, configRuntime } = await setup({ rejectAt });
    expect(await runtime.runNow('a', 'nightly')).toMatchObject({ ok: false });
    expect(deliveries).toHaveLength(rejectAt === 'permission' ? 0 : 1);
    expect(requests.filter((request) => request.pathname === '/api/session')).toHaveLength(1);
    expect((await configRuntime.listScheduledTasks('a'))[0].state).toMatchObject({ lastStatus: 'error', lastSessionId: 'ses_1' });
    if (rejectAt === 'unknown') expect((await configRuntime.listScheduledTasks('a'))[0].state.lastError).toContain('result unknown');
  });

  it('keeps explicit model validation on the existing session creation path', async () => {
    const { runtime, deliveries, requests, decisions } = await setup({ pinned: true });
    expect((await runtime.runNow('a', 'nightly')).ok).toBe(true);
    expect(requests.find((request) => request.pathname === '/api/session').body.model).toEqual({ providerID: 'byok', id: 'pinned', variant: 'stale' });
    expect(deliveries[0].model).toEqual({ providerID: 'byok', id: 'pinned', variant: 'stale' });
    expect(decisions).toEqual([]);
  });

  it('allows only one prompt while duplicate run attempts overlap Auto resolution', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { runtime, sessions, deliveries } = await setup({ gate });
    const first = runtime.runNow('a', 'nightly');
    const second = runtime.runNow('a', 'nightly');
    release();
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(sessions.size).toBe(1);
    expect(deliveries).toHaveLength(1);
  });
});
