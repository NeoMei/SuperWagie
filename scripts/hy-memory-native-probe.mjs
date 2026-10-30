import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const environmentKeys = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'SYSTEMDRIVE'];
const threadKeys = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'];
const pythonFlags = { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };

export function probeEnvironments(environment) {
  const sanitized = Object.fromEntries(environmentKeys.filter((key) => environment[key]).map((key) => [key, environment[key]]));
  return [
    { name: 'sanitized', environment: { ...sanitized, ...pythonFlags } },
    { name: 'sanitized_single_thread', environment: { ...sanitized, ...pythonFlags, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' } },
    { name: 'inherited', environment: { ...environment, ...pythonFlags } },
  ];
}

export function threadEnvironment(environment) {
  return Object.fromEntries(threadKeys.map((key) => {
    const raw = environment[key];
    const value = /^\d{1,4}$/.test(raw ?? '') && Number(raw) <= 4096 ? Number(raw) : null;
    return [key, { present: Object.hasOwn(environment, key), value }];
  }));
}

// Import engine first, as worker.py does, before loading sklearn's native kernels.
const program = String.raw`
import sys, time
sys.stdout.reconfigure(encoding='utf-8', errors='strict', newline='\n', write_through=True)
sys.stderr.reconfigure(encoding='utf-8', errors='strict')
sys.path.insert(0, sys.argv[1])
started = time.perf_counter()
stage = 'engine_import'
def mark(name, rows=0, columns=0):
    print('HY_NATIVE_PROBE|%s|%d|%d|%d' % (name, round((time.perf_counter()-started)*1000), rows, columns), flush=True)
try:
    mark(stage)
    import engine
    stage = 'numpy_import'
    mark(stage)
    import numpy as np
    stage = 'sklearn_import'
    mark(stage)
    from sklearn.cluster import DBSCAN
    from sklearn.metrics.pairwise import cosine_distances
    stage = 'array'
    mark(stage)
    X = np.array([[1.0,0.0],[1.0,0.0],[0.7,0.7],[0.7,0.7]], dtype=np.float64)
    stage = 'cosine_distances'
    mark(stage, *X.shape)
    distances = cosine_distances(X)
    stage = 'dbscan'
    mark(stage, *distances.shape)
    labels = DBSCAN(eps=1.0-0.55, min_samples=2, metric='precomputed').fit_predict(distances)
    mark('complete', len(labels), len(set(int(value) for value in labels)))
except Exception as error:
    print('HY_NATIVE_ERROR|%s' % type(error).__name__, flush=True)
    sys.exit(1)
`;

export function runNativeProbe({ python, workerDirectory, environment = process.env, timeoutMs = 20_000 }) {
  const results = [];
  for (const variant of probeEnvironments(environment)) {
    const started = Date.now();
    const child = spawnSync(python, ['-u', '-B', '-c', program, workerDirectory], {
      env: variant.environment, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024,
    });
    const stages = [];
    let errorClass = null;
    for (const line of (child.stdout ?? '').split(/\r?\n/)) {
      const match = /^HY_NATIVE_PROBE\|(engine_import|numpy_import|sklearn_import|array|cosine_distances|dbscan|complete)\|(\d{1,9})\|(\d{1,3})\|(\d{1,3})$/.exec(line);
      if (match) stages.push({ stage: match[1], elapsedMs: Number(match[2]), rows: Number(match[3]), columns: Number(match[4]) });
      const failure = /^HY_NATIVE_ERROR\|([A-Za-z][A-Za-z0-9_]{0,79})$/.exec(line);
      if (failure) errorClass = failure[1];
    }
    const lastStage = stages.at(-1)?.stage ?? null;
    results.push({ variant: variant.name, status: child.error?.code === 'ETIMEDOUT' ? 'timeout' : child.status === 0 && lastStage === 'complete' ? 'passed' : 'failed',
      elapsedMs: Date.now() - started, exitCode: child.status, errorClass, lastStage, stderrPresent: Boolean(child.stderr),
      threadEnvironment: threadEnvironment(variant.environment), stages });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/hy-memory-native-probe.mjs --python=<portable-python> --worker-dir=<staged-python-directory>');
  } else {
    const python = process.argv.find((argument) => argument.startsWith('--python='))?.slice('--python='.length);
    const workerDirectory = process.argv.find((argument) => argument.startsWith('--worker-dir='))?.slice('--worker-dir='.length);
    if (!python || !workerDirectory || !existsSync(python) || !existsSync(path.join(workerDirectory, 'engine.py'))) {
      console.error(JSON.stringify({ code: 'hy_native_probe_paths_invalid' }));
      process.exitCode = 1;
    } else {
      const results = runNativeProbe({ python, workerDirectory });
      for (const result of results) console.log(JSON.stringify(result));
      if (results.some((result) => result.status !== 'passed')) process.exitCode = 1;
    }
  }
}
