import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const environmentKeys = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'SYSTEMDRIVE'];
const threadKeys = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'];
const pythonFlags = { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
const stackModules = ['worker.py', 'engine.py', 'adapters.py', 'system2_agent.py', 'threading.py', 'threadpoolctl.py',
  'pairwise.py', '_dbscan.py', 'base.py', 'contextlib.py', 'subprocess.py', 'selectors.py', 'windows_events.py',
  'base_events.py', 'events.py', 'runners.py', 'runpy.py', '__init__.py', '_bootstrap.py', '_bootstrap_external.py'];
const stackFunctions = new Set(['read', 'run', 'host', 'checked_host', 'operation', 'consolidate', 'prepare_materials', 'list_by_user',
  'fit', 'fit_predict', 'cosine_distances', 'cosine_similarity', '_parallel_pairwise', '_load_unlocked', '_find_and_load',
  '_find_and_load_unlocked', '_call_with_frames_removed', 'exec_module', 'create_module', '_bootstrap', '_bootstrap_inner',
  'run_path', '_run_module_code', '_run_code', '_run', '_run_once', 'run_forever', 'run_until_complete', 'select', '<module>']);

/** Native stack diagnostics contain fixed module/function labels, never paths or arbitrary stderr. */
export function parseProbeStack(stderr) {
  const frames = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^\s*File "([^"]+)", line ([1-9][0-9]{0,5}) in ([A-Za-z_][A-Za-z0-9_]*|<module>)$/.exec(line);
    if (!match) continue;
    const filename = match[1].replaceAll('\\', '/').split('/').at(-1);
    const module = stackModules.includes(filename) ? filename : match[1] === '<frozen importlib._bootstrap>' ? '_bootstrap.py'
      : match[1] === '<frozen importlib._bootstrap_external>' ? '_bootstrap_external.py' : null;
    if (module) frames.push({ module, line: Number(match[2]), function: stackFunctions.has(match[3]) ? match[3] : 'other' });
    if (frames.length === 64) break;
  }
  return frames;
}

export function probeFatalCode(stderr) {
  if (/^Windows fatal exception: access violation\r?$/m.test(stderr)) return 'probe_windows_access_violation';
  if (/^Fatal Python error: _enter_buffered_busy:/m.test(stderr)) return 'probe_python_stdio_shutdown';
  if (/^Fatal Python error: (?:PyThreadState_Get|_PyThreadState_Attach|PyGILState_Release):/m.test(stderr)) return 'probe_python_thread_state';
  if (/^Fatal Python error:/m.test(stderr)) return 'probe_python_fatal_error';
  return null;
}

export function probeReaderJoin(stderr) {
  const match = /^HY_PROBE_JOIN\|([01])\|([01])\r?$/m.exec(stderr);
  return match ? { count: Number(match[1]), completed: match[2] === '1' } : null;
}

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

export function runWorkerProbe({ python, workerDirectory, environment = process.env, timeoutMs = 30_000, shutdown = 'close', joinReader = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const wrapper = `import faulthandler, runpy, sys, threading
sys.path.insert(0, sys.argv[1])
faulthandler.enable()
faulthandler.dump_traceback_later(10)
try:
    runpy.run_path(sys.argv[1] + "/worker.py", run_name="__main__")
finally:
    faulthandler.cancel_dump_traceback_later()
    if sys.argv[2] == 'join':
        reader = next((thread for thread in threading.enumerate() if thread.daemon and getattr(getattr(thread, '_target', None), '__qualname__', None) == 'Worker.read'), None)
        if reader is not None:
            reader.join(2)
        sys.stderr.write('HY_PROBE_JOIN|%d|%d\\n' % (int(reader is not None), int(reader is None or not reader.is_alive())))
`;
    const child = spawn(python, ['-u', '-B', '-c', wrapper, path.resolve(workerDirectory), joinReader ? 'join' : 'nojoin'], {
      env: probeEnvironments(environment)[0].environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const counts = { generate: 0, embed: 0, store: 0 };
    let stage = 'capabilities'; let pending = ''; let status = 'failed'; let errorCode = null;
    let stderrPresent = false; let stderr = '';
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const timer = setTimeout(() => { status = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrPresent = true; stderr = (stderr + chunk).slice(-64 * 1024); });
    child.stdin.on('error', () => {});
    child.on('error', () => { errorCode = 'probe_spawn_failed'; });
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      if (pending.length > 8 * 1024 * 1024) { errorCode = 'probe_message_limit'; child.kill(); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let row;
        try { row = JSON.parse(line); } catch { errorCode = 'probe_protocol_invalid'; child.kill(); return; }
        if (row.error) { errorCode = /^[a-z][a-z0-9_:-]{0,79}$/.test(row.error.code) ? row.error.code : 'probe_worker_failed'; child.kill(); return; }
        if (row.id === 'probe-cap') {
          stage = 'consolidate';
          const entries = Array.from({ length: 4 }, (_, index) => {
            const lesson = index < 2 ? 'A' : 'B'; const sessionId = `probe-session-${lesson}`;
            const sourceHash = lesson.toLowerCase().repeat(64); const messageId = `probe-message-${index}`;
            return { id: `probe-entry-${index}`, projectId: 'probe-project', sessionId, status: 'active', kind: 'segment',
              body: `Independent export lesson ${lesson}, evidence ${index}.`, sourceHash, sourceMessageIds: [messageId], sourcePartIds: [],
              sourceRefs: [{ sessionId, messageId, sourceHash, sourceRevision: 0 }] };
          });
          send({ id: 'probe-s2', method: 'consolidate', params: { entries, context: { jobId: 'probe-job', namespace: 'probe-space',
            userId: 'probe-user', agentId: 'superwagie', projectId: 'probe-project', sessionId: '', spaceId: 'probe-space' } } });
        } else if (row.id === 'probe-s2') {
          stage = 'result_done'; status = 'passed';
          if (shutdown === 'close') send({ id: 'probe-close', method: 'close', params: {} });
          child.stdin.end();
        } else if (row.id === 'probe-close') {
          stage = 'closed';
        } else if (row.method === 'host.generate') {
          counts.generate++; stage = 'first_s2_generate'; send({ id: row.id, result: { content: '[]' } });
        } else if (row.method === 'host.embed') {
          counts.embed++; stage = 'host_embed';
          send({ id: row.id, result: { vectors: row.params.texts.map((text) => text.includes('lesson B') ? [0.7, 0.7] : [1, 0]), space_id: 'probe-space', dimensions: 2 } });
        } else if (row.method === 'host.store') {
          counts.store++; stage = 'host_store'; send({ id: row.id, result: { nodes: [], records: [], relations: [], total: 0 } });
        } else { errorCode = 'probe_message_unknown'; child.kill(); }
      }
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      errorCode ??= probeFatalCode(stderr);
      resolve({ variant: joinReader ? 'actual_worker_stdio_joined' : shutdown === 'close' ? 'actual_worker_stdio' : 'actual_worker_stdio_eof', status: exitCode === 0 ? status : status === 'timeout' ? status : 'failed',
        elapsedMs: Date.now() - started, exitCode, signal, errorCode, lastStage: stage, counts, stderrPresent, stack: parseProbeStack(stderr), readerJoin: probeReaderJoin(stderr) });
    });
    send({ id: 'probe-cap', method: 'capabilities', params: {} });
  });
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
      results.push(await runWorkerProbe({ python, workerDirectory }));
      results.push(await runWorkerProbe({ python, workerDirectory, shutdown: 'eof' }));
      results.push(await runWorkerProbe({ python, workerDirectory, joinReader: true }));
      for (const result of results) console.log(JSON.stringify(result));
      if (results.some((result) => result.status !== 'passed')) process.exitCode = 1;
    }
  }
}
