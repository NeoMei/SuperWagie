import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runtimePlatform } from '../../solution-b-spike/src/runtime-platform.mjs';

const platform = runtimePlatform();

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function classicFromEsm(bytes, globalName, metaUrlExpression) {
  const text = bytes.toString('utf8');
  const marker = 'export{';
  const index = text.lastIndexOf(marker);
  if (index < 0) throw new Error('TASK7_ESM_TRANSFORM_FAILED');
  const end = text.lastIndexOf('};');
  if (end < index) throw new Error('TASK7_ESM_TRANSFORM_FAILED');
  const names = text.slice(index + marker.length, end).split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [local, exported = local] = pair.split(/\s+as\s+/);
      return JSON.stringify(exported.trim()) + ':' + local.trim();
    });
  const footer = globalName
    ? ';window[' + JSON.stringify(globalName) + '] = {' + names.join(',') + '};\n'
    : ';\n';
  const body = text.slice(0, index).split('import.meta.url').join(metaUrlExpression);
  return Buffer.from('(function(){' + body + footer + '})();\n');
}

const RENDERER_LIBRARIES = Object.freeze({
  pdf: [
    ['pdfjs/pdf.min.mjs', 'pdf.classic.js', 'pdfjsLib', 'document.baseURI'],
    ['pdfjs/pdf.worker.min.mjs', 'pdf.worker.classic.js', 'pdfjsWorker', 'document.baseURI'],
  ],
  docx: [
    ['docx-preview/docx-preview.min.js', 'docx-preview.min.js'],
    ['jszip/jszip.min.js', 'jszip.min.js'],
  ],
});

const LIBRARY_ROOTS = Object.freeze({
  pdfjs: 'scripts/poc/gate-3/node_modules/pdfjs-dist/build',
  'docx-preview': 'scripts/poc/gate-3/node_modules/docx-preview/dist',
  jszip: 'scripts/poc/gate-3/node_modules/jszip/dist',
});

function libraryFile(entry) {
  const [library, name] = entry.split('/');
  return join(LIBRARY_ROOTS[library], name);
}

function writePrivate(path, bytes) {
  writeFileSync(path, bytes, { mode: 0o600 });
}

export function reviewRendererLibraries(kind) {
  return RENDERER_LIBRARIES[kind] ?? (kind === 'wps-pdf' ? RENDERER_LIBRARIES.pdf : null);
}

export function prepareReviewRenderJob({
  repositoryRoot, candidateRoot, workRoot, jobId, kind, sourcePath, sourceSha256,
  declaredPageCount, pageIndices, scale = 1, zoomVariants = [1],
  crashAfterPages = 0, crashMode = 'none',
}) {
  if (!reviewRendererLibraries(kind)) throw new Error('TASK7_RENDER_KIND_UNSUPPORTED:' + kind);
  if (!/^[a-z0-9-]{1,64}$/.test(jobId ?? '')) throw new Error('TASK7_JOB_ID_INVALID');
  if (!Number.isSafeInteger(declaredPageCount) || declaredPageCount <= 0 || declaredPageCount > 500) {
    throw new Error('TASK7_PAGE_COUNT_INVALID');
  }
  if (!Array.isArray(pageIndices) || pageIndices.length === 0
    || pageIndices.some((index) => !Number.isSafeInteger(index) || index < 1 || index > declaredPageCount)
    || new Set(pageIndices).size !== pageIndices.length) throw new Error('TASK7_PAGE_INDICES_INVALID');
  if (!zoomVariants.every((zoom) => typeof zoom === 'number' && zoom > 0.25 && zoom < 4)) {
    throw new Error('TASK7_ZOOM_INVALID');
  }
  const jobRoot = join(workRoot, jobId);
  for (const directory of [join(jobRoot, 'inputs'), join(jobRoot, 'outputs', 'pages', 'zoom'), join(jobRoot, 'state')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const sourceBytes = readFileSync(sourcePath);
  if (sha256(sourceBytes) !== sourceSha256) throw new Error('TASK7_SOURCE_HASH_MISMATCH');
  const sourceName = 'source' + sourcePath.slice(sourcePath.lastIndexOf('.'));
  copyFileSync(sourcePath, join(jobRoot, 'inputs', sourceName));
  const libraryHashes = [];
  for (const entry of reviewRendererLibraries(kind)) {
    const file = libraryFile(entry[0]);
    const rawBytes = readFileSync(join(repositoryRoot, file));
    const bytes = entry.length === 4 ? classicFromEsm(rawBytes, entry[2], entry[3]) : rawBytes;
    if (!statSync(join(repositoryRoot, file)).isFile() || bytes.length === 0) throw new Error('TASK7_LIBRARY_MISSING:' + entry[0]);
    writePrivate(join(jobRoot, 'inputs', entry[1]), bytes);
    libraryHashes.push({ path: 'inputs/' + entry[1], sha256: sha256(bytes) });
  }
  const runtimeManifest = JSON.parse(readFileSync(join(candidateRoot, 'runtime-manifest.json'), 'utf8'));
  if (runtimeManifest.platform !== platform.id || runtimeManifest.manifest_version !== 'solution-b-v1') throw new Error('TASK7_CANDIDATE_PLATFORM_MISMATCH');
  const electron = join(candidateRoot, ...runtimeManifest.launch.executable.split('/'));
  const workerScript = join(candidateRoot, 'src', 'review-render-worker.mjs');
  const jobKey = randomBytes(32).toString('hex');
  const manifest = {
    schema_version: 'solution-b-review-execution-v1',
    job_id: jobId,
    request_id: randomBytes(16).toString('hex'),
    run_nonce: randomBytes(16).toString('hex'),
    audience: 'review_render_worker',
    revision: 1,
    attempt: 1,
    document: {
      kind,
      source_path: 'inputs/' + sourceName,
      source_sha256: sourceSha256,
      declared_page_count: declaredPageCount,
    },
    renderer: {
      scale,
      zoom_variants: [...new Set(zoomVariants)],
      library_hashes: libraryHashes,
      worker_script_sha256: sha256(readFileSync(workerScript)),
    },
    pages: { indices: [...pageIndices] },
    text_layer: { required: true, max_items_per_page: 20000 },
    resource_limits: {
      max_pages: pageIndices.length,
      max_page_bytes: 4_000_000,
      max_output_bytes: Math.max(pageIndices.length * 1_200_000, 4_000_000),
      max_process_tree_rss_bytes: 1_200_000_000,
    },
    checkpoint: { path: 'state/checkpoint.json', job_id: jobId, revision: 1, initial_sha256: null },
    output_authorization: {
      directory: 'outputs/pages',
      result_path: 'outputs/result.json',
      job_id: jobId,
      revision: 1,
      page_pattern: 'page-%04d.png',
      text_pattern: 'page-%04d.text.json',
    },
    crash_injection_after_pages: crashAfterPages,
    crash_injection_mode: crashAfterPages ? crashMode : 'none',
  };
  const wrapper = { manifest, mac: createHmac('sha256', jobKey).update(canonicalJson(manifest)).digest('hex') };
  writePrivate(join(jobRoot, 'execution-manifest.json'), Buffer.from(JSON.stringify(wrapper, null, 2) + '\n'));
  return { jobId, kind, jobRoot, jobKey, manifest, electron, workerScript };
}

function receiptMac(jobKey, receipt) {
  return createHmac('sha256', jobKey).update(canonicalJson(receipt)).digest('hex');
}

function validateProgressLine(line, jobKey, manifest) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  const receipt = line.receipt;
  if (line.type !== 'checkpoint_progress' || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  if (Object.keys(line).sort().join('\0') !== ['mac', 'receipt', 'type'].sort().join('\0')
    || Object.keys(receipt).sort().join('\0') !== ['attempt', 'checkpoint_sha256', 'completed', 'job_id', 'request_id', 'revision', 'run_nonce', 'schema_version'].sort().join('\0')
    || !/^[a-f0-9]{64}$/.test(line.mac ?? '') || !/^[a-f0-9]{64}$/.test(receipt.checkpoint_sha256 ?? '')) return null;
  if (receiptMac(jobKey, receipt) !== line.mac || receipt.schema_version !== 'solution-b-progress-v1'
    || receipt.job_id !== manifest.job_id || receipt.request_id !== manifest.request_id
    || receipt.run_nonce !== manifest.run_nonce || receipt.revision !== manifest.revision
    || receipt.attempt !== manifest.attempt || !receipt.completed || typeof receipt.completed !== 'object'
    || Array.isArray(receipt.completed)) return null;
  for (const [page, hash] of Object.entries(receipt.completed)) {
    if (!/^[1-9][0-9]{0,5}$/.test(page) || !/^[a-f0-9]{64}$/.test(hash)
      || !manifest.pages.indices.includes(Number(page))) return null;
  }
  return receipt;
}

export function validateProgressStdout(stdout, jobKey, manifest) {
  const receipts = [];
  let previousCompleted = {};
  for (const textLine of String(stdout).split('\n').filter(Boolean)) {
    let parsed;
    try { parsed = JSON.parse(textLine); } catch { continue; }
    const receipt = validateProgressLine(parsed, jobKey, manifest);
    if (!receipt) continue;
    if (Object.entries(previousCompleted).some(([page, hash]) => receipt.completed[page] !== hash)) continue;
    previousCompleted = { ...receipt.completed };
    receipts.push(receipt);
  }
  return receipts;
}

function writeManifestWrapper(jobRoot, manifest, jobKey) {
  const wrapper = { manifest, mac: createHmac('sha256', jobKey).update(canonicalJson(manifest)).digest('hex') };
  writePrivate(join(jobRoot, 'execution-manifest.json'), Buffer.from(JSON.stringify(wrapper, null, 2) + '\n'));
  return wrapper;
}

export function spawnReviewRenderWorker({
  jobRoot, jobKey, electron, workerScript, timeoutMs = 120_000, cancellationSignal = null,
}) {
  return new Promise((resolveSpawn) => {
    if (cancellationSignal?.aborted) {
      resolveSpawn({ kind: 'cancelled', code: null, signal: null, stdout: '', stderr: '', error: 'CANCELLED_BEFORE_SPAWN' });
      return;
    }
    let child;
    try {
      child = spawn(electron, [workerScript, '--job-file', 'execution-manifest.json'], {
        cwd: jobRoot,
        env: { LANG: 'C', LC_ALL: 'C', SUPERWAGIE_JOB_KEY: jobKey },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolveSpawn({ kind: 'spawn_error', code: null, signal: null, stdout: '', stderr: '', error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let terminalKind = null;
    let settled = false;
    let timeout;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cancellationSignal?.removeEventListener('abort', cancel);
      resolveSpawn({ ...outcome, stdout, stderr });
    };
    const terminateTree = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') spawnSync(join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      else child.kill('SIGKILL');
    };
    const cancel = () => {
      terminalKind = 'cancelled';
      terminateTree();
    };
    child.once('error', (error) => finish({ kind: 'spawn_error', code: null, signal: null, error: error.message }));
    child.once('exit', (code, signal) => finish({ kind: terminalKind ?? 'exit', code, signal, error: null }));
    cancellationSignal?.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => {
      terminalKind = 'timeout';
      terminateTree();
    }, timeoutMs);
  });
}

export async function runPreparedReviewJob({
  jobRoot, jobKey, manifest, electron, workerScript, spawnWorker, maxRestarts = 1, timeoutMs = 120_000,
}) {
  if (typeof spawnWorker !== 'function') {
    spawnWorker = () => spawnReviewRenderWorker({ jobRoot, jobKey, electron, workerScript, timeoutMs });
  }
  const executions = [];
  let trustedReceipt = null;
  let currentManifest = manifest;
  let restarts = 0;
  let execution;
  while (true) {
    execution = await spawnWorker({ manifest: currentManifest, attempt: currentManifest.attempt });
    executions.push(execution);
    const receipts = validateProgressStdout(execution.stdout ?? '', jobKey, currentManifest);
    if (receipts.length > 0) trustedReceipt = receipts.at(-1);
    if (execution.kind === 'cancelled') {
      return { cleanExit: false, cancelled: true, receipts, trustedCheckpointSha256: trustedReceipt?.checkpoint_sha256 ?? null,
        executions, restarts, attempts: executions.length };
    }
    if (execution.kind === 'exit' && execution.code === 0 && execution.signal === null && trustedReceipt) {
      return { cleanExit: true, cancelled: false, receipts, trustedCheckpointSha256: trustedReceipt.checkpoint_sha256,
        executions, restarts, attempts: executions.length, recoveredFromCrash: executions.length > 1 };
    }
    if (!trustedReceipt) {
      return { cleanExit: false, cancelled: false, receipts, error: 'AUTHENTICATED_PROGRESS_RECEIPT_REQUIRED',
        trustedCheckpointSha256: null, executions, restarts, attempts: executions.length };
    }
    if (restarts >= maxRestarts) {
      return { cleanExit: false, cancelled: false, receipts, error: 'TASK7_RESTART_BUDGET_EXHAUSTED',
        trustedCheckpointSha256: trustedReceipt.checkpoint_sha256, executions, restarts, attempts: executions.length };
    }
    restarts += 1;
    currentManifest = {
      ...currentManifest,
      attempt: currentManifest.attempt + 1,
      checkpoint: { ...currentManifest.checkpoint, initial_sha256: trustedReceipt.checkpoint_sha256 },
      crash_injection_after_pages: 0,
      crash_injection_mode: 'none',
    };
    writeManifestWrapper(jobRoot, currentManifest, jobKey);
  }
}
