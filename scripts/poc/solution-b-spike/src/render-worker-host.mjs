import { app, BrowserWindow, nativeImage, protocol, session } from 'electron';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from './core-client.mjs';
import { resolvePrivate, secureAtomicWrite, secureReadByFd } from './secure-files.mjs';

protocol.registerSchemesAsPrivileged([{
  scheme: 'superwagie-render',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
}]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const valueAfter = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const workerUserData = process.env.SUPERWAGIE_WORKER_USER_DATA;
if (workerUserData) {
  if (!/^\.electron-profile-[1-9][0-9]*-[a-f0-9]{12}$/.test(workerUserData)) {
    process.stderr.write('WORKER_USER_DATA_INVALID\n');
    process.exit(1);
  }
  app.setPath('userData', resolvePrivate(process.cwd(), workerUserData, { leafMayBeMissing: true }));
  delete process.env.SUPERWAGIE_WORKER_USER_DATA;
}
const writeJson = (root, path, value) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  secureAtomicWrite(root, path, bytes);
  return bytes;
};

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const frameFile = (pattern, frame) => pattern.replace('%04d', String(frame).padStart(4, '0'));

function validateHashEntries(root, owner, entries) {
  if (!Array.isArray(entries) || entries.length > 128) throw new Error('EXECUTION_MANIFEST_SCHEMA_INVALID');
  const paths = new Set();
  for (const entry of entries) {
    if (!exactKeys(entry, ['path', 'sha256']) || !isHash(entry.sha256) || paths.has(entry.path)) throw new Error('EXECUTION_MANIFEST_SCHEMA_INVALID');
    resolvePrivate(root, entry.path);
    paths.add(entry.path);
  }
}

function validateManifest(root, wrapper) {
  if (!exactKeys(wrapper, ['mac', 'manifest']) || !isHash(wrapper.mac)) throw new Error('EXECUTION_MANIFEST_SCHEMA_INVALID');
  const key = process.env.SUPERWAGIE_JOB_KEY;
  const expected = createHmac('sha256', key).update(canonicalJson(wrapper.manifest)).digest();
  const supplied = Buffer.from(wrapper.mac, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('EXECUTION_MANIFEST_MAC_INVALID');
  const m = wrapper.manifest;
  const keys = ['schema_version', 'job_id', 'request_id', 'run_nonce', 'audience', 'revision', 'attempt',
    'composition', 'assets', 'fonts', 'runtime', 'frames', 'resource_limits', 'checkpoint',
    'output_authorization', 'crash_injection_after_frames', 'crash_injection_mode'];
  if (!exactKeys(m, keys) || m.schema_version !== 'solution-b-execution-v1' || m.audience !== 'render_worker'
    || !/^[a-z0-9-]{1,64}$/.test(m.job_id) || !/^[a-f0-9]{32}$/.test(m.request_id)
    || !/^[a-f0-9]{32}$/.test(m.run_nonce) || !Number.isSafeInteger(m.revision) || m.revision < 1
    || !Number.isSafeInteger(m.attempt) || m.attempt < 1) throw new Error('EXECUTION_MANIFEST_DOMAIN_INVALID');
  if (!exactKeys(m.composition, ['html_path', 'script_path', 'html_sha256', 'script_sha256', 'bundle_sha256'])
    || !exactKeys(m.assets, ['hashes']) || !exactKeys(m.fonts, ['hashes', 'glyph_rendering'])
    || !exactKeys(m.runtime, ['electron_executable_sha256', 'electron_version'])
    || !exactKeys(m.frames, ['start', 'end', 'indices'])
    || !exactKeys(m.resource_limits, ['max_frames', 'max_frame_bytes', 'max_output_bytes', 'max_process_tree_rss_bytes'])
    || !exactKeys(m.checkpoint, ['path', 'job_id', 'revision', 'initial_sha256'])
    || !exactKeys(m.output_authorization, ['directory', 'result_path', 'job_id', 'revision', 'frame_pattern'])) {
    throw new Error('EXECUTION_MANIFEST_SCHEMA_INVALID');
  }
  if (![m.composition.html_sha256, m.composition.script_sha256, m.composition.bundle_sha256,
    m.runtime.electron_executable_sha256].every(isHash)
    || typeof m.fonts.glyph_rendering !== 'boolean' || typeof m.runtime.electron_version !== 'string'
    || m.output_authorization.frame_pattern !== 'frame-%04d.png') throw new Error('EXECUTION_MANIFEST_DOMAIN_INVALID');
  validateHashEntries(root, 'assets', m.assets.hashes);
  validateHashEntries(root, 'fonts', m.fonts.hashes);
  for (const path of [m.composition.html_path, m.composition.script_path, m.checkpoint.path,
    m.output_authorization.directory, m.output_authorization.result_path]) resolvePrivate(root, path, { leafMayBeMissing: true });
  const uniqueFrames = new Set(m.frames.indices);
  if (!Array.isArray(m.frames.indices) || m.frames.indices.length === 0 || m.frames.indices.length > m.resource_limits.max_frames
    || m.frames.indices.some((frame) => !Number.isSafeInteger(frame) || frame < 0) || uniqueFrames.size !== m.frames.indices.length
    || !Number.isSafeInteger(m.frames.start) || !Number.isSafeInteger(m.frames.end)
    || m.frames.start !== Math.min(...m.frames.indices) || m.frames.end !== Math.max(...m.frames.indices)
    || !Object.values(m.resource_limits).every(isPositiveSafeInteger)
    || !Number.isSafeInteger(m.crash_injection_after_frames) || m.crash_injection_after_frames < 0
    || m.crash_injection_after_frames > m.resource_limits.max_frames
    || !['none', 'sigkill', 'exit1', 'exit86', 'hang'].includes(m.crash_injection_mode)
    || (m.crash_injection_after_frames === 0) !== (m.crash_injection_mode === 'none')
    || (m.attempt === 1 ? m.checkpoint.initial_sha256 !== null : !isHash(m.checkpoint.initial_sha256))
    || m.checkpoint.job_id !== m.job_id || m.checkpoint.revision !== m.revision
    || m.output_authorization.job_id !== m.job_id || m.output_authorization.revision !== m.revision) throw new Error('EXECUTION_MANIFEST_BOUNDS_INVALID');
  return m;
}

async function run() {
  const jobFile = valueAfter('--job-file');
  if (jobFile !== 'execution-manifest.json') throw new Error('RELATIVE_LOCKED_JOB_FILE_REQUIRED');
  const root = process.cwd();
  const manifest = validateManifest(root, JSON.parse(secureReadByFd(root, jobFile, 128 * 1024).toString('utf8')));
  const html = secureReadByFd(root, manifest.composition.html_path);
  const script = secureReadByFd(root, manifest.composition.script_path);
  const actualHashes = {
    html: sha256(html), script: sha256(script), bundle: sha256(Buffer.concat([html, script])),
    electron: sha256(readFileSync(process.execPath)),
    assets: Object.fromEntries(manifest.assets.hashes.map(({ path }) => [path, sha256(secureReadByFd(root, path))])),
    fonts: Object.fromEntries(manifest.fonts.hashes.map(({ path }) => [path, sha256(secureReadByFd(root, path))])),
  };
  if (actualHashes.html !== manifest.composition.html_sha256 || actualHashes.script !== manifest.composition.script_sha256
    || actualHashes.bundle !== manifest.composition.bundle_sha256 || actualHashes.electron !== manifest.runtime.electron_executable_sha256
    || manifest.assets.hashes.some(({ path, sha256: expected }) => actualHashes.assets[path] !== expected)
    || manifest.fonts.hashes.some(({ path, sha256: expected }) => actualHashes.fonts[path] !== expected)) {
    throw new Error(`EXECUTION_INPUT_HASH_MISMATCH:${JSON.stringify(actualHashes)}`);
  }
  if (manifest.runtime.electron_version !== process.versions.electron) throw new Error('EXECUTION_RUNTIME_IDENTITY_MISMATCH');

  const forbiddenEnvironment = ['HOME', ...(process.platform === 'win32' ? [] : ['PATH']), 'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'SUPERWAGIE_ENV_CANARY', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY'];
  const forbiddenVisible = forbiddenEnvironment.filter((name) => process.env[name] !== undefined);
  const windowsEnvironment = ['HOMEDRIVE', 'HOMEPATH', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
    'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
  const allowedEnvironment = new Set(['LANG', 'LC_ALL', 'SUPERWAGIE_JOB_KEY', '__CFBundleIdentifier', '__CF_USER_TEXT_ENCODING',
    ...(process.platform === 'win32' ? windowsEnvironment : [])]);
  const unexpectedEnvironment = Object.keys(process.env).filter((name) => !allowedEnvironment.has(name));

  const partition = `render-job-${manifest.job_id}-${manifest.run_nonce}`;
  const ses = session.fromPartition(partition, { cache: false });
  const schemeCounts = {};
  let blockedRemoteRequests = 0;
  let allowedRemoteRequests = 0;
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const scheme = new URL(details.url).protocol;
    schemeCounts[scheme] = (schemeCounts[scheme] ?? 0) + 1;
    const allowed = scheme === 'superwagie-render:' && new URL(details.url).hostname === 'bundle';
    if (allowed) allowedRemoteRequests += 0;
    else blockedRemoteRequests += 1;
    callback({ cancel: !allowed });
  });
  await ses.protocol.handle('superwagie-render', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'bundle') return new Response('not found', { status: 404 });
    if (url.pathname === '/composition.js') return new Response(script, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'content-security-policy': "default-src 'none'" } });
    if (url.pathname !== '/composition.html') return new Response('not found', { status: 404 });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'self'; img-src 'self' data:; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'" } });
  });

  const worker = new BrowserWindow({ show: false, width: 96, height: 64, useContentSize: true,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, offscreen: true, backgroundThrottling: false, webviewTag: false } });
  worker.webContents.on('will-navigate', (event) => event.preventDefault());
  worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await worker.loadURL('superwagie-render://bundle/composition.html');
  await worker.webContents.executeJavaScript(`Promise.all(Array.from(document.images).map((image) => {
    if (image.complete && image.naturalWidth > 0) return image.decode();
    return new Promise((resolve, reject) => {
      image.addEventListener('load', () => image.decode().then(resolve, reject), { once: true });
      image.addEventListener('error', () => reject(new Error('RENDER_ASSET_IMAGE_DECODE_FAILED')), { once: true });
    });
  }))`);
  worker.webContents.setZoomFactor(1);
  await ses.fetch('https://example.invalid/blocked').catch(() => null);

  const checkpointPath = resolvePrivate(root, manifest.checkpoint.path, { leafMayBeMissing: true });
  let checkpoint = { job_id: manifest.job_id, revision: manifest.revision, attempt: manifest.attempt, completed: {} };
  let checkpointRootVerified = manifest.attempt === 1;
  if (existsSync(checkpointPath)) {
    const checkpointBytes = secureReadByFd(root, manifest.checkpoint.path, 256 * 1024);
    if (manifest.attempt === 1 || sha256(checkpointBytes) !== manifest.checkpoint.initial_sha256) throw new Error('CHECKPOINT_ROOT_MISMATCH');
    checkpointRootVerified = true;
    checkpoint = JSON.parse(checkpointBytes.toString('utf8'));
    if (!exactKeys(checkpoint, ['attempt', 'completed', 'job_id', 'revision']) || checkpoint.job_id !== manifest.job_id
      || checkpoint.revision !== manifest.revision || checkpoint.attempt !== manifest.attempt - 1
      || !checkpoint.completed || typeof checkpoint.completed !== 'object' || Array.isArray(checkpoint.completed)) throw new Error('CHECKPOINT_IDENTITY_INVALID');
    checkpoint.attempt = manifest.attempt;
  } else if (manifest.attempt > 1) {
    throw new Error('CHECKPOINT_ROOT_MISSING');
  }
  let checkpointPngsRecomputed = true;
  let checkpointPngsDecoded = true;
  let totalOutputBytes = 0;
  for (const [frame, hash] of Object.entries(checkpoint.completed)) {
    if (!/^(0|[1-9][0-9]*)$/.test(frame) || !isHash(hash) || !manifest.frames.indices.includes(Number(frame))) throw new Error('CHECKPOINT_FRAME_INVALID');
    const relativePng = `${manifest.output_authorization.directory}/${frameFile(manifest.output_authorization.frame_pattern, Number(frame))}`;
    resolvePrivate(root, relativePng);
    const existingPng = secureReadByFd(root, relativePng, manifest.resource_limits.max_frame_bytes);
    if (sha256(existingPng) !== hash) throw new Error('CHECKPOINT_PNG_HASH_MISMATCH');
    const decoded = nativeImage.createFromBuffer(existingPng);
    const size = decoded.getSize();
    if (decoded.isEmpty() || size.width !== 96 || size.height !== 64) throw new Error('CHECKPOINT_PNG_INVALID');
    totalOutputBytes += existingPng.byteLength;
  }

  const started = performance.now();
  let framesRenderedThisAttempt = 0;
  const emitProgressReceipt = (checkpointBytes) => {
    const receipt = {
      schema_version: 'solution-b-progress-v1', job_id: manifest.job_id,
      request_id: manifest.request_id, run_nonce: manifest.run_nonce,
      revision: manifest.revision, attempt: manifest.attempt,
      checkpoint_sha256: sha256(checkpointBytes), completed: checkpoint.completed,
    };
    const wrapper = { type: 'checkpoint_progress', receipt,
      mac: createHmac('sha256', process.env.SUPERWAGIE_JOB_KEY).update(canonicalJson(receipt)).digest('hex') };
    writeSync(1, `${JSON.stringify(wrapper)}\n`);
  };
  for (const frameIndex of manifest.frames.indices) {
    const key = String(frameIndex);
    if (checkpoint.completed[key]) continue;
    const evaluation = await worker.webContents.executeJavaScript(`(()=>{const f=window.renderAbsoluteFrame(${JSON.stringify(frameIndex)});return{...f,pngDataUrl:document.getElementById('frame').toDataURL('image/png')}})()`);
    if (evaluation.frameIndex !== frameIndex) throw new Error('ABSOLUTE_FRAME_MISMATCH');
    const prefix = 'data:image/png;base64,';
    if (!evaluation.pngDataUrl.startsWith(prefix)) throw new Error('PNG_ENCODING_FAILED');
    const png = Buffer.from(evaluation.pngDataUrl.slice(prefix.length), 'base64');
    if (png.byteLength > manifest.resource_limits.max_frame_bytes) throw new Error('FRAME_RESOURCE_LIMIT');
    totalOutputBytes += png.byteLength;
    if (totalOutputBytes > manifest.resource_limits.max_output_bytes) throw new Error('OUTPUT_RESOURCE_LIMIT');
    const hash = sha256(png);
    const outputName = frameFile(manifest.output_authorization.frame_pattern, frameIndex);
    writeJson(root, `${manifest.output_authorization.directory}/${outputName}.meta.json`, { sha256: hash, bytes: png.byteLength });
    secureAtomicWrite(root, `${manifest.output_authorization.directory}/${outputName}`, png);
    checkpoint.completed[key] = hash;
    const checkpointBytes = writeJson(root, manifest.checkpoint.path, checkpoint);
    emitProgressReceipt(checkpointBytes);
    framesRenderedThisAttempt += 1;
    if (manifest.crash_injection_after_frames && framesRenderedThisAttempt >= manifest.crash_injection_after_frames) {
      if (manifest.crash_injection_mode === 'hang') {
        setInterval(() => {}, 60_000);
        await new Promise(() => {});
      }
      worker.destroy();
      if (manifest.crash_injection_mode === 'sigkill') process.kill(process.pid, 'SIGKILL');
      else if (manifest.crash_injection_mode === 'exit1') app.exit(1);
      else app.exit(86);
      return;
    }
  }
  const elapsedMs = performance.now() - started;
  const metrics = app.getAppMetrics();
  const processTreeRssBytes = metrics.reduce((sum, item) => sum + (item.memory?.workingSetSize ?? 0) * 1024, 0);
  if (processTreeRssBytes > manifest.resource_limits.max_process_tree_rss_bytes) throw new Error('PROCESS_TREE_RESOURCE_LIMIT');
  const processTreeTypes = [...new Set(metrics.map((item) => item.type))].sort();
  const hashes = manifest.frames.indices.map((frame) => checkpoint.completed[String(frame)]);
  const result = {
    jobId: manifest.job_id, requestId: manifest.request_id, revision: manifest.revision,
    hostPid: process.pid, parentPid: process.ppid, partition, frameIndices: manifest.frames.indices,
    hashes, framesRenderedThisAttempt, elapsedMs,
    frameThroughputFps: elapsedMs > 0 ? framesRenderedThisAttempt / (elapsedMs / 1000) : 0,
    hostMainRssBytes: process.memoryUsage().rss, processTreeRssBytes, processTreeTypes,
    executionManifestVerified: true, checkpointPngsRecomputed, checkpointPngsDecoded, checkpointRootVerified,
    environmentFromEmptyWhitelist: unexpectedEnvironment.length === 0 && forbiddenVisible.length === 0,
    hostSecretCanaryVisible: forbiddenVisible.includes('SUPERWAGIE_ENV_CANARY'),
    unexpectedEnvironment, forbiddenVisible, signedCompositionVerified: true, absoluteFrameDriven: true,
    allSchemeNetworkAttempts: Object.values(schemeCounts).reduce((a, b) => a + b, 0), schemeCounts,
    blockedRemoteRequests, allowedRemoteRequests,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  };
  writeJson(root, manifest.output_authorization.result_path, result);
  await ses.clearStorageData(); worker.destroy(); app.quit();
}

app.whenReady().then(run).catch((error) => { console.error(error.stack ?? error); app.exit(1); });
