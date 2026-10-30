import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { smokeRuntimeFailure, smokePhase, createSmokeHostTelemetry } from '../packages/web/scripts/hy-memory-smoke-support.mjs';

const script = fileURLToPath(new URL('../packages/web/scripts/hy-memory-smoke.mjs', import.meta.url));
const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });

test('smoke usage reports required explicit executables as JSON without starting services', () => {
  const result = invoke('--help');
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.requiredArguments, ['--backend=/absolute/binary', '--backend-root=/absolute/source', '--python=/absolute/python']);
  assert.equal(result.stderr, '');
});

test('missing or relative executable paths fail before creating a backend', () => {
  for (const args of [[], ['--backend=relative', '--backend-root=/source', '--python=/python'], ['--unknown=/path']]) {
    const result = invoke(...args);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, stage: 'arguments', error: { code: 'smoke_arguments_invalid' } });
    assert.equal(result.stderr, '');
  }
});

test('unavailable executables return a safe failure without echoing supplied paths', () => {
  const missing = path.resolve('/missing-private-smoke-binary');
  const result = invoke(`--backend=${missing}`, '--backend-root=/missing-private-source', '--python=/missing-private-python');
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, stage: 'arguments', error: { code: 'smoke_input_unavailable' } });
  assert.equal(result.stderr, '');
});

test('S2 smoke shares the safe argument contract without starting services', () => {
  const s2 = fileURLToPath(new URL('../packages/web/scripts/hy-memory-s2-smoke.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [s2, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).requiredArguments, ['--backend=/absolute/binary', '--backend-root=/absolute/source', '--python=/absolute/python']);
  assert.equal(result.stderr, '');
});

test('missing capture output reports only bounded runtime states and stable codes', () => {
  const failure = smokeRuntimeFailure('smoke_hy_experience_missing', {
    generationCalls: 0, engine: { state: 'ready', error: null, prompt: 'private model prompt' },
    state: { enabled: true, pending: [], lastError: 'hy_worker_failed',
      jobs: [{ state: 'failed', error: 'hy_worker_failed', attempts: 1, sourceRevision: 0, generated: null,
        segment: { text: 'private source', directory: '/private/project' } }],
      sessions: { privateSessionId: { revision: 0, reconciling: false, deleted: false, directory: '/private/project' } },
      entries: [{ kind: 'experience', status: 'candidate', indexState: 'pending', error: 'secret response with spaces', title: 'private title', body: 'private body' }],
      engine: { projections: [], records: [{ collection: 'trace', value: { messages: 'private retained text' } }] },
    },
  });
  assert.equal(failure.code, 'smoke_hy_experience_missing');
  assert.deepEqual(failure.diagnostics, {
    enabled: true, generationCalls: 0, pending: 0, lastError: 'hy_worker_failed', engine: { state: 'ready', error: null },
    jobs: [{ state: 'failed', error: 'hy_worker_failed', attempts: 1, sourceRevision: 0, hasGeneratedReceipt: false }],
    syntheses: [],
    sessions: [{ revision: 0, reconciling: false, deleted: false }],
    entries: [{ kind: 'experience', status: 'candidate', indexState: 'pending', error: 'smoke_unclassified_error' }],
    projections: [], records: { trace: 1, code_history: 0, review: 0, 'node-source': 0, relation: 0, 'model-space': 0, 'hy-withdrawal': 0 },
  });
  assert.doesNotMatch(JSON.stringify(failure.diagnostics), /private|secret|messages|directory|body|title|prompt/);
});

test('a hung smoke phase reports its exact stage and cancels only fixture work', async () => {
  const progress = { stage: 'before' }; let cancelled = 0;
  const failure = await smokePhase(progress, 'second_source_idle', () => new Promise(() => {}), {
    timeoutMs: 5, diagnose: async () => Object.assign(new Error('timeout'), { code: 'smoke_phase_timeout', diagnostics: { fixed: true } }),
    cancel: () => { cancelled++; },
  }).catch((error) => error);
  assert.equal(failure.code, 'smoke_phase_timeout');
  assert.equal(progress.stage, 'second_source_idle');
  assert.deepEqual(failure.diagnostics, { fixed: true });
  assert.equal(cancelled, 1);
});

test('a successful smoke phase preserves its value and original errors', async () => {
  const progress = { stage: 'before' };
  assert.equal(await smokePhase(progress, 'first_source_idle', async () => 42, { timeoutMs: 100 }), 42);
  const original = Object.assign(new Error('fixture-only'), { code: 'smoke_fixture_failed' });
  await assert.rejects(smokePhase(progress, 'first_source_idle', async () => { throw original; }), (error) => error === original);
});

test('host timeout diagnostics retain only fixed operation names and bounded counters', () => {
  const diagnose = (extra) => smokeRuntimeFailure('smoke_phase_timeout', {
    generationCalls: 0, engine: { state: 'ready', error: null },
    state: { enabled: true, pending: [], lastError: null, jobs: [], sessions: {}, entries: [], engine: { projections: [], records: [] } },
    ...extra,
  });
  const failure = diagnose({ lastOperation: 'host.store:nodes/list',
    hostOperations: [{ operation: 'host.store:nodes/list', started: 2, completed: 1, active: 1,
      params: { ids: ['private-record-id'], text: 'private source prose' } }] });
  assert.equal(failure.diagnostics.lastOperation, 'host.store:nodes/list');
  assert.deepEqual(failure.diagnostics.hostOperations, [{ operation: 'host.store:nodes/list', started: 2, completed: 1, active: 1 }]);
  assert.doesNotMatch(JSON.stringify(failure.diagnostics), /private|params|ids|text|prose/);
  assert.throws(() => diagnose({ lastOperation: 'private source prose' }));
  assert.throws(() => diagnose({ hostOperations: [{ operation: 'private-record-id', started: 1, completed: 0, active: 1 }] }));
  assert.throws(() => diagnose({ hostOperations: [{ operation: 'host.embed', started: 1_000_001, completed: 0, active: 1 }] }));
});

test('host fixture telemetry distinguishes pending calls and settles failed handlers without retaining inputs', async () => {
  const telemetry = createSmokeHostTelemetry();
  const pending = Promise.withResolvers();
  const original = new Error('private provider failure');
  const handlers = telemetry.wrap({
    'host.generate': () => pending.promise,
    'host.embed': async () => { throw original; },
    'host.store': async () => ({ records: [] }),
  });
  assert.deepEqual(telemetry.snapshot(), { lastOperation: null, hostOperations: [] });
  const generating = handlers['host.generate']({ prompt: 'private model prompt', jobId: 'private-job-id' });
  assert.deepEqual(telemetry.snapshot(), { lastOperation: 'host.generate',
    hostOperations: [{ operation: 'host.generate', started: 1, completed: 0, active: 1 }] });
  await handlers['host.store']({ operation: 'nodes/list', namespace: 'private-namespace', ids: ['private-source-id'] });
  await assert.rejects(handlers['host.embed']({ texts: ['private text'] }), (error) => error === original);
  await handlers['host.store']({ operation: 'private unrecognized operation', text: 'private retained prose' });
  assert.deepEqual(telemetry.snapshot(), { lastOperation: 'host.store:unsupported', hostOperations: [
    { operation: 'host.generate', started: 1, completed: 0, active: 1 },
    { operation: 'host.embed', started: 1, completed: 1, active: 0 },
    { operation: 'host.store:nodes/list', started: 1, completed: 1, active: 0 },
    { operation: 'host.store:unsupported', started: 1, completed: 1, active: 0 },
  ] });
  pending.resolve({ content: 'private generated result' });
  assert.deepEqual(await generating, { content: 'private generated result' });
  assert.deepEqual(telemetry.snapshot().hostOperations[0], { operation: 'host.generate', started: 1, completed: 1, active: 0 });
  assert.doesNotMatch(JSON.stringify(telemetry.snapshot()), /private|prompt|jobId|namespace|texts|content|params/);
});
