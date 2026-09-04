import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { runtimePlatform } from '../../solution-b-spike/src/runtime-platform.mjs';

const platform = runtimePlatform();
const platformLabel = process.platform === 'win32' ? 'WINDOWS' : 'MACOS';
export const task5Fixture = (base, suffix) => `${base}-${platformLabel}-${suffix}`;
export const EXPECTED_MANIFEST = process.platform === 'win32'
  ? 'df3087fad29b7b0cbe286edf5e1351f76ab0f5f0d3729573f2ec9c28cd294bff'
  : 'c3d0db24041780cd8bc4f7298eb145cb95e86f12d03919b32f31ad427eb1bc78';
const workerScript = join(import.meta.dirname, 'task5-worker.mjs');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => value === null ? 'null'
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);

export function secureRead(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`INPUT_NOT_REGULAR:${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error(`INPUT_IDENTITY_CHANGED:${path}`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) throw new Error(`INPUT_CHANGED_DURING_READ:${path}`);
    return bytes;
  } finally { closeSync(fd); }
}

function inside(root, path) {
  const a = resolve(root); const b = resolve(path);
  if (b !== a && !b.startsWith(`${a}${sep}`)) throw new Error(`PATH_ESCAPE:${path}`);
  return b;
}

function treeRecords(root) {
  const records = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        inside(root, resolve(dirname(path), target));
        records.push({ type: 'L', path: relative(root, path).split(sep).join('/'), target, size: stat.size });
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) records.push({ path: relative(root, path).split(sep).join('/'), sha256: sha256(secureRead(path)), size: stat.size });
      else throw new Error(`NON_REGULAR_FORBIDDEN:${path}`);
    }
  };
  visit(root); return records;
}

function hashTarget(candidateRoot, relativePath) {
  const path = inside(candidateRoot, join(candidateRoot, relativePath));
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`SYMLINK_FORBIDDEN:${relativePath}`);
  if (stat.isFile()) return sha256(secureRead(path));
  return sha256(treeRecords(path).map((item) => item.type === 'L'
    ? `L\0${item.path}\0${item.target}\n`
    : `F\0${item.path}\0sha256:${item.sha256}\n`).join(''));
}

function readManifest(candidateRoot) {
  const bytes = secureRead(join(candidateRoot, 'runtime-manifest.json'));
  const digest = sha256(bytes);
  if (digest !== EXPECTED_MANIFEST) throw new Error(`CANDIDATE_MANIFEST_MISMATCH:${digest}`);
  const manifest = JSON.parse(bytes);
  if (manifest.manifest_version !== 'solution-b-v1' || manifest.platform !== platform.id
    || manifest.signed !== false || manifest.complete_product_runtime !== false) throw new Error('CANDIDATE_SCOPE_MISMATCH');
  return { manifest, digest };
}

function verifyEntries(candidateRoot, manifest) {
  return manifest.entries.map((entry) => {
    if (entry.relative_path.includes('..') || entry.relative_path.startsWith('/')) throw new Error(`MANIFEST_PATH_REJECTED:${entry.relative_path}`);
    const actual = hashTarget(candidateRoot, entry.relative_path);
    if (`sha256:${actual}` !== entry.sha256) throw new Error(`RUNTIME_ENTRY_MISMATCH:${entry.id}`);
    return { ...entry, actual_sha256: `sha256:${actual}` };
  });
}

function spawnCapture(executable, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(executable, args, { ...spawnOptions, stdio: spawnOptions.stdio ?? ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timeout = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.once('error', reject);
    child.once('exit', (code, signal) => { if (timeout) clearTimeout(timeout); resolvePromise({ pid: child.pid, code, signal, stdout, stderr }); });
  });
}

function nextNonemptyLine(lines, child, timeoutMs = 20_000) {
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => { clearTimeout(timer); lines.off('line', onLine); child.off('exit', onExit); };
    const onLine = (line) => { if (!line.trim()) return; cleanup(); resolvePromise(line); };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`WORKER_EXITED_BEFORE_RECEIPT:code=${code}:signal=${signal}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('WORKER_RECEIPT_TIMEOUT')); }, timeoutMs);
    lines.on('line', onLine); child.once('exit', onExit);
  });
}

export async function validateCandidateClosure({ candidateRoot, workRoot, exerciseAttacks = true }) {
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const { manifest, digest } = readManifest(candidateRoot);
  const entries = verifyEntries(candidateRoot, manifest);
  const allFiles = treeRecords(candidateRoot);
  const renderHost = allFiles.find(({ path }) => path === 'src/render-worker-host.mjs');
  const staticResources = allFiles.filter(({ path }) => path.startsWith('src/static/') && !path.type);
  const fonts = allFiles.filter(({ path }) => /\.(ttf|otf|woff2?)$/i.test(path));
  if (!renderHost || staticResources.length === 0) throw new Error('RUNTIME_CLOSURE_INCOMPLETE');
  const attacks = { tamper_rejected: false, missing_rejected: false, path_fallback_rejected: false };
  if (exerciseAttacks) {
    const tamperRoot = join(workRoot, 'tamper-candidate');
    cpSync(candidateRoot, tamperRoot, { recursive: true, verbatimSymlinks: true });
    const tamperPath = join(tamperRoot, 'src', 'render-worker-host.mjs');
    writeFileSync(tamperPath, Buffer.concat([secureRead(tamperPath), Buffer.from('\n// task5 tamper\n')]));
    try { verifyEntries(tamperRoot, manifest); } catch (error) { attacks.tamper_rejected = /RUNTIME_ENTRY_MISMATCH/.test(error.message); }
    const missingRoot = join(workRoot, 'missing-candidate');
    cpSync(candidateRoot, missingRoot, { recursive: true, verbatimSymlinks: true });
    rmSync(join(missingRoot, ...manifest.launch.core_resolver.split('/')));
    try { verifyEntries(missingRoot, manifest); } catch (error) { attacks.missing_rejected = /RUNTIME_ENTRY_MISMATCH|ENOENT/.test(error.message); }
    const fakeBin = join(workRoot, 'path-pollution'); mkdirSync(fakeBin, { mode: 0o700 });
    const fakeCore = process.platform === 'win32' ? 'solution-b-core.exe' : 'solution-b-core';
    writeFileSync(join(fakeBin, fakeCore), process.platform === 'win32' ? 'not-a-real-core\n' : '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const output = join(workRoot, 'path-fallback-result.json');
    const run = await spawnCapture(join(missingRoot, manifest.launch.executable),
      [join(missingRoot, 'src', 'electron-main.mjs'), '--self-test', '--output', output], {
        cwd: missingRoot, timeoutMs: 30_000,
        env: { LANG: 'C', LC_ALL: 'C', PATH: fakeBin, SUPERWAGIE_SPIKE_ROOT: missingRoot, SUPERWAGIE_RUN_ROOT: join(workRoot, 'path-run') },
      });
    attacks.path_fallback_rejected = run.code !== 0 && !existsSync(output);
  }
  return { pass: entries.length === manifest.entries.length && Object.values(attacks).every(Boolean),
    fixture: task5Fixture('G0-DEPS-001', 'CANDIDATE'), platform: platform.id, admission_effect: 'none',
    manifest_sha256: digest, entries, file_count: allFiles.length, render_host: renderHost,
    static_resources: staticResources, fonts, attacks };
}

function stableBehavior(actual) {
  return { identity: actual.identity,
    core: { actual_binary: actual.core.actual_binary, handshake: actual.core.handshake,
      authenticated_envelopes: actual.core.authenticated_envelopes, resource_handle: actual.core.resource_handle,
      handle_checks: actual.core.handle_checks, checkpoint_key_fd_custody: actual.core.checkpoint_key_fd_custody },
    surfaces: actual.surfaces.map((surface) => ({ type: surface.type, ephemeral: surface.ephemeral,
      web_preferences: surface.web_preferences, remote_request_count: surface.remote_request_count })),
    isolation: { cross_surface_storage_leaks: actual.isolation.cross_surface_storage_leaks,
      handle_transfer_rejected: actual.isolation.handle_transfer_rejected, forged_handle_rejected: actual.isolation.forged_handle_rejected,
      ipc_forgery: actual.isolation.ipc_forgery },
    render_worker: { frame_indices: actual.render_worker.frame_indices, hashes_run_1: actual.render_worker.hashes_run_1,
      environment_from_empty_whitelist: actual.render_worker.environment_from_empty_whitelist,
      host_secret_canary_visible: actual.render_worker.host_secret_canary_visible,
      remote_request_count: actual.render_worker.remote_request_count },
    scope: { platform: actual.scope.platform, admission_effect: actual.scope.admission_effect, signed: actual.scope.signed } };
}

async function startCanary(electron, root) {
  const child = spawn(electron, [workerScript, '--mode', 'canary-server'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ELECTRON_RUN_AS_NODE: '1', LANG: 'C', LC_ALL: 'C' } });
  child.stdout.setEncoding('utf8'); const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('CANARY_START_TIMEOUT')), 5_000);
    lines.once('line', (line) => { clearTimeout(timer); resolvePromise(JSON.parse(line)); });
  });
  lines.close(); return { child, ready };
}

export async function runIsolationMatrix({ candidateRoot, workRoot, scenarioNames = ['quiet-host', 'codex-global-present', 'global-config-mutated'] }) {
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const { manifest, digest } = readManifest(candidateRoot); verifyEntries(candidateRoot, manifest);
  const electron = join(candidateRoot, manifest.launch.executable);
  const core = join(candidateRoot, manifest.launch.core_resolver);
  const electronHash = sha256(secureRead(electron)); const coreHash = sha256(secureRead(core));
  const scenarios = [];
  for (const name of scenarioNames) {
    const root = join(workRoot, name); const runRoot = join(root, 'run'); const fakeHome = join(root, 'home');
    const codexHome = join(fakeHome, '.codex'); const fakeBin = join(root, 'path-bin');
    for (const path of [root, runRoot, fakeHome, codexHome, fakeBin]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(fakeBin, process.platform === 'win32' ? 'node.exe' : 'node'), process.platform === 'win32' ? 'fake-node\n' : '#!/bin/sh\nexit 97\n', { mode: 0o700 });
    writeFileSync(join(fakeBin, process.platform === 'win32' ? 'solution-b-core.exe' : 'solution-b-core'), process.platform === 'win32' ? 'fake-core\n' : '#!/bin/sh\nexit 98\n', { mode: 0o700 });
    let canary = null;
    if (name !== 'quiet-host') {
      mkdirSync(join(codexHome, 'skills', 'global-skill'), { recursive: true, mode: 0o700 });
      writeFileSync(join(codexHome, 'skills', 'global-skill', 'SKILL.md'), 'GLOBAL_CANARY_MUST_NOT_BE_READ');
      writeFileSync(join(codexHome, 'config.toml'), name === 'global-config-mutated'
        ? 'model="mutated-global-model"\n[mcp_servers.poison]\ncommand="poison"\n'
        : 'model="global-model"\n[mcp_servers.poison]\ncommand="poison"\n');
      canary = await startCanary(electron, root);
    }
    const actualResultPath = join(root, 'actual-electron-result.json');
    const env = { HOME: fakeHome, TMPDIR: join(root, 'tmp'), LANG: 'C', LC_ALL: 'C', PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      CODEX_HOME: codexHome, SUPERWAGIE_ENV_CANARY: `task5-${name}-must-not-cross`,
      SUPERWAGIE_SPIKE_ROOT: candidateRoot, SUPERWAGIE_RUN_ROOT: runRoot,
      SUPERWAGIE_CORE_BIN: core, SUPERWAGIE_EVIDENCE_RUN_NONCE: randomBytes(16).toString('hex') };
    mkdirSync(env.TMPDIR, { mode: 0o700 });
    const run = await spawnCapture(electron, [join(candidateRoot, 'src', 'electron-main.mjs'), '--self-test', '--output', actualResultPath],
      { cwd: candidateRoot, env, timeoutMs: 150_000 });
    if (canary) { canary.child.kill('SIGTERM'); await new Promise((done) => canary.child.once('exit', done)); }
    if (run.code !== 0) throw new Error(`ISOLATION_SCENARIO_FAILED:${name}:${run.stderr.slice(-2000)}`);
    const actual = JSON.parse(secureRead(actualResultPath)); const text = JSON.stringify(actual);
    const observed = [codexHome, 'GLOBAL_CANARY_MUST_NOT_BE_READ', 'global-model', 'mutated-global-model', 'poison'].filter((token) => text.includes(token));
    scenarios.push({ name, actual_result_path: actualResultPath, electron_main_pid: actual.processes.electron_main_pid,
      rust_core_pids: actual.processes.rust_core_pids, render_host_pids: actual.processes.render_host_pids,
      process_identities: { electron_sha256: electronHash, rust_core_sha256: coreHash },
      launch_argv: [`<candidate>/${manifest.launch.executable}`, '<candidate>/src/electron-main.mjs', '--self-test', '--output', '<run>/actual-electron-result.json'],
      inherited_env_allow_names: Object.keys(env).sort(), core_transport: 'private-stdio', public_listeners: [],
      tool_directory: '<candidate>/src', cache_root: '<scenario>/run', canary_process: canary?.ready ?? null,
      external_canary_observations: observed, behavior: stableBehavior(actual), stdout: run.stdout, stderr: run.stderr });
  }
  const signatures = scenarios.map(({ behavior }) => sha256(Buffer.from(canonical(behavior))));
  const zeroDiff = new Set(signatures).size === 1;
  const externalObservations = scenarios.reduce((sum, item) => sum + item.external_canary_observations.length, 0);
  return { pass: zeroDiff && externalObservations === 0, fixture: task5Fixture('G0-ISOLATION-001', 'ZERO-DIFF'),
    platform: platform.id, admission_effect: 'none', candidate_manifest_sha256: digest,
    zero_diff: zeroDiff, behavior_signatures: signatures, external_canary_observations: externalObservations, scenarios };
}

async function coreProtocolAttacks(core, workRoot) {
  const custodyDir = mkdtempSync(join(workRoot, 'custody-'));
  const custodyPath = join(custodyDir, 'key');
  const fd = openSync(custodyPath, 'wx+', 0o600); writeSync(fd, randomBytes(32));
  if (process.platform !== 'win32') unlinkSync(custodyPath);
  const key = randomBytes(32).toString('hex');
  const child = spawn(core, [], { stdio: ['pipe', 'pipe', 'pipe', fd], env: {
    SUPERWAGIE_CORE_KEY: key, SUPERWAGIE_CHECKPOINT_PATH: join(workRoot, 'protocol-checkpoint.json'), SUPERWAGIE_CHECKPOINT_KEY_FD: '3' } });
  const lines = createInterface({ input: child.stdout }); const queue = []; const waiters = [];
  lines.on('line', (line) => { const value = JSON.parse(line); if (waiters.length) waiters.shift()(value); else queue.push(value); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((done) => waiters.push(done));
  const mainNonce = randomBytes(16).toString('hex');
  child.stdin.write(`${JSON.stringify({ type: 'hello', protocol: 'solution-b-v1', request_id: 'task5-hello',
    deadline_ms: Date.now() + 10_000, main_nonce: mainNonce, main_identity: 'electron-main@44.1.0' })}\n`);
  const ack = await next();
  const build = (sequence, requestId, command = { type: 'heartbeat' }) => {
    const unsigned = { type: 'request', protocol: 'solution-b-v1', request_id: requestId, deadline_ms: Date.now() + 10_000,
      main_nonce: mainNonce, core_nonce: ack.core_nonce, sequence, command };
    return { ...unsigned, mac: createHmac('sha256', key).update(canonical(unsigned)).digest('hex') };
  };
  const valid = build(1, 'task5-valid'); child.stdin.write(`${JSON.stringify(valid)}\n`); await next();
  child.stdin.write(`${JSON.stringify(valid)}\n`); const replay = await next();
  child.stdin.write(`${JSON.stringify(build(3, 'task5-gap'))}\n`); const gap = await next();
  const tampered = build(2, 'task5-tamper'); tampered.command.type = 'shutdown';
  child.stdin.write(`${JSON.stringify(tampered)}\n`); const tamper = await next();
  child.kill('SIGTERM'); await new Promise((done) => child.once('exit', done));
  lines.close(); closeSync(fd); if (process.platform === 'win32') unlinkSync(custodyPath);
  rmSync(custodyDir, { recursive: true, force: true });
  return { pid: child.pid, binary_sha256: sha256(secureRead(core)), replay_code: replay.code,
    out_of_order_code: gap.code, tamper_code: tamper.code };
}

export async function runBoundaryAttacks({ candidateRoot, workRoot, actualResultPath }) {
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const { manifest, digest } = readManifest(candidateRoot); verifyEntries(candidateRoot, manifest);
  const actual = JSON.parse(secureRead(actualResultPath));
  const core = join(candidateRoot, manifest.launch.core_resolver);
  const electron = join(candidateRoot, manifest.launch.executable);
  const worker = workerScript;
  const protocol = await coreProtocolAttacks(core, workRoot);
  const directCore = await spawnCapture(core, [], { env: {}, timeoutMs: 5_000 });
  const directWorker = await spawnCapture(electron, [worker, '--job-file', 'missing.json'], {
    cwd: workRoot, env: { ELECTRON_RUN_AS_NODE: '1', LANG: 'C', LC_ALL: 'C' }, timeoutMs: 5_000 });
  const outsideManifest = join(dirname(workRoot), `task5-outside-manifest-${basename(workRoot)}.json`);
  writeFileSync(outsideManifest, '{}'); symlinkSync(outsideManifest, join(workRoot, 'execution-manifest.json'));
  const symlinkProbeKey = randomBytes(32).toString('hex');
  const symlinkWorker = await spawnCapture(electron, [worker, '--mode', 'security-probe',
    '--security-module', join(candidateRoot, 'src', 'secure-files.mjs'),
    '--root', workRoot, '--path', 'execution-manifest.json'], {
      cwd: workRoot, env: { ELECTRON_RUN_AS_NODE: '1', LANG: 'C', LC_ALL: 'C', SUPERWAGIE_WORKER_KEY: symlinkProbeKey },
      timeoutMs: 15_000 });
  const symlinkReceipt = symlinkWorker.code === 0
    ? parseSignedReceipt(symlinkWorker.stdout.trim().split('\n').at(-1), symlinkProbeKey) : null;
  rmSync(outsideManifest, { force: true });
  const checks = actual.core.handle_checks; const ipc = actual.isolation.ipc_forgery;
  const attackReceipts = {
    ipc_sender_origin_rejected: ipc.wrong_identity_rejected && ipc.wrong_surface_channel_rejected && ipc.non_main_frame_rejected,
    ipc_replay_rejected: ipc.replay_rejected, protocol_replay_rejected: protocol.replay_code === 'REPLAY_REJECTED',
    protocol_out_of_order_rejected: protocol.out_of_order_code === 'REPLAY_REJECTED',
    protocol_tamper_rejected: protocol.tamper_code === 'MAC_INVALID', handle_cross_audience_rejected: checks.audience,
    handle_range_bounds_rejected: checks.size && checks.range, handle_expired_rejected: ipc.expired_rejected,
    handle_revoked_rejected: checks.revocation,
    path_symlink_rejected: symlinkReceipt?.rejected === true
      && /SYMLINK_FORBIDDEN|ELOOP/.test(symlinkReceipt.error_code ?? ''),
    environment_secret_denied: actual.render_worker.environment_from_empty_whitelist && !actual.render_worker.host_secret_canary_visible,
    direct_network_denied: actual.render_worker.remote_request_count === 0 && actual.render_worker.all_scheme_network_attempts > 0,
    direct_core_rejected: directCore.code !== 0, direct_worker_rejected: directWorker.code !== 0 };
  return { pass: Object.values(attackReceipts).every(Boolean), fixture: task5Fixture('G5-ATTACK-001', 'ACTUAL-BOUNDARY'),
    platform: platform.id, admission_effect: 'none', candidate_manifest_sha256: digest,
    process_identities: { main_pid: actual.processes.electron_main_pid, core_pids: actual.processes.rust_core_pids,
      surface_types: actual.surfaces.map(({ type }) => type), worker_pids: actual.processes.render_host_pids,
      electron_sha256: sha256(secureRead(electron)), core_sha256: sha256(secureRead(core)) },
    protocol, direct_core: directCore, direct_worker: directWorker, symlink_worker: symlinkWorker, attack_receipts: attackReceipts };
}

function sandboxProfileV2({ readable, writable, deniedExecutables = [], deniedReads = [] }) {
  const q = (path) => JSON.stringify(existsSync(path) ? realpathSync(path) : resolve(path));
  return [
    '(version 3)',
    '(allow default)',
    '(deny file-read*)',
    '(deny file-write*)',
    '(deny network*)',
    '(allow file-read-metadata)',
    ...deniedExecutables.map((path) => `(deny process-exec* (literal ${q(path)}))`),
    `(allow file-read* (literal "/") (subpath "/System") (subpath "/System/Volumes/Preboot") (subpath "/usr") (subpath "/bin") (subpath "/Library") (subpath "/dev") (subpath "/etc") (subpath "/private/etc") (subpath "/private/var/db"))`,
    ...readable.map((path) => `(allow file-read* (subpath ${q(path)}))`),
    ...writable.map((path) => `(allow file-write* (subpath ${q(path)}))`),
  ].join(' ');
}

function sandboxProfile({ candidateRoot, readable, writable, electron }) {
  const q = (path) => JSON.stringify(resolve(path));
  return `(version 1)\n(deny default)\n(allow process-exec (literal ${q(electron)}))\n(allow process-fork)\n(allow signal (target self))\n(allow sysctl-read)\n(allow mach-lookup)\n(allow ipc-posix-shm)\n(allow file-map-executable (subpath "/System") (subpath "/System/Volumes/Preboot") (subpath "/usr/lib") (subpath ${q(candidateRoot)}))\n(allow file-read* (subpath "/System") (subpath "/System/Volumes/Preboot") (subpath "/usr/lib") (subpath "/usr/local/lib") (subpath "/usr/share") (subpath "/Library") (subpath "/dev") (subpath "/etc") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/private/var/db/dyld") (subpath ${q(candidateRoot)}) ${readable.map((path) => `(subpath ${q(path)})`).join(' ')})\n(allow file-write* ${writable.map((path) => `(subpath ${q(path)})`).join(' ')})\n`;
}

function parseSignedReceipt(line, key) {
  const wrapper = JSON.parse(line);
  const expected = createHmac('sha256', key).update(canonical(wrapper.receipt)).digest('hex');
  if (wrapper.mac !== expected) throw new Error('WORKER_RECEIPT_MAC_INVALID');
  return wrapper.receipt;
}

async function runSandboxed({ candidateRoot, workRoot, args, readable, writable, deniedExecutables = [], deniedReads = [], interactive = false }) {
  const { manifest } = readManifest(candidateRoot);
  const electron = join(candidateRoot, ...manifest.launch.executable.split('/'));
  const workerRoot = dirname(workerScript);
  const key = randomBytes(32).toString('hex');
  const profilePath = join(workRoot, `sandbox-${randomBytes(6).toString('hex')}.sb`);
  if (process.platform === 'win32') {
    const policy = { type: interactive ? 'electron-chromium-renderer' : 'trusted-candidate-installer',
      candidate_root: '<candidate>', readable: readable.map((path) => basename(path)), writable: writable.map((path) => basename(path)),
      network: interactive ? 'session-deny' : 'not-used', node_in_renderer: false, direct_process_api_in_renderer: false };
    writeFileSync(profilePath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    const host = join(candidateRoot, 'src', 'extension-worker-host.mjs');
    const env = { LANG: 'C', LC_ALL: 'C', SUPERWAGIE_WORKER_KEY: key,
      SUPERWAGIE_FACADE_TOKEN: 'task5-facade-token' };
    if (!interactive) {
      const run = await spawnCapture(electron, [host, ...args], { cwd: workRoot, env, timeoutMs: 20_000 });
      if (run.code !== 0) throw new Error(`SANDBOXED_WORKER_FAILED:code=${run.code}:signal=${run.signal}:stdout=${run.stdout}:stderr=${run.stderr}`);
      return { run, receipt: parseSignedReceipt(run.stdout.trim().split('\n').at(-1), key), profile_sha256: sha256(secureRead(profilePath)) };
    }
    const run = await spawnCapture(electron, [host, ...args], { cwd: workRoot, env, timeoutMs: 20_000 });
    if (run.code !== 0) throw new Error(`SANDBOXED_EXTENSION_FAILED:code=${run.code}:signal=${run.signal}:stdout=${run.stdout}:stderr=${run.stderr}`);
    const receipt = parseSignedReceipt(run.stdout.trim().split('\n').at(-1), key);
    if (receipt.facade_request?.type !== 'facade_request') throw new Error('FACADE_REQUEST_MISSING');
    return { run, receipt, request: receipt.facade_request, profile_sha256: sha256(secureRead(profilePath)) };
  }
  const profile = sandboxProfileV2({ readable: [...new Set([workerRoot, candidateRoot, ...readable])],
    writable, deniedExecutables, deniedReads });
  writeFileSync(profilePath, profile, { mode: 0o600 });
  const env = { ELECTRON_RUN_AS_NODE: '1', LANG: 'C', LC_ALL: 'C', HOME: workRoot, TMPDIR: workRoot,
    SUPERWAGIE_WORKER_KEY: key, SUPERWAGIE_FACADE_TOKEN: 'task5-facade-token' };
  if (!interactive) {
    const run = await spawnCapture('/usr/bin/sandbox-exec', ['-p', profile, electron, workerScript, ...args],
      { cwd: workRoot, env, timeoutMs: 15_000 });
    if (run.code !== 0) throw new Error(`SANDBOXED_WORKER_FAILED:code=${run.code}:signal=${run.signal}:stdout=${run.stdout}:stderr=${run.stderr}`);
    return { run, receipt: parseSignedReceipt(run.stdout.trim().split('\n').at(-1), key), profile_sha256: sha256(secureRead(profilePath)) };
  }
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, electron, workerScript, ...args],
    { cwd: workRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const first = JSON.parse(await nextNonemptyLine(lines, child));
  if (first.type !== 'facade_request') throw new Error('FACADE_REQUEST_MISSING');
  child.stdin.write(`${JSON.stringify({ request_id: first.request_id, ok: true, facade_token: env.SUPERWAGIE_FACADE_TOKEN,
    result: { artifact_id: 'artifact:task5', source: 'public-capability-facade' } })}\n`);
  const signedLine = await nextNonemptyLine(lines, child);
  const receipt = parseSignedReceipt(signedLine, key); child.stdin.end();
  const exit = await new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
  lines.close(); if (exit.code !== 0) throw new Error(`SANDBOXED_EXTENSION_FAILED:${stderr}`);
  return { run: { pid: child.pid, ...exit, stderr }, receipt, request: first, profile_sha256: sha256(secureRead(profilePath)) };
}

export async function runExtensionLifecycle({ candidateRoot, workRoot }) {
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const { manifest, digest } = readManifest(candidateRoot); const store = join(workRoot, 'extension-store');
  const packages = join(workRoot, 'packages'); const outside = join(dirname(workRoot), `task5-outside-${basename(workRoot)}.txt`);
  writeFileSync(outside, 'outside-secret-canary', { mode: 0o600 });
  const receipts = []; const transitions = [];
  for (const version of ['1.0.0', '2.0.0']) {
    const root = join(packages, version); mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'extension.json'), `${JSON.stringify({ id: 'task5.fixture.skill', type: 'skill', version,
      permissions: ['artifact.read_metadata'], network: [] })}\n`, { mode: 0o600 });
    writeFileSync(join(root, 'payload.txt'), `payload-${version}\n`, { mode: 0o600 });
  }
  const install = async (version, transition) => {
    const source = join(packages, version);
    receipts.push(await runSandboxed({ candidateRoot, workRoot, readable: [workRoot, source], writable: [store, workRoot],
      args: ['--mode', 'installer', '--action', 'install', '--store', store, '--source', source, '--version', version] }));
    transitions.push(transition);
  };
  await install('1.0.0', 'install-v1');
  let extension = await runSandboxed({ candidateRoot, workRoot, readable: [workRoot, store], writable: [workRoot], interactive: true,
    args: ['--mode', 'extension', '--store', store, '--outside-canary', outside, '--core', join(candidateRoot, ...manifest.launch.core_resolver.split('/'))],
    deniedExecutables: [join(candidateRoot, ...manifest.launch.core_resolver.split('/'))], deniedReads: [outside] });
  receipts.push(extension); transitions.push('enable-v1');
  await install('2.0.0', 'update-v2'); transitions.push('disable-v2');
  receipts.push(await runSandboxed({ candidateRoot, workRoot, readable: [workRoot, store], writable: [store, workRoot],
    args: ['--mode', 'installer', '--action', 'select', '--store', store, '--version', '1.0.0'] }));
  transitions.push('rollback-v1');
  extension = await runSandboxed({ candidateRoot, workRoot, readable: [workRoot, store], writable: [workRoot], interactive: true,
    args: ['--mode', 'extension', '--store', store, '--outside-canary', outside, '--core', join(candidateRoot, ...manifest.launch.core_resolver.split('/'))],
    deniedExecutables: [join(candidateRoot, ...manifest.launch.core_resolver.split('/'))], deniedReads: [outside] });
  receipts.push(extension); transitions.push('enable-v1');
  receipts.push(await runSandboxed({ candidateRoot, workRoot, readable: [workRoot, store], writable: [store, workRoot],
    args: ['--mode', 'installer', '--action', 'remove', '--store', store, '--version', '1.0.0'] }));
  transitions.push('remove'); rmSync(outside, { force: true });
  const extensionReceipts = receipts.map(({ receipt }) => receipt).filter(({ schema }) => schema === 'task5-extension-receipt-v1');
  const installerReceipts = receipts.map(({ receipt }) => receipt).filter(({ schema }) => schema === 'task5-installer-receipt-v1');
  const publicFacadeOnly = extensionReceipts.every((item) => item.facade_ok && item.facade_request_count === 1 && item.direct_core_denied);
  const networkDenied = extensionReceipts.every((item) => item.network_denied);
  const outsideFileDenied = extensionReceipts.every((item) => item.outside_file_denied);
  const separatePids = new Set(receipts.map(({ receipt }) => receipt.pid)).size === receipts.length;
  return { pass: publicFacadeOnly && networkDenied && outsideFileDenied && separatePids && !existsSync(store),
    fixture: task5Fixture('G5-EXT-001', 'WORKER'), platform: platform.id, admission_effect: 'none',
    candidate_manifest_sha256: digest, transitions, install_gate_receipts: installerReceipts,
    extension_receipts: extensionReceipts, public_facade_only: publicFacadeOnly,
    network_denied: networkDenied, outside_file_denied: outsideFileDenied,
    actual_processes: receipts.map(({ receipt, profile_sha256 }) => ({ pid: receipt.pid, ppid: receipt.ppid,
      executable: receipt.executable, env_names: receipt.env_names, sandbox_profile_sha256: profile_sha256 })) };
}
