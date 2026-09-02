import { app, protocol } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CoreClient } from './core-client.mjs';
import { canonicalJson } from './core-client.mjs';
import { CoreSupervisor } from './core-supervisor.mjs';
import { SurfaceManager } from './surface-manager.mjs';
import { secureAtomicWrite, secureCopyByFd } from './secure-files.mjs';

const processStartedAt = performance.now();
const pause = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

protocol.registerSchemesAsPrivileged([{
  scheme: 'superwagie-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
}]);
app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');
if (process.env.SUPERWAGIE_OFFLINE === '1') {
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  app.commandLine.appendSwitch('disable-features', 'NetworkServiceInProcess');
}

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function spawnAndWait(executable, args, options = {}) {
  return new Promise((resolvePromise) => {
    const { timeoutMs = 0, cancellationSignal = null, ...spawnOptions } = options;
    if (cancellationSignal?.aborted) {
      resolvePromise({ kind: 'cancelled', code: null, signal: null, pid: null, stdout: '', stderr: '', error: 'CANCELLED_BEFORE_SPAWN' });
      return;
    }
    let child;
    try { child = spawn(executable, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      resolvePromise({ kind: 'spawn_error', code: null, signal: null, pid: null, stdout: '', stderr: '', error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let terminalKind = null;
    let settled = false;
    let timeout;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancellationSignal?.removeEventListener('abort', cancel);
      resolvePromise({ ...outcome, pid: child.pid, stdout, stderr });
    };
    const cancel = () => {
      terminalKind = 'cancelled';
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ kind: 'spawn_error', code: null, signal: null, error: error.message }));
    child.on('exit', (code, signal) => finish({ kind: terminalKind ?? 'exit', code, signal, error: null }));
    cancellationSignal?.addEventListener('abort', cancel, { once: true });
    if (timeoutMs > 0) timeout = setTimeout(() => {
      terminalKind = 'timeout';
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, timeoutMs);
  });
}

function validateProgressReceipts(stdout, jobKey, manifest) {
  const receipts = [];
  let previousCompleted = {};
  for (const line of stdout.split('\n').filter(Boolean)) {
    let wrapper;
    try { wrapper = JSON.parse(line); } catch { continue; }
    const receipt = wrapper?.receipt;
    if (wrapper?.type !== 'checkpoint_progress' || !receipt || typeof receipt !== 'object'
      || Object.keys(wrapper).sort().join('\0') !== ['mac', 'receipt', 'type'].join('\0')
      || Object.keys(receipt).sort().join('\0') !== ['attempt', 'checkpoint_sha256', 'completed', 'job_id', 'request_id', 'revision', 'run_nonce', 'schema_version'].sort().join('\0')
      || !/^[a-f0-9]{64}$/.test(wrapper.mac ?? '') || !/^[a-f0-9]{64}$/.test(receipt.checkpoint_sha256 ?? '')) continue;
    const expectedMac = createHmac('sha256', jobKey).update(canonicalJson(receipt)).digest('hex');
    if (wrapper.mac !== expectedMac || receipt.schema_version !== 'solution-b-progress-v1'
      || receipt.job_id !== manifest.job_id || receipt.request_id !== manifest.request_id
      || receipt.run_nonce !== manifest.run_nonce || receipt.revision !== manifest.revision
      || receipt.attempt !== manifest.attempt || !receipt.completed || typeof receipt.completed !== 'object'
      || Array.isArray(receipt.completed)) continue;
    const entries = Object.entries(receipt.completed);
    if (entries.some(([frame, hash]) => !/^(0|[1-9][0-9]*)$/.test(frame) || !/^[a-f0-9]{64}$/.test(hash)
      || !manifest.frames.indices.includes(Number(frame)))) continue;
    if (Object.entries(previousCompleted).some(([frame, hash]) => receipt.completed[frame] !== hash)) continue;
    previousCompleted = { ...receipt.completed };
    receipts.push(receipt);
  }
  return receipts;
}

async function waitUntilGone(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
    await pause(50);
  }
  return false;
}

async function runWorkerJob({ spikeRoot, runRoot, name, crashAfterFrames = 0, crashMode = 'none',
  maxRestarts = 1, crashEveryAttempt = false, workerTimeoutMs = 15_000,
  spawnFailureAttempts = 0, cancellationSignal = null, tamperCheckpointAfterCrash = false }) {
  const jobRoot = join(runRoot, 'render-jobs', name);
  await mkdir(join(jobRoot, 'inputs'), { recursive: true, mode: 0o700 });
  await mkdir(join(jobRoot, 'outputs', 'frames'), { recursive: true, mode: 0o700 });
  await mkdir(join(jobRoot, 'state'), { recursive: true, mode: 0o700 });
  secureCopyByFd(spikeRoot, join('src', 'static', 'composition.html'), jobRoot, join('inputs', 'composition.html'));
  secureCopyByFd(spikeRoot, join('src', 'static', 'composition.js'), jobRoot, join('inputs', 'composition.js'));
  const compositionHtml = await readFile(join(jobRoot, 'inputs', 'composition.html'));
  const compositionScript = await readFile(join(jobRoot, 'inputs', 'composition.js'));
  const jobKey = randomBytes(32).toString('hex');
  const runNonce = randomBytes(16).toString('hex');
  const baseManifest = {
    schema_version: 'solution-b-execution-v1', job_id: name,
    request_id: randomBytes(16).toString('hex'), run_nonce: runNonce,
    audience: 'render_worker', revision: 1, attempt: 1,
    composition: {
      html_path: 'inputs/composition.html', script_path: 'inputs/composition.js',
      html_sha256: sha256(compositionHtml), script_sha256: sha256(compositionScript),
      bundle_sha256: sha256(Buffer.concat([compositionHtml, compositionScript])),
    },
    assets: { hashes: [] }, fonts: { hashes: [], glyph_rendering: false },
    runtime: { electron_executable_sha256: sha256(await readFile(process.execPath)), electron_version: '44.1.0' },
    frames: { start: 0, end: 2, indices: [0, 1, 2] },
    resource_limits: { max_frames: 3, max_frame_bytes: 1_000_000, max_output_bytes: 3_000_000, max_process_tree_rss_bytes: 1_000_000_000 },
    checkpoint: { path: 'state/checkpoint.json', job_id: name, revision: 1, initial_sha256: null },
    output_authorization: { directory: 'outputs/frames', result_path: 'outputs/result.json', job_id: name, revision: 1, frame_pattern: 'frame-%04d.png' },
    crash_injection_after_frames: crashAfterFrames,
    crash_injection_mode: crashAfterFrames ? crashMode : 'none',
  };
  const writeManifest = (manifest) => secureAtomicWrite(jobRoot, 'execution-manifest.json', Buffer.from(`${JSON.stringify({
    manifest, mac: createHmac('sha256', jobKey).update(canonicalJson(manifest)).digest('hex'),
  }, null, 2)}\n`));
  const spawnWorker = (executable) => spawnAndWait(executable, [join(spikeRoot, 'src', 'render-worker-host.mjs'), '--job-file', 'execution-manifest.json'], {
    cwd: jobRoot,
    env: { LANG: 'C', LC_ALL: 'C', SUPERWAGIE_JOB_KEY: jobKey },
    timeoutMs: workerTimeoutMs,
    cancellationSignal,
  });
  let execution;
  const executions = [];
  let crashExecution = null;
  let crashObservedToReadyMs = 0;
  let restartCount = 0;
  let trustedProgressReceipt = null;
  let authenticatedProgressReceiptVerified = false;
  const observedAt = performance.now();
  for (let processAttempt = 1; ; processAttempt += 1) {
    const manifestAttempt = trustedProgressReceipt ? trustedProgressReceipt.attempt + 1 : 1;
    const initialSha256 = trustedProgressReceipt?.checkpoint_sha256 ?? null;
    const injectThisAttempt = crashAfterFrames > 0 && (processAttempt === 1 || crashEveryAttempt);
    const manifest = { ...baseManifest, attempt: manifestAttempt,
      checkpoint: { ...baseManifest.checkpoint, initial_sha256: initialSha256 },
      crash_injection_after_frames: injectThisAttempt ? crashAfterFrames : 0,
      crash_injection_mode: injectThisAttempt ? crashMode : 'none' };
    writeManifest(manifest);
    const executable = processAttempt <= spawnFailureAttempts ? join(jobRoot, 'missing-worker-executable') : process.execPath;
    execution = await spawnWorker(executable);
    executions.push(execution);
    const receipts = validateProgressReceipts(execution.stdout, jobKey, manifest);
    if (receipts.length > 0) {
      trustedProgressReceipt = receipts.at(-1);
      authenticatedProgressReceiptVerified = true;
    }
    if (execution.kind === 'exit' && execution.code === 0 && execution.signal === null) break;
    if (execution.kind === 'cancelled') break;
    crashExecution ??= execution;
    if (restartCount >= maxRestarts) break;
    restartCount += 1;
    if (tamperCheckpointAfterCrash && processAttempt === 1 && trustedProgressReceipt) {
      const checkpointPath = join(jobRoot, baseManifest.checkpoint.path);
      const bytes = await readFile(checkpointPath);
      secureAtomicWrite(jobRoot, baseManifest.checkpoint.path, Buffer.concat([bytes, Buffer.from(' ')]));
    }
    if (!trustedProgressReceipt) {
      await rm(join(jobRoot, baseManifest.checkpoint.path), { force: true });
      await rm(join(jobRoot, baseManifest.output_authorization.directory), { recursive: true, force: true });
      await mkdir(join(jobRoot, baseManifest.output_authorization.directory), { recursive: true, mode: 0o700 });
    }
  }
  const cleanExit = execution.kind === 'exit' && execution.code === 0 && execution.signal === null;
  if (executions.length > 1 && cleanExit) crashObservedToReadyMs = performance.now() - observedAt;
  return {
    execution, executions, crashExecution, crashObservedToReadyMs, restartCount,
    recoveredFromUnexpectedExit: executions.length > 1 && cleanExit,
    restartBudgetExhausted: executions.length === maxRestarts + 1 && !cleanExit && execution.kind !== 'cancelled',
    spawnErrorReconciled: executions.some(({ kind }) => kind === 'spawn_error') && cleanExit,
    hungTimeoutRecovered: executions.some(({ kind }) => kind === 'timeout') && cleanExit,
    cancelShutdownNotRetried: execution.kind === 'cancelled' && executions.length === 1 && restartCount === 0,
    checkpointRootSource: trustedProgressReceipt ? 'worker_authenticated_progress_receipt' : null,
    postCrashCheckpointRehashes: 0,
    authenticatedProgressReceiptVerified,
    jobRoot, resultPath: join(jobRoot, 'outputs', 'result.json'),
  };
}

async function runSelfTest() {
  const outputPath = valueAfter('--output');
  const spikeRoot = resolve(process.env.SUPERWAGIE_SPIKE_ROOT ?? resolve(import.meta.dirname, '..'));
  const runRoot = resolve(process.env.SUPERWAGIE_RUN_ROOT ?? join(spikeRoot, '.run'));
  const releaseCore = join(spikeRoot, 'core', 'target', 'release', 'solution-b-core');
  const coreBinary = resolve(process.env.SUPERWAGIE_CORE_BIN ?? (existsSync(releaseCore) ? releaseCore : join(spikeRoot, 'core', 'target', 'debug', 'solution-b-core')));
  const evidenceRunNonce = process.env.SUPERWAGIE_EVIDENCE_RUN_NONCE ?? randomBytes(16).toString('hex');
  if (!outputPath) throw new Error('--output is required');
  await access(coreBinary);
  await mkdir(runRoot, { recursive: true });
  const checkpointPath = join(runRoot, 'core-checkpoint.json');
  let surfaces;
  const core = new CoreSupervisor({
    binary: coreBinary,
    checkpointPath,
    onState: (event) => { surfaces?.setCoreStatus(event.state).catch(() => {}); },
  });
  const firstHello = await core.start();
  const firstCorePid = core.child.pid;
  const memorySamples = [];
  const sampleMainMemory = (phase) => {
    const appWorkingSetKb = app.getAppMetrics().reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0);
    const sample = { phase, main_rss_bytes: process.memoryUsage().rss, app_working_set_kb: appWorkingSetKb };
    memorySamples.push(sample);
    return sample;
  };
  const idleMemory = sampleMainMemory('core-ready');
  const heartbeat = await core.request({ type: 'heartbeat' });
  const initialSnapshot = await core.request({ type: 'query', query_id: 'shell.snapshot', after_cursor: null });

  const handle = await core.request({
    type: 'issue_handle',
    resource_id: 'artifact:preview-fixture',
    revision: 1,
    audience: 'artifact_preview:surface-3',
    operations: ['read', 'range_read'],
    ttl_ms: 60_000,
    size_limit: 1024,
    range_limit: 256,
    one_shot: false,
  });
  const verify = (overrides = {}) => core.request({
    type: 'verify_handle',
    signed_handle: handle.signed_handle,
    audience: 'artifact_preview:surface-3',
    operation: 'read',
    revision: 1,
    offset: 0,
    length: 16,
    ...overrides,
  });
  const validHandle = await verify();
  const crossSurface = await verify({ audience: 'diagram_editor:surface-2' });
  const forgedSignedHandle = `${handle.signed_handle.slice(0, -1)}${handle.signed_handle.endsWith('0') ? '1' : '0'}`;
  const forged = await verify({ signed_handle: forgedSignedHandle });
  const wrongOperation = await verify({ operation: 'render' });
  const wrongRevision = await verify({ revision: 2 });
  const oversize = await verify({ length: 2048 });
  const overrange = await verify({ operation: 'range_read', length: 512 });
  const oneShot = await core.request({
    type: 'issue_handle', resource_id: 'artifact:one-shot', revision: 1,
    audience: 'artifact_preview:surface-3', operations: ['read'], ttl_ms: 60_000,
    size_limit: 8, range_limit: 8, one_shot: true,
  });
  const verifyOneShot = () => core.request({
    type: 'verify_handle', signed_handle: oneShot.signed_handle,
    audience: 'artifact_preview:surface-3', operation: 'read', revision: 1,
    offset: 0, length: 1,
  });
  const oneShotFirst = await verifyOneShot();
  const oneShotSecond = await verifyOneShot();
  const revocable = await core.request({
    type: 'issue_handle', resource_id: 'artifact:revocable', revision: 1,
    audience: 'artifact_preview:surface-3', operations: ['read'], ttl_ms: 60_000,
    size_limit: 8, range_limit: 8, one_shot: false,
  });
  await core.request({ type: 'revoke_handle', handle_id: revocable.handle_id });
  const revoked = await core.request({
    type: 'verify_handle', signed_handle: revocable.signed_handle,
    audience: 'artifact_preview:surface-3', operation: 'read', revision: 1,
    offset: 0, length: 1,
  });
  const handleChecks = {
    valid: validHandle.valid === true,
    audience: crossSurface.code === 'AUDIENCE_MISMATCH',
    forged: forged.code === 'HANDLE_FORGED',
    operation: wrongOperation.code === 'OPERATION_DENIED',
    revision: wrongRevision.code === 'REVISION_MISMATCH',
    size: oversize.code === 'SIZE_LIMIT_EXCEEDED',
    range: overrange.code === 'RANGE_LIMIT_EXCEEDED',
    one_shot: oneShotFirst.valid === true && oneShotSecond.code === 'ONE_SHOT_CONSUMED',
    revocation: revoked.code === 'HANDLE_REVOKED',
  };

  const checkpoint = await core.request({ type: 'checkpoint' });
  surfaces = new SurfaceManager({ root: spikeRoot, core });
  const appUi = await surfaces.create('app_ui');
  const diagram = await surfaces.create('diagram_editor');
  const preview = await surfaces.create('artifact_preview');
  const coldStartMs = performance.now() - processStartedAt;
  sampleMainMemory('three-surfaces-ready');
  const surfaceResults = [];
  for (const surface of [appUi, diagram, preview]) surfaceResults.push(await surfaces.exercise(surface));
  const ipcAttackResult = await surfaces.exerciseIpcAttacks({ appUi, diagram });
  const ipcForgery = ipcAttackResult.summary;
  const crossSurfaceStorageLeaks = surfaceResults.filter((surface) => (
    surface.initial_domain_state !== null ||
    surface.current_domain_state !== surface.identity ||
    (surface.initial_cookie && !surface.initial_cookie.includes(encodeURIComponent(surface.identity)))
  )).length;

  const rendererRecoveryStartedAt = performance.now();
  const rendererSnapshotBefore = await appUi.webContents.executeJavaScript('window.superwagie.snapshot()');
  const destroyedAppUi = await surfaces.destroy('app_ui');
  const recreatedAppUi = await surfaces.create('app_ui');
  const recreatedProbe = await recreatedAppUi.webContents.executeJavaScript('window.__surfaceProbe()');
  const rendererSnapshotAfter = await recreatedAppUi.webContents.executeJavaScript('window.superwagie.snapshot()');
  const resync = await core.request({ type: 'resync' });
  const rendererRecoveryMs = performance.now() - rendererRecoveryStartedAt;

  const appUiAliveBeforeWorkerCrash = !recreatedAppUi.webContents.isDestroyed();
  const run1 = await runWorkerJob({ spikeRoot, runRoot, name: 'determinism-1' });
  if (run1.execution.code !== 0) throw new Error(`render run 1 failed: ${run1.execution.stderr}`);
  const render1 = JSON.parse(await readFile(run1.resultPath, 'utf8'));
  const run2 = await runWorkerJob({ spikeRoot, runRoot, name: 'determinism-2' });
  if (run2.execution.code !== 0) throw new Error(`render run 2 failed: ${run2.execution.stderr}`);
  const render2 = JSON.parse(await readFile(run2.resultPath, 'utf8'));
  const crash = await runWorkerJob({
    spikeRoot, runRoot, name: 'crash-recovery', crashAfterFrames: 1, crashMode: 'sigkill',
  });
  if (crash.crashExecution?.signal !== 'SIGKILL') throw new Error(`render crash injection did not isolate: ${JSON.stringify(crash)}`);
  const recoveredExecution = crash.execution;
  if (recoveredExecution.code !== 0) throw new Error(`render recovery failed: ${recoveredExecution.stderr}`);
  const renderRecovered = JSON.parse(await readFile(crash.resultPath, 'utf8'));
  const exhausted = await runWorkerJob({
    spikeRoot, runRoot, name: 'recovery-budget-exhausted', crashAfterFrames: 1,
    crashMode: 'exit1', crashEveryAttempt: true, maxRestarts: 1,
  });
  if (!exhausted.restartBudgetExhausted || exhausted.executions.length !== 2) throw new Error('worker restart budget was not enforced');
  const spawnRecovery = await runWorkerJob({
    spikeRoot, runRoot, name: 'spawn-error-recovery', spawnFailureAttempts: 1, maxRestarts: 1,
  });
  if (!spawnRecovery.spawnErrorReconciled) throw new Error('worker spawn error did not enter reconcile');
  const hungRecovery = await runWorkerJob({
    spikeRoot, runRoot, name: 'hung-timeout-recovery', crashAfterFrames: 1,
    crashMode: 'hang', workerTimeoutMs: 5_000, maxRestarts: 1,
  });
  if (!hungRecovery.hungTimeoutRecovered) throw new Error(`hung worker timeout did not enter reconcile: ${JSON.stringify(hungRecovery)}`);
  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelled = await runWorkerJob({
    spikeRoot, runRoot, name: 'cancelled-job', cancellationSignal: cancelledController.signal, maxRestarts: 1,
  });
  if (!cancelled.cancelShutdownNotRetried) throw new Error('cancelled worker job must not restart');
  const postCrashTamper = await runWorkerJob({
    spikeRoot, runRoot, name: 'post-crash-checkpoint-tamper', crashAfterFrames: 1,
    crashMode: 'sigkill', maxRestarts: 1, tamperCheckpointAfterCrash: true,
  });
  if (postCrashTamper.executions[1]?.code !== 1 || !postCrashTamper.executions[1]?.stderr.includes('CHECKPOINT_ROOT_MISMATCH')) {
    throw new Error('post-crash checkpoint replacement was trusted');
  }
  const appUiAliveAfterWorkerCrash = !recreatedAppUi.webContents.isDestroyed();
  sampleMainMemory('render-jobs-complete');

  const coreRecoveryStartedAt = performance.now();
  const killedCorePid = core.child.pid;
  core.child.kill('SIGKILL');
  while (!core.history.some((event) => event.state === 'disconnected' && event.pid === killedCorePid)) await pause(10);
  await core.waitForState('ready');
  const coreDisconnectedObserved = core.history.some((event) => event.state === 'disconnected' && event.pid === killedCorePid);
  const snapshotAfterCoreRestart = await core.request({ type: 'query', query_id: 'shell.snapshot', after_cursor: null });
  const oldHandleRejectedAfterRestart = await core.request({
    type: 'verify_handle', signed_handle: handle.signed_handle,
    audience: 'artifact_preview:surface-3', operation: 'read', revision: 1,
    offset: 0, length: 1,
  });
  const coreRecoveryMs = performance.now() - coreRecoveryStartedAt;
  sampleMainMemory('core-restarted');
  const uiStatusAfterRecovery = await recreatedAppUi.webContents.executeJavaScript('window.__coreStatusHistory');

  const parentProbePath = join(runRoot, 'parent-death.json');
  const cleanEnvironment = { LANG: 'C', LC_ALL: 'C' };
  const parentProbe = await spawnAndWait(process.execPath, [
    join(spikeRoot, 'src', 'parent-death-probe.mjs'), '--core', coreBinary, '--output', parentProbePath,
  ], { cwd: spikeRoot, env: cleanEnvironment });
  if (parentProbe.code !== 0) throw new Error(`parent-death probe failed: ${parentProbe.stderr}`);
  const parentProbeResult = JSON.parse(await readFile(parentProbePath, 'utf8'));
  const parentDeathSafeExit = await waitUntilGone(parentProbeResult.corePid);

  const secondCorePid = core.child.pid;
  core.child.kill('SIGKILL');
  await core.waitForState('degraded_read_only');
  const uiStatusAfterSecondCrash = await recreatedAppUi.webContents.executeJavaScript('window.__coreStatusHistory');

  const appMetrics = app.getAppMetrics();
  const totalWorkingSetKb = appMetrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0);
  sampleMainMemory('final-observation');
  const peakObservedMainRssBytes = Math.max(...memorySamples.map((sample) => sample.main_rss_bytes));
  const peakObservedWorkerRssBytes = Math.max(
    render1.hostMainRssBytes,
    render2.hostMainRssBytes,
    renderRecovered.hostMainRssBytes,
  );
  const peakObservedWorkerProcessTreeRssBytes = Math.max(
    render1.processTreeRssBytes, render2.processTreeRssBytes, renderRecovered.processTreeRssBytes,
  );
  const allFrameHashes = [...render1.hashes, ...render2.hashes, ...renderRecovered.hashes];
  const processRecords = {
    rust_core: core.clients.map((client) => ({
      pid: client.child.pid, parent_pid: process.pid,
      command: '<candidate>/core/target/release/solution-b-core', arguments: [],
      exit_code: client.child.exitCode, signal: client.child.signalCode,
      requests: client.rawRequestLines.join('\n'), stdout: client.rawStdoutLines.join('\n'), stderr: client.stderr,
    })),
    render_workers: [run1, run2, crash, exhausted].flatMap((job) => job.executions.map((execution, index) => ({
      job_id: job === run1 ? 'determinism-1' : job === run2 ? 'determinism-2' : job === crash ? 'crash-recovery' : 'recovery-budget-exhausted',
      attempt: index + 1, pid: execution.pid, parent_pid: process.pid,
      command: '<candidate>/Electron.app/Contents/MacOS/Electron',
      arguments: ['<candidate>/src/render-worker-host.mjs', '--job-file', 'execution-manifest.json'],
      exit_code: execution.code, signal: execution.signal, stdout: execution.stdout, stderr: execution.stderr,
    }))),
  };
  const result = {
    identity: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      rust_protocol: firstHello.protocol,
    },
    core: {
      actual_binary: (await stat(coreBinary)).isFile(),
      binary_path: '<candidate>/core/target/release/solution-b-core',
      initial_pid: firstCorePid,
      current_pid: secondCorePid,
      handshake: firstHello.identity === 'solution-b-rust-core',
      authenticated_envelopes: Boolean(firstHello.mac && core.identity.mac),
      heartbeat: heartbeat.type === 'heartbeat_ack',
      query_snapshot: initialSnapshot.type === 'query_snapshot',
      resource_handle: Object.values(handleChecks).every(Boolean),
      handle_checks: handleChecks,
      safe_checkpoint: checkpoint.safe === true,
      checkpoint_key_fd_custody: core.checkpointKeyCustody.kind === 'unlinked-fd',
      old_handle_invalidated_on_restart: oldHandleRejectedAfterRestart.code === 'HANDLE_FORGED',
    },
    surfaces: surfaceResults,
    isolation: {
      cross_surface_storage_leaks: crossSurfaceStorageLeaks,
      destroyed_surface_storage_leaks: recreatedProbe.initialDomainState === null && recreatedProbe.initialCookie === '' ? 0 : 1,
      handle_transfer_rejected: handleChecks.audience,
      forged_handle_rejected: handleChecks.forged,
      ipc_forgery: ipcForgery,
      ipc_attack_records: ipcAttackResult.records,
      ipc_core_query_counts: { before: ipcAttackResult.core_query_count_before, after: ipcAttackResult.core_query_count_after },
      explicitly_destroyed: destroyedAppUi.destroyed,
    },
    recovery: {
      renderer_snapshot_resync:
        rendererSnapshotBefore.snapshot_revision === rendererSnapshotAfter.snapshot_revision &&
        rendererSnapshotAfter.event_cursor === 'cursor-1' && resync.type === 'resync_required',
      worker_job_only: appUiAliveBeforeWorkerCrash && appUiAliveAfterWorkerCrash && renderRecovered.framesRenderedThisAttempt === 2,
      worker_unexpected_exit_recovered: crash.recoveredFromUnexpectedExit && crash.restartCount === 1,
      worker_restart_budget_exhausted: exhausted.restartBudgetExhausted && exhausted.restartCount === 1,
      worker_spawn_error_reconciled: spawnRecovery.spawnErrorReconciled && spawnRecovery.restartCount === 1,
      worker_hung_timeout_recovered: hungRecovery.hungTimeoutRecovered && hungRecovery.restartCount === 1,
      worker_cancel_shutdown_not_retried: cancelled.cancelShutdownNotRetried,
      worker_post_crash_checkpoint_tamper_rejected: postCrashTamper.executions[1]?.stderr.includes('CHECKPOINT_ROOT_MISMATCH'),
      worker_reconcile_records: {
        spawn_error: spawnRecovery.executions.map(({ kind, code, signal, pid }) => ({ kind, code, signal, pid: pid ?? null })),
        hung_timeout: hungRecovery.executions.map(({ kind, code, signal, pid }) => ({ kind, code, signal, pid: pid ?? null })),
        cancelled: cancelled.executions.map(({ kind, code, signal, pid }) => ({ kind, code, signal, pid: pid ?? null })),
        post_crash_tamper: postCrashTamper.executions.map(({ kind, code, signal, pid, stderr }) => ({
          kind, code, signal, pid: pid ?? null, checkpoint_root_mismatch: stderr.includes('CHECKPOINT_ROOT_MISMATCH'),
        })),
      },
      core_disconnected_observed: coreDisconnectedObserved,
      core_restart_count: core.restartCount,
      core_snapshot_restored: snapshotAfterCoreRestart.snapshot_revision === 1 && snapshotAfterCoreRestart.event_cursor === 'cursor-1',
      second_core_crash_degraded_read_only: core.state === 'degraded_read_only' && core.restartCount === 1,
      ui_disconnected_then_resynced: uiStatusAfterRecovery.includes('disconnected') && uiStatusAfterRecovery.includes('resynced')
        && uiStatusAfterSecondCrash.at(-1) === 'degraded_read_only',
      parent_death_safe_exit: parentDeathSafeExit,
    },
    render_worker: {
      independent_electron_host: render1.parentPid === process.pid && render1.hostPid !== process.pid,
      host_pid: render1.hostPid,
      recovered_host_pid: renderRecovered.hostPid,
      frame_indices: render1.frameIndices,
      hashes_run_1: render1.hashes,
      hashes_run_2: render2.hashes,
      hashes_after_crash_recovery: renderRecovered.hashes,
      absolute_frame_driven: render1.absoluteFrameDriven && render2.absoluteFrameDriven && renderRecovered.absoluteFrameDriven,
      signed_composition_verified: render1.signedCompositionVerified && render2.signedCompositionVerified && renderRecovered.signedCompositionVerified,
      execution_manifest_verified: render1.executionManifestVerified && render2.executionManifestVerified && renderRecovered.executionManifestVerified,
      checkpoint_pngs_recomputed: renderRecovered.checkpointPngsRecomputed,
      checkpoint_pngs_decoded: renderRecovered.checkpointPngsDecoded,
      checkpoint_root_verified: renderRecovered.checkpointRootVerified,
      checkpoint_root_source: crash.checkpointRootSource,
      post_crash_checkpoint_rehashes: crash.postCrashCheckpointRehashes,
      authenticated_progress_receipt_verified: crash.authenticatedProgressReceiptVerified,
      environment_from_empty_whitelist: render1.environmentFromEmptyWhitelist && render2.environmentFromEmptyWhitelist && renderRecovered.environmentFromEmptyWhitelist,
      host_secret_canary_visible: render1.hostSecretCanaryVisible || render2.hostSecretCanaryVisible || renderRecovered.hostSecretCanaryVisible,
      ephemeral_partitions: [render1.partition, render2.partition, renderRecovered.partition],
      remote_request_count: render1.allowedRemoteRequests + render2.allowedRemoteRequests + renderRecovered.allowedRemoteRequests,
      blocked_remote_requests: render1.blockedRemoteRequests + render2.blockedRemoteRequests + renderRecovered.blockedRemoteRequests,
      all_scheme_network_attempts: render1.allSchemeNetworkAttempts + render2.allSchemeNetworkAttempts + renderRecovered.allSchemeNetworkAttempts,
    },
    processes: {
      electron_main_pid: process.pid,
      rust_core_pids: [firstCorePid, core.child.pid],
      render_host_pids: [render1.hostPid, render2.hostPid, renderRecovered.hostPid],
      parent_death_probe_core_pid: parentProbeResult.corePid,
      app_metrics: appMetrics.map(({ pid, type, memory }) => ({ pid, type, working_set_kb: memory?.workingSetSize ?? null })),
      records: processRecords,
    },
    core_state_history: core.history,
    metrics: {
      cold_start_ms: coldStartMs,
      idle_main_memory_rss_bytes: idleMemory.main_rss_bytes,
      peak_observed_main_memory_rss_bytes: peakObservedMainRssBytes,
      peak_observed_worker_memory_rss_bytes: peakObservedWorkerRssBytes,
      peak_observed_worker_process_tree_rss_bytes: peakObservedWorkerProcessTreeRssBytes,
      worker_process_tree_types: [...new Set([...render1.processTreeTypes, ...render2.processTreeTypes, ...renderRecovered.processTreeTypes])].sort(),
      memory_samples: memorySamples,
      observed_process_working_set_kb: totalWorkingSetKb,
      surface_count: 3,
      frame_throughput_fps: Math.min(render1.frameThroughputFps, render2.frameThroughputFps, renderRecovered.frameThroughputFps),
      worker_resume_render_loop_ms: renderRecovered.elapsedMs,
      worker_crash_observed_to_ready_ms: crash.crashObservedToReadyMs,
      renderer_destroy_to_resynced_ready_ms: rendererRecoveryMs,
      core_crash_observed_to_ready_ms: coreRecoveryMs,
      output_sha256_count: new Set(allFrameHashes).size,
      surface_remote_requests_allowed: surfaceResults.reduce((sum, surface) => sum + surface.remote_request_count, 0),
      surface_remote_requests_blocked: surfaceResults.reduce((sum, surface) => sum + surface.blocked_remote_requests, 0),
      worker_all_scheme_requests_observed: render1.allSchemeNetworkAttempts + render2.allSchemeNetworkAttempts + renderRecovered.allSchemeNetworkAttempts,
      worker_remote_requests_allowed: render1.allowedRemoteRequests + render2.allowedRemoteRequests + renderRecovered.allowedRemoteRequests,
      worker_remote_requests_blocked: render1.blockedRemoteRequests + render2.blockedRemoteRequests + renderRecovered.blockedRemoteRequests,
    },
    scope: {
      evidence_version: 'solution-b-v1',
      platform: 'macos-15-arm64',
      fixture: 'G0-SHELL-002-MACOS-SPIKE',
      parent_fixture: 'G0-SHELL-002',
      admission_effect: 'none',
      signed: false,
      run_nonce: evidenceRunNonce,
    },
  };

  await atomicJson(outputPath, result);
  process.stdout.write(`${JSON.stringify({ event: 'solution-b-actual-run-complete', run_nonce: evidenceRunNonce, pass: true })}\n`);
  await surfaces.closeAll();
  await core.shutdown();
}

app.whenReady().then(async () => {
  if (process.arch !== 'arm64' || process.platform !== 'darwin') throw new Error('this disposable evidence run only declares macos-15-arm64');
  if (process.versions.electron !== '44.1.0') throw new Error(`Electron identity mismatch: ${process.versions.electron}`);
  if (process.versions.chrome !== '152.0.7977.65') throw new Error(`Chromium identity mismatch: ${process.versions.chrome}`);
  if (process.versions.node !== '24.19.0') throw new Error(`Node identity mismatch: ${process.versions.node}`);
  await runSelfTest();
  app.quit();
}).catch((error) => {
  console.error(error.stack ?? error);
  app.exit(1);
});
