import assert from 'node:assert/strict';
import test from 'node:test';
import { probeEnvironments, threadEnvironment } from './hy-memory-native-probe.mjs';

test('native probe matches worker isolation and changes thread limits only in its diagnostic variant', () => {
  const inherited = { PATH: '/bin', SystemRoot: 'C:\\Windows', MODEL_KEY: 'private', OPENBLAS_NUM_THREADS: '32', PYTHONPATH: '/private' };
  const variants = probeEnvironments(inherited);
  assert.deepEqual(variants.map((variant) => variant.name), ['sanitized', 'sanitized_single_thread', 'inherited']);
  assert.deepEqual(variants[0].environment, { PATH: '/bin', SystemRoot: 'C:\\Windows', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' });
  assert.deepEqual(variants[1].environment, { ...variants[0].environment, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' });
  assert.equal(variants[2].environment.MODEL_KEY, 'private');
  assert.equal(variants[2].environment.OPENBLAS_NUM_THREADS, '32');
  assert.equal(inherited.PYTHONNOUSERSITE, undefined);
});

test('thread diagnostics disclose presence and bounded integers only', () => {
  assert.deepEqual(threadEnvironment({ OMP_NUM_THREADS: 'secret-value', OPENBLAS_NUM_THREADS: '32', MKL_NUM_THREADS: '10000', OTHER: 'private' }), {
    OMP_NUM_THREADS: { present: true, value: null }, OPENBLAS_NUM_THREADS: { present: true, value: 32 }, MKL_NUM_THREADS: { present: true, value: null },
  });
});
