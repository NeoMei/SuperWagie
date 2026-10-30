import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
