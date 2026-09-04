import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runtimePlatform } from '../../solution-b-spike/src/runtime-platform.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const platform = runtimePlatform();

function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const PROFILE_BY_FIXTURE = Object.freeze({
  'G4-VIDEO-001': Object.freeze({
    profile: 'website_demo', title: '网站 Demo',
    narration: '这是网站演示验证。页面来源固定，视频层只增加受控镜头、旁白和字幕，不修改页面事实。',
    visualTruth: 'product_chromium_page_capture', motion: 'browser_tour',
    sourcePath: 'fixtures/gate-3/G3-WRITER-001/diagram.png',
    sourceSha256: '3357b85568d51f7e32ef395f8b4db893f4abe6f57df61ad89ad6abd6dacd6001',
    sourceProofPath: null, sourceProofSha256: null,
  }),
  'G4-VIDEO-002': Object.freeze({
    profile: 'teaching_courseware', title: '教学课件',
    narration: '这是教学课件验证。固定图解作为事实源，通过章节节奏、重点提示、旁白和字幕形成课程视频。',
    visualTruth: 'product_owned_diagram', motion: 'chapter_focus',
    sourcePath: 'fixtures/gate-1/G1-MARKDOWN-001/fixtures/图片素材.png',
    sourceSha256: '69b8f892f10723b5fea87b704ca805d51fac2e7bd79fe8b3946d664689c8f985',
    sourceProofPath: null, sourceProofSha256: null,
  }),
  'G4-VIDEO-003': Object.freeze({
    profile: 'ppt_explainer', title: 'PPT 讲解',
    narration: '这是 PPT 讲解验证。画面来自真实 WPS 演示渲染，视频层只增加讲解节奏、聚焦和字幕，不重新排版。',
    visualTruth: 'product_owned_presentation_fixture', motion: 'page_focus',
    sourcePath: 'fixtures/gate-3/G3-PPT-001/fixtures/presentation-visual-1920x1080.png',
    sourceSha256: '20d8e23f49f6d7fdb56491f694472d8898c22dec84ef399c51089a673989196f',
    sourceProofPath: null, sourceProofSha256: null,
  }),
  'G4-VIDEO-004': Object.freeze({
    profile: 'picture_book', title: '图片绘本',
    narration: '这是图片绘本验证。固定插画只做受控平移缩放，原图保持不变，并支持单个场景局部返工。',
    visualTruth: 'product_owned_illustration', motion: 'picture_book_pan',
    sourcePath: 'fixtures/gate-1/G1-MARKDOWN-001/fixtures/图片素材.png',
    sourceSha256: '69b8f892f10723b5fea87b704ca805d51fac2e7bd79fe8b3946d664689c8f985',
    sourceProofPath: null, sourceProofSha256: null,
  }),
  'G4-VIDEO-005': Object.freeze({
    profile: 'photo_motion', title: '照片动态',
    narration: '这是照片动态验证。系统只生成派生裁切与运动路径，不修改原始照片，并保留来源和授权记录。',
    visualTruth: 'product_owned_image_fixture', motion: 'safe_photo_motion',
    sourcePath: 'fixtures/gate-3/G3-PPT-001/fixtures/presentation-visual-1920x1080.png',
    sourceSha256: '20d8e23f49f6d7fdb56491f694472d8898c22dec84ef399c51089a673989196f',
    sourceProofPath: null, sourceProofSha256: null,
  }),
});

function mediaType(path) {
  return path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

export async function buildCompositionBundle({ fixture, repositoryRoot }) {
  const config = PROFILE_BY_FIXTURE[fixture];
  if (!config) throw new Error('TASK6_PROFILE_REQUIRED');
  const sourceBytes = readFileSync(join(repositoryRoot, config.sourcePath));
  const actualHash = sha256(sourceBytes);
  if (actualHash !== config.sourceSha256) throw new Error(`TASK6_SOURCE_HASH_MISMATCH:${actualHash}`);
  const sourceDataUrl = `data:${mediaType(config.sourcePath)};base64,${sourceBytes.toString('base64')}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${config.profile}</title></head><body><img id="source" src="${sourceDataUrl}"><canvas id="frame" width="96" height="64"></canvas><script src="/composition.js"></script></body></html>\n`;
  const script = `const profile = ${JSON.stringify(config.profile)}; const motion = ${JSON.stringify(config.motion)}; const source = document.getElementById('source'); const canvas = document.getElementById('frame'); const context = canvas.getContext('2d', { alpha: false }); function renderAbsoluteFrame(frameIndex) { const t = Math.max(0, Math.min(1, frameIndex / 899)); context.fillStyle = '#101418'; context.fillRect(0,0,96,64); const sourceWidth = source.naturalWidth || 96; const sourceHeight = source.naturalHeight || 64; const zoom = motion === 'picture_book_pan' || motion === 'safe_photo_motion' ? 1.06 + t * 0.12 : 1.02 + t * 0.05; const sx = (sourceWidth - sourceWidth / zoom) / 2; const sy = (sourceHeight - sourceHeight / zoom) / 2; const dx = motion === 'browser_tour' ? Math.sin(t * Math.PI * 2) * 3 : 0; const dy = motion === 'safe_photo_motion' ? Math.cos(t * Math.PI * 2) * 2 : 0; if (sourceWidth > 0 && sourceHeight > 0) context.drawImage(source, sx, sy, sourceWidth / zoom, sourceHeight / zoom, dx, dy, 96, 64); else { context.fillStyle = '#243139'; context.fillRect(8,8,80,48); } if (profile === 'website_demo') { context.fillStyle = 'rgba(56,132,255,0.22)'; context.fillRect(0, 52 + Math.round(t * 8), 96, 3); } if (profile === 'teaching_courseware') { context.fillStyle = 'rgba(255,196,74,0.28)'; context.fillRect(4, 10 + Math.round(t * 44), 20, 3); } if (profile === 'ppt_explainer') { context.strokeStyle = 'rgba(255,255,255,0.7)'; context.lineWidth = 1; context.strokeRect(18 + Math.round(t * 8), 16, 52, 30); } if (profile === 'picture_book') { context.fillStyle = 'rgba(255,255,255,0.14)'; context.fillRect(0,0,96,1); context.fillRect(0,63,96,1); } if (profile === 'photo_motion') { context.fillStyle = 'rgba(0,0,0,0.18)'; context.fillRect(0,0,10,64); context.fillRect(86,0,10,64); } return { frameIndex, profile, motion, zoom }; }\n`;
  return {
    html, script,
    htmlSha256: sha256(Buffer.from(html)),
    scriptSha256: sha256(Buffer.from(script)),
    bundleSha256: sha256(Buffer.concat([Buffer.from(html), Buffer.from(script)])),
  };
}

function writePrivate(path, bytes) {
  writeFileSync(path, bytes, { mode: 0o600 });
}

export async function prepareRenderJob({
  fixture, repositoryRoot, candidateRoot, workRoot, frameCount, crashAfterFrames = 0, crashMode = 'none',
}) {
  const config = PROFILE_BY_FIXTURE[fixture];
  if (!config) throw new Error('TASK6_PROFILE_REQUIRED');
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || frameCount > 900) throw new Error('TASK6_FRAME_COUNT_INVALID');
  const jobRoot = join(workRoot, fixture.toLowerCase());
  for (const directory of [join(jobRoot, 'inputs'), join(jobRoot, 'outputs', 'frames'), join(jobRoot, 'state')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const bundle = await buildCompositionBundle({ fixture, repositoryRoot });
  writePrivate(join(jobRoot, 'inputs', 'composition.html'), Buffer.from(bundle.html));
  writePrivate(join(jobRoot, 'inputs', 'composition.js'), Buffer.from(bundle.script));
  const sourceDestination = join(jobRoot, 'inputs', `source-${basename(config.sourcePath)}`);
  copyFileSync(join(repositoryRoot, config.sourcePath), sourceDestination);
  const assets = [{ path: `inputs/source-${basename(config.sourcePath)}`, sha256: config.sourceSha256 }];
  if (config.sourceProofPath) {
    const proofDestination = join(jobRoot, 'inputs', 'source-proof.json');
    copyFileSync(join(repositoryRoot, config.sourceProofPath), proofDestination);
    assets.push({ path: 'inputs/source-proof.json', sha256: config.sourceProofSha256 });
  }
  const runtimeManifest = JSON.parse(readFileSync(join(candidateRoot, 'runtime-manifest.json'), 'utf8'));
  if (runtimeManifest.platform !== platform.id || runtimeManifest.manifest_version !== 'solution-b-v1') throw new Error('TASK6_CANDIDATE_PLATFORM_MISMATCH');
  const electron = join(candidateRoot, ...runtimeManifest.launch.executable.split('/'));
  const workerScript = join(candidateRoot, 'src', 'render-worker-host.mjs');
  const jobKey = randomBytes(32).toString('hex');
  const request_id = randomBytes(16).toString('hex');
  const run_nonce = randomBytes(16).toString('hex');
  const manifest = {
    schema_version: 'solution-b-execution-v1', job_id: fixture.toLowerCase(),
    request_id, run_nonce, audience: 'render_worker', revision: 1, attempt: 1,
    composition: {
      html_path: 'inputs/composition.html', script_path: 'inputs/composition.js',
      html_sha256: bundle.htmlSha256, script_sha256: bundle.scriptSha256, bundle_sha256: bundle.bundleSha256,
    },
    assets: { hashes: assets }, fonts: { hashes: [], glyph_rendering: false },
    runtime: { electron_executable_sha256: sha256(readFileSync(electron)), electron_version: '44.1.0' },
    frames: { start: 0, end: frameCount - 1, indices: Array.from({ length: frameCount }, (_, index) => index) },
    resource_limits: {
      max_frames: frameCount, max_frame_bytes: 1_000_000,
      max_output_bytes: Math.max(frameCount * 100_000, 1_000_000), max_process_tree_rss_bytes: 1_000_000_000,
    },
    checkpoint: { path: 'state/checkpoint.json', job_id: fixture.toLowerCase(), revision: 1, initial_sha256: null },
    output_authorization: {
      directory: 'outputs/frames', result_path: 'outputs/result.json',
      job_id: fixture.toLowerCase(), revision: 1, frame_pattern: 'frame-%04d.png',
    },
    crash_injection_after_frames: crashAfterFrames,
    crash_injection_mode: crashAfterFrames ? crashMode : 'none',
  };
  const wrapper = { manifest, mac: createHmac('sha256', jobKey).update(canonicalJson(manifest)).digest('hex') };
  writePrivate(join(jobRoot, 'execution-manifest.json'), Buffer.from(`${JSON.stringify(wrapper, null, 2)}\n`));
  return { fixture, config, jobRoot, jobKey, manifest, electron, workerScript };
}

function receiptMac(jobKey, receipt) {
  return createHmac('sha256', jobKey).update(canonicalJson(receipt)).digest('hex');
}

export function makeProgressLine({ jobKey, manifest, completed, checkpointSha256 }) {
  const receipt = {
    schema_version: 'solution-b-progress-v1', job_id: manifest.job_id,
    request_id: manifest.request_id, run_nonce: manifest.run_nonce,
    revision: manifest.revision, attempt: manifest.attempt,
    checkpoint_sha256: checkpointSha256, completed,
  };
  return { type: 'checkpoint_progress', receipt, mac: receiptMac(jobKey, receipt) };
}

function validateProgressLine(line, jobKey, manifest) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  const receipt = line.receipt;
  if (line.type !== 'checkpoint_progress' || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const lineKeys = Object.keys(line).sort().join('\0');
  const receiptKeys = Object.keys(receipt).sort().join('\0');
  if (lineKeys !== ['mac', 'receipt', 'type'].sort().join('\0')
    || receiptKeys !== ['attempt', 'checkpoint_sha256', 'completed', 'job_id', 'request_id', 'revision', 'run_nonce', 'schema_version'].sort().join('\0')
    || !/^[a-f0-9]{64}$/.test(line.mac ?? '') || !/^[a-f0-9]{64}$/.test(receipt.checkpoint_sha256 ?? '')) return null;
  if (receiptMac(jobKey, receipt) !== line.mac || receipt.schema_version !== 'solution-b-progress-v1'
    || receipt.job_id !== manifest.job_id || receipt.request_id !== manifest.request_id
    || receipt.run_nonce !== manifest.run_nonce || receipt.revision !== manifest.revision
    || receipt.attempt !== manifest.attempt || !receipt.completed || typeof receipt.completed !== 'object'
    || Array.isArray(receipt.completed)) return null;
  for (const [frame, hash] of Object.entries(receipt.completed)) {
    if (!/^(0|[1-9][0-9]*)$/.test(frame) || !/^[a-f0-9]{64}$/.test(hash)
      || !manifest.frames.indices.includes(Number(frame))) return null;
  }
  return receipt;
}

function validateProgressStdout(stdout, jobKey, manifest) {
  const receipts = [];
  let previousCompleted = {};
  for (const textLine of String(stdout).split('\n').filter(Boolean)) {
    let parsed;
    try { parsed = JSON.parse(textLine); } catch { continue; }
    const receipt = validateProgressLine(parsed, jobKey, manifest);
    if (!receipt) continue;
    if (Object.entries(previousCompleted).some(([frame, hash]) => receipt.completed[frame] !== hash)) continue;
    previousCompleted = { ...receipt.completed };
    receipts.push(receipt);
  }
  return receipts;
}

function writeManifestWrapper(jobRoot, manifest, jobKey) {
  const wrapper = { manifest, mac: createHmac('sha256', jobKey).update(canonicalJson(manifest)).digest('hex') };
  writePrivate(join(jobRoot, 'execution-manifest.json'), Buffer.from(`${JSON.stringify(wrapper, null, 2)}\n`));
  return wrapper;
}

export async function runPreparedRenderJob({
  fixture, jobRoot, jobKey, manifest, electron, workerScript, spawnWorker, maxRestarts = 1,
}) {
  if (typeof spawnWorker !== 'function') throw new Error('TASK6_SPAWN_WORKER_REQUIRED');
  const executions = [];
  let trustedReceipt = null;
  let currentManifest = manifest;
  let restarts = 0;
  let execution;
  while (true) {
    execution = await spawnWorker({ fixture, jobRoot, jobKey, manifest: currentManifest, electron, workerScript, attempt: currentManifest.attempt });
    executions.push(execution);
    const receipts = validateProgressStdout(execution.stdout ?? '', jobKey, currentManifest);
    if (receipts.length > 0) trustedReceipt = receipts.at(-1);
    if (execution.kind === 'cancelled') {
      return { cleanExit: false, cancelled: true, authenticatedProgressReceiptVerified: receipts.length > 0,
        trustedCheckpointSha256: trustedReceipt?.checkpoint_sha256 ?? null, executions, restarts,
        attempts: executions.length };
    }
    if (execution.kind === 'exit' && execution.code === 0 && execution.signal === null && trustedReceipt) {
      return { cleanExit: true, cancelled: false, authenticatedProgressReceiptVerified: true,
        trustedCheckpointSha256: trustedReceipt.checkpoint_sha256, executions, restarts,
        attempts: executions.length, recoveredFromCrash: executions.length > 1 };
    }
    if (!trustedReceipt) {
      return { cleanExit: false, cancelled: false, authenticatedProgressReceiptVerified: false,
        error: 'AUTHENTICATED_PROGRESS_RECEIPT_REQUIRED', trustedCheckpointSha256: null,
        executions, restarts, attempts: executions.length };
    }
    if (restarts >= maxRestarts) {
      return { cleanExit: false, cancelled: false, authenticatedProgressReceiptVerified: true,
        error: 'TASK6_RESTART_BUDGET_EXHAUSTED', trustedCheckpointSha256: trustedReceipt.checkpoint_sha256,
        executions, restarts, attempts: executions.length };
    }
    restarts += 1;
    currentManifest = {
      ...currentManifest,
      attempt: currentManifest.attempt + 1,
      checkpoint: { ...currentManifest.checkpoint, initial_sha256: trustedReceipt.checkpoint_sha256 },
      crash_injection_after_frames: 0,
      crash_injection_mode: 'none',
    };
    writeManifestWrapper(jobRoot, currentManifest, jobKey);
  }
}

export function spawnRenderWorker({
  jobRoot, jobKey, manifest, electron, workerScript, timeoutMs = 60_000, cancellationSignal = null,
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
      if (process.platform === 'win32') {
        spawnSync(join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, encoding: 'utf8' });
      } else child.kill('SIGKILL');
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

export async function renderFrames({
  fixture, repositoryRoot, candidateRoot, workRoot, frameCount,
  crashAfterFrames = 0, crashMode = 'none', timeoutMs = 60_000, maxRestarts = 2,
}) {
  const prepared = await prepareRenderJob({
    fixture, repositoryRoot, candidateRoot, workRoot, frameCount, crashAfterFrames, crashMode,
  });
  const outcome = await runPreparedRenderJob({
    ...prepared,
    maxRestarts,
    spawnWorker: ({ manifest }) => spawnRenderWorker({
      jobRoot: prepared.jobRoot, jobKey: prepared.jobKey, manifest, electron: prepared.electron,
      workerScript: prepared.workerScript, timeoutMs,
    }),
  });
  let result = null;
  if (outcome.cleanExit) {
    result = JSON.parse(readFileSync(join(prepared.jobRoot, 'outputs', 'result.json'), 'utf8'));
    if (result.jobId !== prepared.manifest.job_id || result.requestId !== prepared.manifest.request_id
      || result.revision !== prepared.manifest.revision) throw new Error('TASK6_RENDER_RESULT_IDENTITY_INVALID');
    if (!Array.isArray(result.hashes) || result.hashes.length !== frameCount) throw new Error('TASK6_RENDER_FRAME_COUNT_INVALID');
  }
  return { ...outcome, result, jobRoot: prepared.jobRoot, config: prepared.config };
}
