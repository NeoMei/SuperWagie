import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProbeStack, probeEnvironments, probeFatalCode, threadEnvironment } from './hy-memory-native-probe.mjs';

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

test('worker stack diagnostics discard paths, arbitrary functions and stderr prose', () => {
  const stack = parseProbeStack([
    'Timeout (0:00:10)!', 'Thread 0x12345 (most recent call first):',
    '  File "C:\\private\\worker.py", line 49 in read',
    '  File "/private/vendor/hy_memory/pipelines/system2_agent.py", line 1300 in prepare_materials',
    '  File "<frozen importlib._bootstrap>", line 488 in _call_with_frames_removed',
    '  File "/private/package/threadpoolctl.py", line 123 in private_customer_function',
    '  File "/private/customer.py", line 12 in read', 'private source prose',
  ].join('\n'));
  assert.deepEqual(stack, [
    { module: 'worker.py', line: 49, function: 'read' },
    { module: 'system2_agent.py', line: 1300, function: 'prepare_materials' },
    { module: '_bootstrap.py', line: 488, function: '_call_with_frames_removed' },
    { module: 'threadpoolctl.py', line: 123, function: 'other' },
  ]);
  assert.equal(parseProbeStack('  File "/private/worker.py", line 1 in read\n'.repeat(100)).length, 64);
});

test('fatal diagnostics return only fixed codes', () => {
  assert.equal(probeFatalCode('Windows fatal exception: access violation\r\nprivate source text'), 'probe_windows_access_violation');
  assert.equal(probeFatalCode('Fatal Python error: private source details'), 'probe_python_fatal_error');
  assert.equal(probeFatalCode('private source access violation'), null);
  assert.equal(probeFatalCode('Windows fatal exception: private custom exception'), null);
});
