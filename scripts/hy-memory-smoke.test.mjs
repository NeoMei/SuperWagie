import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { smokeRuntimeFailure } from '../packages/web/scripts/hy-memory-smoke-support.mjs';

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
    sessions: [{ revision: 0, reconciling: false, deleted: false }],
    entries: [{ kind: 'experience', status: 'candidate', indexState: 'pending', error: 'smoke_unclassified_error' }],
    projections: [], records: { trace: 1, code_history: 0, review: 0, 'node-source': 0, relation: 0, 'model-space': 0, 'hy-withdrawal': 0 },
  });
  assert.doesNotMatch(JSON.stringify(failure.diagnostics), /private|secret|messages|directory|body|title|prompt/);
});
