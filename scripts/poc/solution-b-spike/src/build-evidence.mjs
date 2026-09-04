#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { joinRuntimePath, runtimePlatform } from './runtime-platform.mjs';

const args = process.argv.slice(2);
if (args.includes('--result') || args.includes('--run-root') || args.includes('--core-binary')) throw new Error('external result input is forbidden');
const known = new Set(['--output-parent', '--electron-archive']);
for (let i = 0; i < args.length; i += 2) if (!known.has(args[i]) || !args[i + 1]) throw new Error(`unknown argument: ${args[i] ?? '<missing>'}`);
const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const required = (flag) => { const value = valueAfter(flag); if (!value) throw new Error(`${flag} is required`); return resolve(value); };
const outputParent = required('--output-parent');
const electronArchive = required('--electron-archive');
const spikeRoot = resolve(import.meta.dirname, '..');
const platform = runtimePlatform();
let secureAtomicWrite;
let secureCopyByFd;
let secureMkdirs;
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const relativeUnix = (root, path) => relative(root, path).split('\\').join('/');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function writeJson(root, path, value) { secureAtomicWrite(root, path, jsonBytes(value)); }
function writeText(root, path, value) { secureAtomicWrite(root, path, Buffer.from(value)); }

function syncDirectoryPath(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
  } finally { closeSync(fd); }
}

async function renameCommittedDirectory(source, destination) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { renameSync(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
}

function walk(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const metadata = lstatSync(absolute);
      entries.push({ absolute, metadata });
      if (metadata.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return entries;
}

function treeHash(root, target) {
  const metadata = lstatSync(target);
  if (metadata.isFile()) return sha256(readFileSync(target));
  const records = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const item = lstatSync(absolute);
      const path = relativeUnix(target, absolute);
      if (item.isDirectory()) visit(absolute);
      else if (item.isSymbolicLink()) records.push(`L\0${path}\0${readlinkSync(absolute)}\n`);
      else if (item.isFile()) records.push(`F\0${path}\0${sha256(readFileSync(absolute))}\n`);
      else throw new Error(`non-regular runtime entry: ${path}`);
    }
  };
  visit(target);
  return sha256(records.join(''));
}

function copyTree(sourceRoot, sourceRelative, destinationRoot, destinationRelative) {
  secureMkdirs(destinationRoot, destinationRelative);
  const source = join(sourceRoot, sourceRelative);
  for (const { absolute, metadata } of walk(source)) {
    const tail = relative(source, absolute);
    if (metadata.isSymbolicLink()) throw new Error(`source symlink forbidden: ${join(sourceRelative, tail)}`);
    const destination = join(destinationRelative, tail);
    if (metadata.isDirectory()) secureMkdirs(destinationRoot, destination);
    else if (metadata.isFile()) secureCopyByFd(sourceRoot, join(sourceRelative, tail), destinationRoot, destination);
    else throw new Error('regular source tree required');
  }
}

function run(command, parameters, options) {
  const result = spawnSync(command, parameters, { encoding: 'utf8', ...options });
  return { command, parameters, status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
}

function processSnapshot(rootPid) {
  let rows;
  if (process.platform === 'win32') {
    const powershell = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = 'Get-CimInstance Win32_Process -ErrorAction Stop|Select-Object ProcessId,ParentProcessId,Name|ConvertTo-Json -Compress';
    const output = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    if (output.status !== 0) throw new Error('Windows process snapshot unavailable');
    const parsed = JSON.parse(output.stdout);
    rows = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: Number(entry.ProcessId), ppid: Number(entry.ParentProcessId), executable: String(entry.Name),
    }));
  } else {
    const output = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', env: { LANG: 'C', LC_ALL: 'C' } }).stdout ?? '';
    rows = output.split('\n').map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), executable: basename(match[3].trim()) }));
  }
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  }
  return rows.filter(({ pid }) => descendants.has(pid));
}

function runWithProcessSamples(command, parameters, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, parameters, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const samples = [];
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    const timer = setInterval(() => samples.push({ observed_at_ms: Date.now(), processes: processSnapshot(child.pid) }), process.platform === 'win32' ? 1_000 : 50);
    child.on('exit', (status, signal) => {
      clearInterval(timer);
      samples.push({ observed_at_ms: Date.now(), processes: processSnapshot(child.pid) });
      resolvePromise({ command, parameters, status, signal, stdout, stderr, error: null, pid: child.pid, samples });
    });
  });
}

function pngInfo(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('PNG_SIGNATURE_INVALID');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: sha256(bytes), bytes: bytes.length };
}

function sanitizeCommand(value) {
  return value.replaceAll(spikeRoot, '<repo>/scripts/poc/solution-b-spike').replaceAll(electronArchive, `<cache>/${platform.archive}`);
}

async function main() {
  // Build both ABI variants before loading the Node variant. Windows locks a
  // loaded native module, so rebuilding after the import cannot replace it.
  const nativeBuild = run(process.execPath, [join(spikeRoot, 'src', 'build-secure-fs-native.mjs')], { cwd: spikeRoot, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
  if (nativeBuild.status !== 0) throw new Error(`secure filesystem primitive build failed: ${nativeBuild.stderr}`);
  ({ secureAtomicWrite, secureCopyByFd, secureMkdirs } = await import('./secure-files.mjs'));

  const startedAt = new Date().toISOString();
  mkdirSync(outputParent, { recursive: true, mode: 0o700 });
  const suffix = randomBytes(6).toString('hex');
  const staging = join(outputParent, `.solution-b-v1-stage-${suffix}`);
  const finalRoot = join(outputParent, `solution-b-v1-${suffix}`);
  mkdirSync(staging, { mode: 0o700 });
  secureMkdirs(staging, 'candidate-root');
  secureMkdirs(staging, 'artifacts/frames');
  secureMkdirs(staging, 'raw-run');
  secureMkdirs(staging, 'main-home');
  const candidate = join(staging, 'candidate-root');

  const archiveName = platform.archive;
  const checksums = JSON.parse(readFileSync(join(spikeRoot, 'node_modules', 'electron', 'checksums.json'), 'utf8'));
  const expectedArchiveHash = `sha256:${checksums[archiveName]}`;
  if (basename(electronArchive) !== archiveName || sha256(readFileSync(electronArchive)) !== expectedArchiveHash) throw new Error('locked Electron archive identity mismatch');

  const cargo = run('cargo', ['build', '--release', '--locked', '--offline', '--quiet'], { cwd: join(spikeRoot, 'core'),
    env: { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} --remap-path-prefix=${process.env.HOME ?? process.env.USERPROFILE}=<home> --remap-path-prefix=${spikeRoot}=<repo>`.trim() } });
  writeJson(staging, 'cargo-build.json', { command: ['cargo', 'build', '--release', '--locked', '--offline', '--quiet'], exit_code: cargo.status, signal: cargo.signal });
  writeText(staging, 'cargo-stdout.log', cargo.stdout);
  writeText(staging, 'cargo-stderr.log', cargo.stderr);
  if (cargo.status !== 0) throw new Error(`locked offline core build failed: ${cargo.stderr}`);
  secureMkdirs(candidate, platform.candidateElectronRoot);
  const extraction = process.platform === 'win32'
    ? run(join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', electronArchive, '-C', join(candidate, platform.candidateElectronRoot)], { env: process.env })
    : run('/usr/bin/ditto', ['-x', '-k', electronArchive, candidate], { env: { LANG: 'C', LC_ALL: 'C' } });
  if (extraction.status !== 0) throw new Error(`Electron extraction failed: ${extraction.stderr}`);
  const electronExecutable = join(candidate, ...platform.candidateElectron.split('/'));
  if (!statSync(electronExecutable).isFile()) throw new Error('candidate Electron executable missing');

  const sourceFiles = ['electron-main.mjs', 'core-client.mjs', 'core-supervisor.mjs', 'surface-manager.mjs',
    'surface-preload.cjs', 'parent-death-probe.mjs', 'render-worker-host.mjs', 'secure-files.mjs', 'runtime-platform.mjs',
    'extension-worker-host.mjs', 'extension-worker-policy.mjs', 'extension-worker-preload.cjs'];
  secureMkdirs(candidate, 'src');
  for (const name of sourceFiles) secureCopyByFd(spikeRoot, join('src', name), candidate, join('src', name));
  secureCopyByFd(resolve(spikeRoot, '..', 'solution-b-task7'), join('src', 'review-render-worker.mjs'), candidate, join('src', 'review-render-worker.mjs'));
  secureMkdirs(candidate, join('src', 'native'));
  const nativeAddons = process.platform === 'win32'
    ? ['secure-fs-native-node.node', 'secure-fs-native-electron.node']
    : ['secure-fs-native.node'];
  for (const name of nativeAddons) secureCopyByFd(spikeRoot, join('src', 'native', name), candidate, join('src', 'native', name));
  copyTree(spikeRoot, join('src', 'static'), candidate, join('src', 'static'));
  secureMkdirs(candidate, join('core', 'target', 'release'));
  const coreReleaseRelative = platform.coreRelease.join('/');
  secureCopyByFd(spikeRoot, platform.coreRelease.join('/'), candidate, coreReleaseRelative);
  if (process.platform !== 'win32') chmodSync(joinRuntimePath(candidate, platform.coreRelease), 0o755);
  secureMkdirs(candidate, 'locks');
  secureCopyByFd(spikeRoot, 'package-lock.json', candidate, join('locks', 'package-lock.json'));
  secureCopyByFd(spikeRoot, join('core', 'Cargo.lock'), candidate, join('locks', 'Cargo.lock'));

  const entries = [
    ['runtime.electron', platform.candidateElectronRoot], ['runtime.app-shell', 'src'],
    ['runtime.rust-core', coreReleaseRelative], ['runtime.locks', 'locks'],
  ].map(([id, path]) => ({ id, relative_path: path, sha256: treeHash(candidate, join(candidate, path)) }));
  const runtimeManifest = {
    manifest_version: 'solution-b-v1', fixture: platform.fixture, platform: platform.id,
    signed: false, complete_spike_runtime: true, complete_product_runtime: false,
    offline_launch_verified: false, node_modules_dependency: false, system_chrome_dependency: false,
    first_use_download_allowed: false, codex_desktop_dependency: false, tauri_dependency: false,
    launch: { executable: platform.candidateElectron, arguments: ['src/electron-main.mjs', '--self-test', '--output', '<run>/actual-electron-result.json'], core_resolver: coreReleaseRelative },
    electron_archive_sha256: expectedArchiveHash, entries,
  };
  writeJson(candidate, 'runtime-manifest.json', runtimeManifest);

  const runNonce = randomBytes(16).toString('hex');
  const rawResult = join(staging, 'raw-run', 'actual-electron-result.json');
  const environmentOverrides = { LANG: 'C', LC_ALL: 'C',
    SUPERWAGIE_RUN_ROOT: join(staging, 'raw-run'),
    SUPERWAGIE_EVIDENCE_RUN_NONCE: runNonce, SUPERWAGIE_OFFLINE: '1',
    SUPERWAGIE_ENV_CANARY: process.env.SUPERWAGIE_ENV_CANARY ?? 'evidence-worker-canary' };
  if (process.platform !== 'win32') {
    environmentOverrides.HOME = join(staging, 'main-home');
    environmentOverrides.TMPDIR = join(staging, 'raw-run');
  }
  const electronRun = await runWithProcessSamples(electronExecutable, [join(candidate, 'src', 'electron-main.mjs'), '--self-test', '--output', rawResult], {
    cwd: candidate,
    timeout: 150_000,
    env: { ...process.env, ...environmentOverrides },
  });
  writeText(staging, 'process-stdout.log', electronRun.stdout);
  writeText(staging, 'process-stderr.log', electronRun.stderr);
  writeJson(staging, 'command.json', {
    command: `<candidate>/${platform.candidateElectron}`,
    arguments: ['<candidate>/src/electron-main.mjs', '--self-test', '--output', '<run>/actual-electron-result.json'],
    cwd: '<candidate>', environment_policy: 'trusted_main_inherits_host; untrusted_workers_use_platform_allowlist',
    environment_overrides: Object.keys(environmentOverrides).sort(),
  });
  if (electronRun.status !== 0) throw new Error(`actual candidate run failed (status=${electronRun.status}, signal=${electronRun.signal}): ${electronRun.stderr}`);
  writeJson(staging, 'raw-run/os-process-samples.json', { root_pid: electronRun.pid, samples: electronRun.samples });
  const actual = JSON.parse(readFileSync(rawResult, 'utf8'));

  const frameRoot = join(staging, 'raw-run', 'render-jobs', 'determinism-1', 'outputs', 'frames');
  const frameInfos = [];
  for (const frameIndex of [0, 1, 2]) {
    const name = `frame-${String(frameIndex).padStart(4, '0')}.png`;
    const bytes = readFileSync(join(frameRoot, name));
    const info = { frame_index: frameIndex, ...pngInfo(bytes) };
    if (info.width !== 96 || info.height !== 64 || info.sha256 !== `sha256:${actual.render_worker.hashes_run_1[frameIndex]}`) throw new Error('render PNG recomputation mismatch');
    secureCopyByFd(frameRoot, name, staging, join('artifacts', 'frames', name));
    frameInfos.push(info);
  }
  const workerResults = ['determinism-1', 'determinism-2', 'crash-recovery'].map((name) => JSON.parse(readFileSync(join(staging, 'raw-run', 'render-jobs', name, 'outputs', 'result.json'), 'utf8')));
  const recoveryFrameInfos = [0, 1, 2].map((frameIndex) => {
    const bytes = readFileSync(join(staging, 'raw-run', 'render-jobs', 'crash-recovery', 'outputs', 'frames', `frame-${String(frameIndex).padStart(4, '0')}.png`));
    return { frame_index: frameIndex, ...pngInfo(bytes) };
  });
  const processRelations = {
    electron_main_pid: actual.processes.electron_main_pid,
    rust_core_pids: actual.processes.rust_core_pids,
    render_workers: workerResults.map(({ hostPid, parentPid, processTreeTypes }) => ({ host_pid: hostPid, parent_pid: parentPid, parent_is_electron_main: parentPid === actual.processes.electron_main_pid, process_tree_types: processTreeTypes })),
  };
  const parseLines = (text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const protocolRecords = actual.processes.records.rust_core.map((record) => ({
    pid: record.pid, requests: parseLines(record.requests), responses: parseLines(record.stdout), exit_code: record.exit_code, signal: record.signal,
  }));
  const protocolDerived = protocolRecords.every((record) => {
    const hello = record.requests[0];
    const helloAck = record.responses[0];
    const authenticatedRequests = record.requests.slice(1);
    const authenticatedResponses = record.responses.slice(1);
    return hello?.type === 'hello' && hello?.protocol === 'solution-b-v1'
      && helloAck?.type === 'hello_ack' && helloAck?.identity === 'solution-b-rust-core'
      && helloAck?.request_id === hello.request_id && /^[a-f0-9]{64}$/.test(helloAck?.mac ?? '')
      && authenticatedRequests.length > 0 && authenticatedResponses.length > 0
      && authenticatedRequests.every((request) => request.type === 'request' && /^[a-f0-9]{64}$/.test(request.mac ?? ''))
      && authenticatedResponses.every((response) => response.type === 'response' && /^[a-f0-9]{64}$/.test(response.mac ?? '')
        && authenticatedRequests.some((request) => request.request_id === response.request_id && request.sequence === response.sequence));
  });
  const surfacesDerived = actual.surfaces.length === 3 && actual.surfaces.every((surface) => {
    const raw = surface.raw_observations;
    return surface.ephemeral && raw?.probe?.hasNodeProcess === false && raw?.probe?.hasRequire === false
      && raw?.probe?.hasRawIpc === false && raw?.counters?.allowedRemoteRequests === 0
      && raw?.counters?.navigationDenied > 0 && raw?.counters?.windowOpenDenied > 0
      && raw?.permission_state === 'denied' && raw?.counters?.downloadDenied > 0
      && raw?.window_open_result === true && raw?.remote_fetch_result === 'blocked'
      && Object.values(surface.web_preferences).every(Boolean) === false
      && surface.web_preferences.sandbox === true && surface.web_preferences.contextIsolation === true
      && surface.web_preferences.nodeIntegration === false && surface.web_preferences.webSecurity === true;
  });
  const ipcDerived = actual.isolation.ipc_attack_records.every(({ response, expected_code }) => response?.__rejected === true && response.code === expected_code)
    && actual.isolation.ipc_core_query_counts.before === actual.isolation.ipc_core_query_counts.after;
  const states = actual.core_state_history.map(({ state }) => state);
  const coreRecoveryDerived = states.filter((state) => state === 'disconnected').length === 2
    && states.includes('restarting') && states.includes('resynced') && states.at(-1) === 'degraded_read_only';
  const renderRecords = actual.processes.records.render_workers;
  const reconcileRecords = actual.recovery.worker_reconcile_records;
  const supervisorOutcomesDerived = reconcileRecords.spawn_error.length === 2
    && reconcileRecords.spawn_error[0].kind === 'spawn_error'
    && reconcileRecords.spawn_error[1].kind === 'exit' && reconcileRecords.spawn_error[1].code === 0
    && reconcileRecords.hung_timeout.length === 2
    && reconcileRecords.hung_timeout[0].kind === 'timeout' && reconcileRecords.hung_timeout[0].signal === 'SIGKILL'
    && reconcileRecords.hung_timeout[1].kind === 'exit' && reconcileRecords.hung_timeout[1].code === 0
    && reconcileRecords.cancelled.length === 1 && reconcileRecords.cancelled[0].kind === 'cancelled'
    && reconcileRecords.post_crash_tamper.length === 2
    && reconcileRecords.post_crash_tamper[0].signal === 'SIGKILL'
    && reconcileRecords.post_crash_tamper[1].checkpoint_root_mismatch === true;
  const workerRecoveryDerived = renderRecords.some((record) => record.job_id === 'crash-recovery' && record.signal === 'SIGKILL')
    && renderRecords.some((record) => record.job_id === 'crash-recovery' && record.attempt === 2 && record.exit_code === 0)
    && renderRecords.filter((record) => record.job_id === 'recovery-budget-exhausted').length === 2
    && renderRecords.filter((record) => record.job_id === 'recovery-budget-exhausted').every((record) => record.exit_code === 1)
    && supervisorOutcomesDerived
    && actual.render_worker.checkpoint_root_source === 'worker_authenticated_progress_receipt'
    && actual.render_worker.post_crash_checkpoint_rehashes === 0
    && actual.render_worker.authenticated_progress_receipt_verified;
  const recoveryPngsMatchClean = JSON.stringify(frameInfos.map(({ sha256: hash }) => hash))
    === JSON.stringify(recoveryFrameInfos.map(({ sha256: hash }) => hash));
  const rawWorkersDerived = workerResults.every((worker) => worker.executionManifestVerified && worker.environmentFromEmptyWhitelist
    && !worker.hostSecretCanaryVisible && worker.checkpointPngsDecoded && worker.checkpointRootVerified);
  const observedRows = electronRun.samples.flatMap(({ processes }) => processes);
  const osProcessDerived = observedRows.some(({ pid }) => pid === actual.processes.electron_main_pid)
    && actual.processes.records.rust_core.some((record) => observedRows.some(({ pid, ppid, executable }) => pid === record.pid && ppid === actual.processes.electron_main_pid && executable.toLowerCase() === platform.processNames.core.toLowerCase()))
    && renderRecords.some((record) => observedRows.some(({ pid, ppid, executable }) => pid === record.pid && ppid === actual.processes.electron_main_pid && executable.toLowerCase() === platform.processNames.electron.toLowerCase()));
  const checkpointSecretExcluded = actual.core.checkpoint_key_fd_custody === true
    && !walk(staging).some(({ absolute }) => basename(absolute).endsWith('.auth-key'));
  const checks = {
    runner_launched_actual_candidate: actual.identity.electron === '44.1.0' && actual.identity.chromium === '152.0.7977.65'
      && actual.scope.run_nonce === runNonce && electronRun.status === 0,
    no_external_pass_input: true,
    actual_authenticated_rust_core: protocolDerived,
    three_isolated_surfaces: surfacesDerived,
    ipc_forgery_rejected_without_core: ipcDerived,
    supervisor_recovery_and_degrade: coreRecoveryDerived && workerRecoveryDerived,
    execution_manifest_and_environment: rawWorkersDerived,
    deterministic_pngs_recomputed: JSON.stringify(workerResults[0].hashes) === JSON.stringify(workerResults[1].hashes) && frameInfos.length === 3,
    crash_recovery_pngs_match_clean: recoveryPngsMatchClean,
    process_relations_verified: processRelations.render_workers.every((item) => item.parent_is_electron_main)
      && actual.processes.records.rust_core.length === 2
      && actual.processes.records.rust_core.every((item) => item.parent_pid === actual.processes.electron_main_pid && item.command.startsWith('<candidate>/'))
      && actual.processes.records.render_workers.length === 6
      && actual.processes.records.render_workers.every((item) => item.parent_pid === actual.processes.electron_main_pid && item.command.startsWith('<candidate>/')),
    builder_derived_process_claims_from_raw_records: osProcessDerived,
    builder_derived_recovery_from_raw_records: coreRecoveryDerived && workerRecoveryDerived && recoveryPngsMatchClean,
    builder_derived_security_from_raw_records: protocolDerived && surfacesDerived && ipcDerived && rawWorkersDerived,
    checkpoint_secret_excluded_from_evidence_and_candidate: checkpointSecretExcluded,
    offline_no_remote_requests: actual.metrics.surface_remote_requests_allowed === 0
      && actual.metrics.worker_remote_requests_allowed === 0 && actual.render_worker.remote_request_count === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  if (!pass) throw new Error(`independent evidence checks failed: ${JSON.stringify(checks)}`);
  const derivationSources = {
    process_relations: ['raw-run/os-process-samples.json', 'raw-run/actual-electron-result.json#processes.records'],
    recovery: ['raw-run/actual-electron-result.json#core_state_history', 'raw worker exits', 'worker-authenticated pre-crash progress receipts', 'clean and recovery PNG bytes'],
    security: ['authenticated protocol request/response transcript', 'surface raw observations', 'IPC rejection codes', 'raw worker results'],
  };
  writeJson(staging, 'raw-attestation.json', { protocol_records: protocolRecords, surface_records: actual.surfaces.map(({ raw_observations, web_preferences, type, identity }) => ({ type, identity, web_preferences, raw_observations })),
    ipc_attack_records: actual.isolation.ipc_attack_records, core_state_history: actual.core_state_history,
    worker_results: workerResults, process_samples_file: 'raw-run/os-process-samples.json' });
  writeJson(staging, 'builder-derivation.json', { sources: derivationSources, derived: { protocolDerived, surfacesDerived, ipcDerived,
    coreRecoveryDerived, workerRecoveryDerived, recoveryPngsMatchClean, rawWorkersDerived, osProcessDerived } });

  runtimeManifest.offline_launch_verified = true;
  writeJson(candidate, 'runtime-manifest.json', runtimeManifest);
  writeJson(staging, 'actual-run.json', { run_nonce: runNonce, exit_code: electronRun.status,
    executable_sha256: sha256(readFileSync(electronExecutable)), core_binary_sha256: sha256(readFileSync(joinRuntimePath(candidate, platform.coreRelease))),
    process_relations: processRelations, child_process_records: actual.processes.records, builder_derived: checks,
    stdout_file: 'process-stdout.log', stderr_file: 'process-stderr.log' });
  writeJson(staging, 'environment.json', { platform: platform.id, source: '<repo>/scripts/poc/solution-b-spike',
    electron_archive: `<cache>/${platform.archive}`, electron_archive_sha256: expectedArchiveHash,
    offline: true, network_allowed_count: 0 });
  const results = { gate: 'gate-0-child-spike', fixture: platform.fixture, platform: platform.id, parent_fixture: 'G0-SHELL-002',
    evidence_revision: 'solution-b-v1', run_nonce: runNonce, pass, child_result: 'PASS', admission_effect: 'none',
    parent_gate_upgraded: false, production_fixture_registered: false, owner_signed: false, checks,
    derivation_sources: derivationSources,
    identities: actual.identity, process_relations: processRelations, frame_infos: frameInfos,
    metrics: actual.metrics, limitations: { complete_product_runtime: 'not_built', signing_notarization_installer: 'not_run',
      windows: process.platform === 'win32' ? 'child_spike_validated' : 'not_run', macos: process.platform === 'darwin' ? 'child_spike_validated' : 'not_run',
      manual_ime_clipboard_drag_drop_accessibility: 'not_run', owner_signature: 'not_present', parent_gate: 'unchanged_BLOCKED_ENVIRONMENT' } };
  writeJson(staging, 'results.json', results);
  writeText(staging, 'decision.md', `# Disposable ${platform.id} child evidence\n\nChild result: PASS. Admission effect: none. Parent G0-SHELL-002 remains BLOCKED_ENVIRONMENT; Production Implementation Admission remains NO_GO.\n`);

  const forbidden = ['/Users/neomei', '/var/folders/', '/tmp/', 'Library/Caches/electron',
    process.env.USERPROFILE, process.env.TEMP, 'AppData\\Local\\electron\\Cache',
    process.env.SUPERWAGIE_ENV_CANARY ?? 'evidence-worker-canary'].filter(Boolean);
  const privacyFindings = [];
  const electronRoot = join(candidate, platform.candidateElectronRoot);
  for (const { absolute, metadata } of walk(staging)) {
    if (absolute === electronRoot || absolute.startsWith(`${electronRoot}${sep}`)) continue;
    if (!metadata.isFile() || metadata.size > 5_000_000) continue;
    const text = readFileSync(absolute, 'utf8');
    for (const token of forbidden) if (text.includes(token)) privacyFindings.push({ path: relativeUnix(staging, absolute), token });
  }
  if (privacyFindings.length) throw new Error(`privacy scan rejected evidence: ${JSON.stringify(privacyFindings)}`);
  writeJson(staging, 'privacy-scan.json', { passed: true, scope: 'evidence metadata, logs, source, first-party binaries; locked upstream Electron bundle excluded',
    forbidden_patterns_checked: ['local_username', 'absolute_temp', 'electron_cache', 'environment_canary'], findings: [] });

  const artifactFiles = walk(staging).filter(({ absolute, metadata }) => metadata.isFile()
    && absolute !== electronRoot && !absolute.startsWith(`${electronRoot}${sep}`)
    && !['artifact-hashes.json', 'manifest.json'].includes(relativeUnix(staging, absolute)));
  writeJson(staging, 'artifact-hashes.json', { algorithm: 'sha256', files: Object.fromEntries(artifactFiles.map(({ absolute }) => [relativeUnix(staging, absolute), sha256(readFileSync(absolute))])) });
  writeJson(staging, 'manifest.json', { commit: true, gate: 'gate-0-child-spike', fixture: platform.fixture, platform: platform.id,
    parent_fixture: 'G0-SHELL-002', evidence_revision: 'solution-b-v1', run_nonce: runNonce,
    started_at: startedAt, finished_at: new Date().toISOString(), source_identity: '<repo>', candidate_root: 'candidate-root',
    admission_effect: 'none', owner_signed: false, parent_gate_upgraded: false,
    runtime_manifest_sha256: sha256(readFileSync(join(candidate, 'runtime-manifest.json'))),
    artifact_hash_index_sha256: sha256(readFileSync(join(staging, 'artifact-hashes.json'))) });
  syncDirectoryPath(staging);
  await renameCommittedDirectory(staging, finalRoot);
  syncDirectoryPath(outputParent);
  process.stdout.write(`${JSON.stringify({ evidence_root: finalRoot, candidate_root: join(finalRoot, 'candidate-root'), results_sha256: sha256(readFileSync(join(finalRoot, 'results.json'))), manifest_sha256: sha256(readFileSync(join(finalRoot, 'manifest.json'))) })}\n`);
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
