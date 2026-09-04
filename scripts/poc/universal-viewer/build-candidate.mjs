import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { verifyAcquiredCandidate } from './acquire-frozen-core.mjs';
import { auditChunkData } from './chunk-audit.mjs';
import { auditDependencyData } from './dependency-audit.mjs';
import {
  createBuildProvenance,
  createEvidenceIndex,
  provenanceBytes,
  sha256 as evidenceSha256,
  verifyBuildProvenance,
  verifyEvidenceIndex,
} from './evidence-bundle.mjs';
import { runOfficeClosureSmoke } from './office-closure-smoke.mjs';
import { auditSourcePolicy } from './source-policy-audit.mjs';
import { NPM_IDENTITY, resolveAdmittedNodeNpmRuntime } from './toolchain-identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_LOCK_PATH = path.join(HERE, 'source-lock.json');
const PATCH_LEDGER_PATH = path.join(HERE, 'patch-ledger.json');
const CHUNK_PLAN_PATH = path.join(HERE, 'chunk-plan.json');
const SOURCE_POLICY_PATH = path.join(HERE, 'fixtures', 'source-policy-forbidden.json');
const DEPENDENCY_POLICY_PATH = path.join(HERE, 'fixtures', 'dependency-policy.json');
const AUDIT_ROOT = path.join(HERE, 'audit');
const BASELINE_ROOT = path.join(HERE, 'baseline-evidence');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DEFAULT_DIST_ROOT = path.join(HERE, 'dist');
const RUNTIME_LOCK_PATH = path.join(HERE, 'package-lock.json');
const SBOM_ARGS = ['sbom', '--package-lock-only', '--omit=dev', '--omit=optional', '--sbom-format', 'cyclonedx'];
const SUPPLY_CHAIN_TIMEOUT_MS = 15_000;
const DEPENDENCY_INSTALL_TIMEOUT_MS = 120_000;
const CANDIDATE_COMMAND_TIMEOUT_MS = 300_000;
export const UPSTREAM_INSTALL_ARGS = Object.freeze(['ci', '--ignore-scripts', '--no-audit', '--prefer-offline']);
export const UPSTREAM_TEST_ARGS = Object.freeze(['test', '--', '--testTimeout=15000']);
const POC_SIGNATURE_SENTINEL = 'poc_unsigned_not_loadable_reserved_sentinel_000';
const OWNERSHIP_MARKER = '.superwagie-viewer-poc-owned';
const OWNERSHIP_MARKER_CONTENT = 'superwagie-viewer-poc-owned-v1\n';
const BASELINE_README = `# Universal Viewer Task 3 baseline evidence

This tracked bundle is deterministic review evidence, not a production admission.
\`admission-decision.json\` is authoritative for this run. The CycloneDX document
comes from the exact admitted npm command; only its random serial number and wall-clock
timestamp are removed in the tracked copy. The untouched raw live SBOM remains under
the ignored \`audit/\` directory. \`index.json\` binds every review artifact by SHA-256.
`;

class InputError extends Error {}
class PolicyError extends Error {}

function input(message) {
  throw new InputError(`Candidate build input unavailable: ${message}`);
}

function reject(message) {
  throw new PolicyError(`Candidate build rejected: ${message}`);
}

function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { input(`${label} is missing or invalid JSON: ${error.message}`); }
}

function requireFreshAuditDocument(document, label) {
  const counts = document?.metadata?.vulnerabilities;
  if (
    document?.auditReportVersion !== 2
    || !document.vulnerabilities
    || typeof document.vulnerabilities !== 'object'
    || !counts
    || ['info', 'low', 'moderate', 'high', 'critical', 'total']
      .some((key) => !Number.isInteger(counts[key]) || counts[key] < 0)
  ) {
    input(`${label} did not return a complete fresh npm audit document`);
  }
  return document;
}

function requireAbsoluteDirectory(value, label, mayNotExist = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) input(`${label} must be an explicit absolute path`);
  const resolved = path.resolve(value);
  if (!mayNotExist) {
    try { if (!statSync(resolved).isDirectory()) input(`${label} is not a directory`); }
    catch { input(`${label} does not exist`); }
  }
  return resolved;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sanitizedCommandEnvironment(envOverrides = {}) {
  const environment = process.platform === 'win32'
    ? {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
        TEMP: process.env.TEMP ?? tmpdir(),
        TMP: process.env.TMP ?? tmpdir(),
      }
    : {
        PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL ?? '',
        NO_COLOR: '1',
        NPM_CONFIG_USERCONFIG: '/dev/null',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NPM_CONFIG_FUND: 'false',
      };
  return { ...environment, ...envOverrides };
}

function assertFreshNetworkMode(envOverrides) {
  const ambientOffline = process.env.npm_config_offline ?? process.env.NPM_CONFIG_OFFLINE ?? '';
  const ambientCacheMode = process.env.npm_config_cache_mode ?? process.env.NPM_CONFIG_CACHE_MODE ?? '';
  if (/^(?:1|true)$/iu.test(ambientOffline) || /^(?:only|offline)$/iu.test(ambientCacheMode)) {
    input('fresh supply-chain audit rejects ambient offline or cache-only mode');
  }
  Object.assign(envOverrides, {
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_OFFLINE: 'false',
    NPM_CONFIG_PREFER_OFFLINE: 'false',
    NPM_CONFIG_PREFER_ONLINE: 'true',
    NPM_CONFIG_FETCH_RETRIES: '0',
    NPM_CONFIG_FETCH_TIMEOUT: '10000',
  });
}

export function runCandidateCommand(command, args, cwd, {
  allowNonzero = false,
  timeoutMs,
  envOverrides = {},
  requireFreshNetwork = false,
  displayCommand,
} = {}) {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    input('command timeout must be a positive safe integer');
  }
  if (!envOverrides || typeof envOverrides !== 'object' || Array.isArray(envOverrides)) {
    input('command environment overrides must be an object');
  }
  for (const [name, value] of Object.entries(envOverrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== 'string') {
      input('command environment overrides must contain string variables');
    }
  }
  const effectiveOverrides = { ...envOverrides };
  if (requireFreshNetwork) assertFreshNetworkMode(effectiveOverrides);
  const started = Date.now();
  const childEnv = sanitizedCommandEnvironment(effectiveOverrides);
  delete childEnv.npm_config_allow_scripts;
  delete childEnv.NPM_CONFIG_ALLOW_SCRIPTS;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: childEnv,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: 'SIGKILL' }),
  });
  if (result.error?.code === 'ENOENT') input(`required tool ${command} is missing`);
  if (result.error?.code === 'ETIMEDOUT') {
    input(`${[command, ...args].join(' ')} timed out after ${timeoutMs} ms`);
  }
  const record = {
    command: displayCommand ?? [command, ...args].join(' '),
    exit_code: result.status ?? 2,
    elapsed_millis: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (record.exit_code !== 0 && !allowNonzero) {
    const detail = record.stderr.trim().split('\n').slice(-4).join(' | ');
    reject(`${record.command} failed with exit ${record.exit_code}${detail ? `: ${detail}` : ''}`);
  }
  return record;
}

function seatbeltProfile(cwd, { deniedMarker, allowedMarker }) {
  const quote = (value) => JSON.stringify(path.resolve(value));
  const cwdRoot = path.resolve(cwd);
  const cwdAncestors = [];
  for (let current = path.dirname(cwdRoot); current !== path.dirname(current); current = path.dirname(current)) {
    cwdAncestors.push(current);
  }
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    `(allow file-read* file-test-existence file-map-executable ${cwdAncestors.map((item) => `(literal ${quote(item)})`).join(' ')} (literal "/usr") (literal "/usr/local") (literal "/opt") (literal "/opt/homebrew") (subpath "/usr/local") (subpath "/opt/homebrew") (subpath "/usr/bin") (subpath "/bin") (subpath ${quote(cwdRoot)}))`,
    `(allow file-read-data (literal ${quote(allowedMarker)}))`,
    `(deny file-read-data (literal ${quote(deniedMarker)}))`,
    `(allow file-write* (subpath ${quote(cwdRoot)}))`,
    '(deny network*)',
  ].join(' ');
}

function allProcessIds(deadline) {
  const timeout = Math.max(1, deadline - Date.now());
  const result = spawnSync('/bin/ps', ['-axo', 'pid='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: sanitizedCommandEnvironment(),
    timeout,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    input('macOS process enumeration failed during sandbox containment');
  }
  return result.stdout.split(/\s+/u).filter((value) => /^\d+$/u.test(value));
}

export function compileSandboxFingerprintHelper(containmentRoot, { spawnCommand = spawnSync } = {}) {
  const source = path.join(HERE, 'sandbox-fingerprint.c');
  const helper = path.join(containmentRoot, 'sandbox-fingerprint');
  const developerQuery = spawnCommand('/usr/bin/xcode-select', ['-p'], {
    encoding: 'utf8',
    env: sanitizedCommandEnvironment(),
    timeout: 10_000,
  });
  const developerCandidate = developerQuery.status === 0 ? developerQuery.stdout.trim() : '';
  const developerDir = path.isAbsolute(developerCandidate) && existsSync(developerCandidate)
    ? realpathSync(developerCandidate)
    : '';
  if (!path.isAbsolute(developerDir)) input('macOS sandbox fingerprint developer directory is unavailable');
  const toolEnvironment = sanitizedCommandEnvironment({ DEVELOPER_DIR: developerDir });
  const compilerQuery = spawnCommand('/usr/bin/xcrun', ['--find', 'clang'], {
    encoding: 'utf8',
    env: toolEnvironment,
    timeout: 10_000,
  });
  const sdkQuery = spawnCommand('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
    encoding: 'utf8',
    env: toolEnvironment,
    timeout: 10_000,
  });
  const compilerCandidate = compilerQuery.status === 0 ? compilerQuery.stdout.trim() : '';
  const compiler = path.isAbsolute(compilerCandidate) && existsSync(compilerCandidate)
    ? realpathSync(compilerCandidate)
    : '';
  const sdkCandidate = sdkQuery.status === 0 ? sdkQuery.stdout.trim() : '';
  const sdk = path.isAbsolute(sdkCandidate) && existsSync(sdkCandidate)
    ? realpathSync(sdkCandidate)
    : '';
  const sdkSettings = sdk ? path.join(sdk, 'SDKSettings.json') : '';
  if (!path.isAbsolute(compiler) || !existsSync(compiler)) input('macOS sandbox fingerprint compiler is unavailable');
  if (!path.isAbsolute(sdk) || !existsSync(sdkSettings)) input('macOS sandbox fingerprint SDK is unavailable');
  const compilerBefore = sha256(readFileSync(compiler));
  const sdkSettingsBytes = readFileSync(sdkSettings);
  const sdkSettingsBefore = sha256(sdkSettingsBytes);
  let sdkVersion;
  try { sdkVersion = JSON.parse(sdkSettingsBytes.toString('utf8')).Version; }
  catch { input('macOS sandbox fingerprint SDK identity is invalid'); }
  if (typeof sdkVersion !== 'string' || sdkVersion.length === 0) input('macOS sandbox fingerprint SDK identity is invalid');
  const compilerVersion = spawnCommand(compiler, ['--version'], {
    encoding: 'utf8',
    env: toolEnvironment,
    timeout: 10_000,
  });
  const compiled = spawnCommand(compiler, ['-isysroot', sdk, source, '-o', helper], {
    encoding: 'utf8',
    env: toolEnvironment,
    timeout: 15_000,
  });
  if (compilerVersion.status !== 0 || compiled.status !== 0 || !existsSync(helper)) {
    input('macOS sandbox fingerprint helper could not be built');
  }
  const compilerAfter = sha256(readFileSync(compiler));
  const sdkSettingsAfter = sha256(readFileSync(sdkSettings));
  if (compilerAfter !== compilerBefore || sdkSettingsAfter !== sdkSettingsBefore) {
    input('macOS sandbox fingerprint compiler identity changed during compilation');
  }
  return {
    helper,
    identity: {
      source_sha256: `sha256:${sha256(readFileSync(source))}`,
      compiler_sha256: `sha256:${compilerBefore}`,
      compiler_version: compilerVersion.stdout.trim().split('\n')[0],
      sdk_version: sdkVersion,
      sdk_settings_sha256: `sha256:${sdkSettingsBefore}`,
      helper_sha256: `sha256:${sha256(readFileSync(helper))}`,
    },
  };
}

function sandboxFingerprintPids(helper, mode, deniedMarker, allowedMarker, deadline) {
  const pids = allProcessIds(deadline).filter((pid) => Number(pid) !== process.pid);
  if (pids.length === 0) return [];
  const timeout = Math.max(1, deadline - Date.now());
  if (timeout <= 1) input('macOS sandbox containment exceeded its cleanup deadline');
  const result = spawnSync(helper, [mode, deniedMarker, allowedMarker, ...pids], {
    encoding: 'utf8',
    env: sanitizedCommandEnvironment(),
    timeout,
  });
  if (result.status !== 0) input('macOS sandbox fingerprint query failed');
  return result.stdout.split(/\s+/u).filter((value) => /^\d+$/u.test(value)).map(Number);
}

function killContainedProcesses(child, fingerprint) {
  const deadline = Date.now() + 5_000;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch {} }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let killed;
    try {
      killed = sandboxFingerprintPids(
        fingerprint.helper,
        'kill',
        fingerprint.deniedMarker,
        fingerprint.allowedMarker,
        deadline,
      );
    } catch (error) {
      return error;
    }
    if (killed.length === 0) break;
    if (Date.now() >= deadline) {
      return new InputError('Candidate build input unavailable: isolated process containment exceeded its cleanup deadline');
    }
    if (attempt === 63) {
      return new InputError('Candidate build input unavailable: isolated process containment could not quiesce');
    }
  }
  return null;
}

export function runIsolatedCandidateCommand(command, args, cwd, {
  timeoutMs = CANDIDATE_COMMAND_TIMEOUT_MS,
  envOverrides = {},
  displayCommand,
} = {}) {
  if (process.platform !== 'darwin') {
    return Promise.reject(new InputError('Candidate build input unavailable: isolated candidate verification is not implemented for this platform'));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new InputError('Candidate build input unavailable: isolated command timeout must be a positive safe integer'));
  }
  const sandboxTempRoot = path.join(cwd, '.superwagie-sandbox-tmp');
  mkdirSync(sandboxTempRoot, { recursive: true, mode: 0o700 });
  const containmentRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'superwagie-viewer-containment-'));
  let deniedMarker;
  let allowedMarker;
  let compiledHelper;
  try {
    deniedMarker = path.join(containmentRoot, `denied-${randomBytes(16).toString('hex')}`);
    allowedMarker = path.join(containmentRoot, `allowed-${randomBytes(16).toString('hex')}`);
    writeFileSync(deniedMarker, 'denied\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(allowedMarker, 'allowed\n', { flag: 'wx', mode: 0o600 });
    compiledHelper = compileSandboxFingerprintHelper(containmentRoot);
  }
  catch (error) {
    rmSync(containmentRoot, { recursive: true, force: true });
    throw error;
  }
  const fingerprint = { helper: compiledHelper.helper, deniedMarker, allowedMarker };
  const sandboxArgs = ['-p', seatbeltProfile(cwd, fingerprint), command, ...args];
  const commandLabel = displayCommand ?? [command, ...args].join(' ');
  const childEnv = sanitizedCommandEnvironment({
    ...envOverrides,
    TMPDIR: sandboxTempRoot,
    TMP: sandboxTempRoot,
    TEMP: sandboxTempRoot,
  });
  delete childEnv.npm_config_allow_scripts;
  delete childEnv.NPM_CONFIG_ALLOW_SCRIPTS;
  const started = Date.now();
  return new Promise((resolve, rejectPromise) => {
    const child = spawn('/usr/bin/sandbox-exec', sandboxArgs, {
      cwd,
      env: childEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let terminalError;
    let settled = false;
    let containmentCleaned = false;
    const cleanupContainmentRoot = () => {
      if (containmentCleaned) return;
      containmentCleaned = true;
      rmSync(containmentRoot, { recursive: true, force: true });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const timer = setTimeout(() => {
      terminalError = new InputError(
        `Candidate build input unavailable: isolated ${commandLabel} timed out after ${timeoutMs} ms`,
      );
      terminalError = killContainedProcesses(child, fingerprint) ?? terminalError;
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 128 * 1024 * 1024) {
        terminalError = new InputError('Candidate build input unavailable: isolated command output exceeded its bound');
        terminalError = killContainedProcesses(child, fingerprint) ?? terminalError;
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => {
      clearTimeout(timer);
      cleanupContainmentRoot();
      fail(new InputError(`Candidate build input unavailable: isolated command could not start (${error.code ?? 'UNKNOWN'})`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      terminalError = killContainedProcesses(child, fingerprint) ?? terminalError;
      cleanupContainmentRoot();
      if (terminalError) return fail(terminalError);
      const record = {
        command: commandLabel,
        exit_code: code ?? 2,
        elapsed_millis: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        isolation: 'macos-seatbelt-no-network-home-denied',
        isolation_toolchain: compiledHelper.identity,
      };
      if (record.exit_code !== 0) {
        const detail = record.stderr.trim().split('\n').slice(-4).join(' | ');
        return fail(new PolicyError(
          `Candidate build rejected: ${record.command} failed with exit ${record.exit_code}${detail ? `: ${detail}` : ''}`,
        ));
      }
      settled = true;
      resolve(record);
    });
  });
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isSameOrAncestor(candidate, protectedRoot) {
  const relative = path.relative(candidate, protectedRoot);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(target, label) {
  let current = target;
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) input(`${label} or parent is a symlink outside the safe boundary`);
      if (!stat.isDirectory()) input(`${label} or parent is not a real directory`);
      if (realpathSync(current) !== current) input(`${label} or parent identity is not canonical`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function prepareOwnedRoot(root, label, { allowedRoot, protectedRoots = [] } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) {
    input(`${label} requires an explicit absolute safe boundary`);
  }
  const resolved = path.resolve(root);
  const allowed = path.resolve(allowedRoot);
  if (resolved !== allowed) input(`${label} is outside its explicit allowed safe boundary`);
  for (const protectedRoot of protectedRoots) {
    if (typeof protectedRoot !== 'string' || !path.isAbsolute(protectedRoot)) input(`${label} protected boundary is invalid`);
    if (isSameOrAncestor(resolved, path.resolve(protectedRoot))) input(`${label} is a protected root or its ancestor`);
  }
  assertNoSymlinkComponents(resolved, label);
  if (existsSync(root)) {
    const marker = path.join(resolved, OWNERSHIP_MARKER);
    if (!existsSync(marker)) input(`${label} is not marker-owned by this PoC`);
    const markerStat = lstatSync(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) input(`${label} marker must be a regular non-symlink file`);
    if (readFileSync(marker, 'utf8') !== OWNERSHIP_MARKER_CONTENT) input(`${label} marker content is not the admitted ownership version`);
    rmSync(resolved, { recursive: true, force: true });
  }
  mkdirSync(resolved, { recursive: true });
  assertNoSymlinkComponents(resolved, label);
  writeFileSync(path.join(resolved, OWNERSHIP_MARKER), OWNERSHIP_MARKER_CONTENT, { flag: 'wx', mode: 0o600 });
}

function assertPromotableOwnedRoot(root, label) {
  assertNoSymlinkComponents(root, label);
  const marker = path.join(root, OWNERSHIP_MARKER);
  if (!existsSync(marker)) input(`${label} is not marker-owned by this PoC`);
  const markerStat = lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()
    || readFileSync(marker, 'utf8') !== OWNERSHIP_MARKER_CONTENT) {
    input(`${label} has an invalid ownership marker`);
  }
}

function normalizePromotion({ stagingRoot, outputRoot, allowedRoot }) {
  if (![stagingRoot, outputRoot, allowedRoot].every((value) => typeof value === 'string' && path.isAbsolute(value))) {
    input('output promotion requires explicit absolute boundaries');
  }
  const staging = path.resolve(stagingRoot);
  const output = path.resolve(outputRoot);
  if (output !== path.resolve(allowedRoot) || path.dirname(staging) !== path.dirname(output)
    || !path.basename(staging).startsWith(`${path.basename(output)}.staging-`)) {
    input('output promotion is outside its explicit allowed safe boundary');
  }
  assertPromotableOwnedRoot(staging, 'staging output root');
  if (existsSync(output)) assertPromotableOwnedRoot(output, 'current output root');
  return {
    staging,
    output,
    backup: `${output}.backup-${randomBytes(16).toString('hex')}`,
    backedUp: false,
    promoted: false,
  };
}

function normalizePromotionDomain(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0
    || outputs.some((output) => typeof output !== 'string' || !path.isAbsolute(output))) {
    input('transactional output promotion requires explicit absolute recovery roots');
  }
  const normalized = outputs.map((output) => path.resolve(output));
  if (new Set(normalized).size !== normalized.length) {
    input('transactional output promotion recovery roots must be distinct');
  }
  const parent = path.dirname(normalized[0]);
  if (normalized.some((output) => path.dirname(output) !== parent)) {
    input('transactional output promotion requires a common parent directory');
  }
  return {
    outputs: normalized,
    parent,
    journalPath: path.join(parent, '.superwagie-viewer-promotion.json'),
  };
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    input('promotion domain owner state is unavailable');
  }
}

function acquirePromotionDomainLock(domain, purpose = 'promotion') {
  if (!['promotion', 'build'].includes(purpose)) input('output domain lock purpose is unsupported');
  const lockPath = path.join(domain.parent, `.superwagie-viewer-${purpose}.lock`);
  const schemaId = `superwagie.viewer-output-${purpose}-lock.v1`;
  const owner = {
    schema_id: schemaId,
    pid: process.pid,
    nonce: randomBytes(16).toString('hex'),
  };
  const bytes = jsonBytes(owner);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidatePath = `${lockPath}.candidate-${randomBytes(16).toString('hex')}`;
    let descriptor;
    let candidateOwned = false;
    try {
      descriptor = openSync(candidatePath, 'wx', 0o600);
      candidateOwned = true;
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      let published = false;
      try {
        // Publishing by hard-link is an atomic no-replace operation: another
        // process can observe either no lock or the complete, fsynced owner
        // document, never the empty/partial candidate being constructed.
        linkSync(candidatePath, lockPath);
        published = true;
      } catch (publishError) {
        if (publishError?.code !== 'EEXIST') throw publishError;
      }
      unlinkSync(candidatePath);
      syncPath(domain.parent);
      if (published) {
        const identity = lstatSync(lockPath);
        if (!identity.isFile() || identity.isSymbolicLink() || !readFileSync(lockPath).equals(bytes)) {
          input('published promotion domain lock identity changed');
        }
        return { lockPath, bytes, dev: identity.dev, ino: identity.ino };
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      if (candidateOwned) {
        try { unlinkSync(candidatePath); } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT') throw cleanupError;
        }
      }
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    {
      let current;
      let identity;
      try {
        identity = lstatSync(lockPath);
        if (!identity.isFile() || identity.isSymbolicLink()) input('promotion domain lock is not a regular file');
        current = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch (readError) {
        if (readError?.code === 'ENOENT') continue;
        if (readError instanceof InputError) throw readError;
        input('promotion domain lock is invalid');
      }
      if (current?.schema_id !== schemaId
        || !Number.isSafeInteger(current.pid) || current.pid <= 0
        || typeof current.nonce !== 'string' || !/^[a-f0-9]{32}$/u.test(current.nonce)) {
        input('promotion domain lock is invalid');
      }
      if (processIsAlive(current.pid)) input('promotion domain is already active');
      let beforeRemoval;
      try { beforeRemoval = lstatSync(lockPath); }
      catch (readError) { if (readError?.code === 'ENOENT') continue; throw readError; }
      if (beforeRemoval.dev !== identity.dev || beforeRemoval.ino !== identity.ino
        || readFileSync(lockPath, 'utf8') !== `${JSON.stringify(current, null, 2)}\n`) {
        continue;
      }
      try { unlinkSync(lockPath); }
      catch (removeError) { if (removeError?.code !== 'ENOENT') throw removeError; }
      syncPath(domain.parent);
    }
  }
  input('promotion domain lock could not be acquired');
}

function releasePromotionDomainLock(lock) {
  let identity;
  try { identity = lstatSync(lock.lockPath); }
  catch { input('promotion domain lock disappeared while active'); }
  if (!identity.isFile() || identity.isSymbolicLink() || identity.dev !== lock.dev || identity.ino !== lock.ino
    || !readFileSync(lock.lockPath).equals(lock.bytes)) {
    input('promotion domain lock identity changed while active');
  }
  unlinkSync(lock.lockPath);
  syncPath(path.dirname(lock.lockPath));
}

function withPromotionDomainLock(domain, operation) {
  const lock = acquirePromotionDomainLock(domain);
  try { return operation(); }
  finally { releasePromotionDomainLock(lock); }
}

function removeOrphanStagingRoots(domain, sync = syncPath) {
  let removed = false;
  for (const output of domain.outputs) {
    const prefix = `${path.basename(output)}.staging-`;
    for (const name of readdirSync(domain.parent)) {
      if (!name.startsWith(prefix)) continue;
      const staging = path.join(domain.parent, name);
      assertPromotableOwnedRoot(staging, 'orphan staging output root');
      rmSync(staging, { recursive: true, force: true });
      removed = true;
    }
  }
  if (removed) sync(domain.parent);
}

function syncPath(target) {
  if (process.platform === 'win32' && statSync(target).isDirectory()) return;
  const descriptor = openSync(target, 'r');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function syncOwnedTree(root, sync) {
  const visit = (target) => {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      input('staged output tree contains an unsupported filesystem entry');
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(target)) visit(path.join(target, name));
    }
    sync(target);
  };
  visit(root);
}

function writePromotionJournal(journalPath, document, sync = syncPath) {
  const temporary = `${journalPath}.tmp-${randomBytes(16).toString('hex')}`;
  try {
    writeFileSync(temporary, jsonBytes(document), { flag: 'wx', mode: 0o600 });
    sync(temporary);
    renameSync(temporary, journalPath);
    sync(path.dirname(journalPath));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function recoverPromotionJournal(journalPath, allowedOutputs, sync = syncPath) {
  if (!existsSync(journalPath)) return;
  let journal;
  try { journal = JSON.parse(readFileSync(journalPath, 'utf8')); }
  catch { input('transactional output promotion journal is invalid'); }
  const journalOutputs = Array.isArray(journal?.entries)
    ? journal.entries.map(({ output }) => output)
    : [];
  const allowed = new Set(allowedOutputs);
  if (journal?.schema_id !== 'superwagie.viewer-output-promotion.v1'
    || !['prepared', 'committed'].includes(journal.phase)
    || !Array.isArray(journal.entries)
    || journal.entries.length === 0
    || new Set(journalOutputs).size !== journalOutputs.length
    || journalOutputs.some((output) => !allowed.has(output))) {
    input('transactional output promotion journal does not match the requested roots');
  }
  const journalParent = path.dirname(journalPath);
  for (const entry of journal.entries) {
    if (![entry.staging, entry.output, entry.backup].every((value) => typeof value === 'string' && path.isAbsolute(value))
      || typeof entry.had_output !== 'boolean'
      || path.dirname(entry.output) !== journalParent
      || path.dirname(entry.staging) !== path.dirname(entry.output)
      || path.dirname(entry.backup) !== path.dirname(entry.output)
      || !path.basename(entry.staging).startsWith(`${path.basename(entry.output)}.staging-`)
      || !path.basename(entry.backup).startsWith(`${path.basename(entry.output)}.backup-`)) {
      input('transactional output promotion journal contains an unsafe root');
    }
  }
  if (journal.phase === 'committed') {
    for (const entry of journal.entries) {
      if (!existsSync(entry.output)) input('committed output promotion is missing a canonical root');
      assertPromotableOwnedRoot(entry.output, 'committed output root');
      if (existsSync(entry.backup)) {
        assertPromotableOwnedRoot(entry.backup, 'committed backup root');
        rmSync(entry.backup, { recursive: true, force: true });
      }
    }
  } else {
    for (const entry of [...journal.entries].reverse()) {
      if (existsSync(entry.backup)) {
        assertPromotableOwnedRoot(entry.backup, 'promotion backup root');
        if (existsSync(entry.output)) {
          assertPromotableOwnedRoot(entry.output, 'partially promoted output root');
          if (existsSync(entry.staging)) input('promotion recovery found ambiguous duplicate staging roots');
          renameSync(entry.output, entry.staging);
        }
        renameSync(entry.backup, entry.output);
      } else if (entry.had_output) {
        if (!existsSync(entry.output)) input('promotion recovery cannot locate the previous canonical root');
        assertPromotableOwnedRoot(entry.output, 'previous canonical output root');
      } else if (existsSync(entry.output)) {
        assertPromotableOwnedRoot(entry.output, 'partially promoted new output root');
        if (existsSync(entry.staging)) input('promotion recovery found ambiguous new output roots');
        renameSync(entry.output, entry.staging);
      }
    }
    for (const entry of journal.entries) {
      if (!existsSync(entry.staging)) continue;
      assertPromotableOwnedRoot(entry.staging, 'interrupted staging output root');
      rmSync(entry.staging, { recursive: true, force: true });
    }
  }
  rmSync(journalPath, { force: true });
  sync(path.dirname(journalPath));
}

function recoverPromotionDomain(outputs, sync = syncPath) {
  const domain = normalizePromotionDomain(outputs);
  return withPromotionDomainLock(domain, () => {
    recoverPromotionJournal(domain.journalPath, domain.outputs, sync);
    return domain;
  });
}

export function promoteOwnedRoots(promotions, {
  rename = renameSync,
  remove = rmSync,
  sync = syncPath,
  recoveryAllowedOutputs,
} = {}) {
  if (!Array.isArray(promotions) || promotions.length === 0) input('output promotion requires at least one root');
  const requestedOutputs = promotions.map(({ outputRoot }) => outputRoot);
  const domain = normalizePromotionDomain(recoveryAllowedOutputs ?? requestedOutputs);
  return withPromotionDomainLock(domain, () => {
    recoverPromotionJournal(domain.journalPath, domain.outputs, sync);
    if (requestedOutputs.some((output) => typeof output !== 'string' || !domain.outputs.includes(path.resolve(output)))) {
      input('output promotion root is outside its recovery domain');
    }
    const entries = promotions.map(normalizePromotion);
    if (new Set(entries.flatMap(({ staging, output }) => [staging, output])).size !== entries.length * 2) {
      input('output promotion roots must be distinct');
    }
    for (const entry of entries) syncOwnedTree(entry.staging, sync);
    const journalPath = domain.journalPath;
    const journal = {
      schema_id: 'superwagie.viewer-output-promotion.v1',
      phase: 'prepared',
      entries: entries.map((entry) => ({
        staging: entry.staging,
        output: entry.output,
        backup: entry.backup,
        had_output: existsSync(entry.output),
      })),
    };
    writePromotionJournal(journalPath, journal, sync);
    try {
      for (const entry of entries) {
        if (existsSync(entry.output)) {
          rename(entry.output, entry.backup);
          entry.backedUp = true;
        }
      }
      for (const entry of entries) {
        rename(entry.staging, entry.output);
        entry.promoted = true;
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const entry of [...entries].reverse()) {
        try {
          if (entry.promoted && existsSync(entry.output) && !existsSync(entry.staging)) {
            rename(entry.output, entry.staging);
          }
          if (entry.backedUp && existsSync(entry.backup) && !existsSync(entry.output)) {
            rename(entry.backup, entry.output);
          }
        } catch { rollbackFailed = true; }
      }
      if (rollbackFailed) input('staged output promotion failed and rollback was incomplete');
      rmSync(journalPath, { force: true });
      sync(path.dirname(journalPath));
      input(`staged output promotion failed: ${error.code ?? 'UNKNOWN'}`);
    }
    writePromotionJournal(journalPath, { ...journal, phase: 'committed' }, sync);
    let cleanupFailed = false;
    for (const entry of entries) {
      if (!entry.backedUp) continue;
      try { remove(entry.backup, { recursive: true, force: true }); }
      catch { cleanupFailed = true; }
    }
    if (!cleanupFailed) {
      rmSync(journalPath, { force: true });
      sync(path.dirname(journalPath));
    }
  });
}

export function promoteOwnedRoot(stagingRoot, outputRoot, { allowedRoot, recoveryAllowedOutputs } = {}) {
  promoteOwnedRoots(
    [{ stagingRoot, outputRoot, allowedRoot }],
    { recoveryAllowedOutputs },
  );
}

export function prepareDeveloperCache(sourceRoot, outputRoot) {
  requireAbsoluteDirectory(outputRoot, 'output root', true);
  const developerRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'superwagie-viewer-developer-'));
  const archivePath = path.join(developerRoot, '.source.tar');
  try {
    runCandidateCommand('git', ['archive', '--format=tar', '--output', archivePath, 'HEAD'], sourceRoot);
    runCandidateCommand('tar', ['-xf', archivePath, '-C', developerRoot], developerRoot);
    rmSync(archivePath, { force: true });
    return developerRoot;
  } catch (error) {
    rmSync(developerRoot, { recursive: true, force: true });
    throw error;
  }
}

export function requireAdmittedAuditExit(record, label) {
  if (![0, 1].includes(record?.exit_code)) {
    input(`${label} exited outside the admitted npm audit status set`);
  }
  return record;
}

function verifyLedger(ledger, sourceLock, receipt) {
  if (ledger.schema_id !== 'superwagie.viewer-patch-ledger.v1') input('patch ledger schema is invalid');
  if (ledger.candidate_commit !== sourceLock.commit || receipt.commit !== sourceLock.commit) reject('patch ledger commit differs from acquired source');
  if (!Array.isArray(ledger.patches) || ledger.patches.length !== 0) reject('Frozen Core admission requires a zero-patch ledger');
  if (ledger.source_tree_sha256 !== sourceLock.source_tree_sha256 || ledger.post_patch_tree_sha256 !== sourceLock.source_tree_sha256) {
    reject('pristine post-patch tree identity differs from locked source tree identity');
  }
  const findings = new Map((ledger.excluded_host_findings ?? []).map((item) => [item.package, item]));
  const dompurify = findings.get('dompurify');
  const mermaid = findings.get('mermaid');
  if (
    dompurify?.audited_commit !== '1db3137806dc4047513f6abd2ec010030e5029a2'
    || dompurify?.reason !== 'host_not_imported'
    || !dompurify.advisories?.includes('GHSA-55q2-fjhq-7xh7')
  ) input('DOMPurify excluded-host finding is incomplete');
  const requiredMermaid = [
    'GHSA-c4c3-pg64-4m4v',
    'GHSA-6x64-9x62-f2gx',
    'GHSA-3rrr-jr9j-h3q3',
    'GHSA-2v8p-3f2j-5mp7',
    'GHSA-rhh3-jpg6-66xh',
  ];
  if (
    mermaid?.audited_commit !== '1db3137806dc4047513f6abd2ec010030e5029a2'
    || mermaid?.reason !== 'host_not_imported'
    || requiredMermaid.some((advisory) => !mermaid.advisories?.includes(advisory))
  ) input('Mermaid excluded-host finding is incomplete');
}

function builtChunks(plan) {
  const ids = plan.chunks?.map((chunk) => chunk.chunk_id);
  const expected = ['viewer-base', 'viewer-office', 'viewer-media', 'viewer-data', 'viewer-specialized'];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) input('chunk plan must declare all five chunks in canonical order');
  const built = plan.chunks.filter((chunk) => chunk.status === 'poc_built');
  if (built.some((chunk) => !['viewer-base', 'viewer-office'].includes(chunk.chunk_id))) reject('only base and office chunks may be built in this PoC');
  if (built.length !== 2 || plan.chunks.slice(2).some((chunk) => chunk.status !== 'planned_not_built')) {
    input('future chunks must remain planned_not_built and unselected');
  }
  return built;
}

function generatedEntry(chunk, candidateRoot) {
  const exports = chunk.entry_exports.map((entry) => {
    if (!Array.isArray(entry.exports) || entry.exports.length === 0) input(`${chunk.chunk_id} has an empty export selection`);
    const compiled = path.join(candidateRoot, 'dist', entry.source.replace(/^src\//, '').replace(/\.ts$/, '.js'));
    return `export { ${entry.exports.join(', ')} } from ${JSON.stringify(compiled)};`;
  });
  if (chunk.chunk_id === 'viewer-office') {
    const wordModule = path.join(candidateRoot, 'dist', 'viewers', 'word', 'index.js');
    exports.push(
      `import { mountWordViewer as coreMountWordViewer } from ${JSON.stringify(wordModule)};`,
      "import * as bundledDocxPreview from 'docx-preview';",
      "import bundledJSZip from 'jszip';",
      'export function mountBundledWordViewer(input, container, ctx, options = {}) {',
      '  return coreMountWordViewer(input, container, ctx, {',
      '    loadDocxPreview: async () => bundledDocxPreview,',
      '    loadZip: async () => bundledJSZip,',
      '  }, options);',
      '}',
    );
  }
  return exports.join('\n');
}

function normalizeModuleId(id, candidateRoot, entryPath) {
  if (id === entryPath) return '<generated-entry>';
  const nodeModules = id.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  if (nodeModules !== -1) return `node_modules/${id.slice(nodeModules + `${path.sep}node_modules${path.sep}`.length).split(path.sep).join('/')}`;
  const relative = path.relative(candidateRoot, id).split(path.sep).join('/');
  return relative.startsWith('../') ? `<outside-candidate>/${path.basename(id)}` : relative;
}

async function bundleChunk({ chunk, candidateRoot, outputRoot }) {
  const chunkRoot = path.join(outputRoot, chunk.chunk_id);
  mkdirSync(chunkRoot, { recursive: true });
  const entryPath = path.join(outputRoot, `.entry-${chunk.chunk_id}.mjs`);
  writeFileSync(entryPath, `${generatedEntry(chunk, candidateRoot)}\n`);
  const rolldownUrl = pathToFileURL(path.join(HERE, 'node_modules', 'rolldown', 'dist', 'index.mjs')).href;
  let rolldownModule;
  try { rolldownModule = await import(rolldownUrl); }
  catch (error) { input(`locked upstream build tool rolldown is unavailable: ${error.message}`); }
  const bundlePath = path.join(chunkRoot, `${chunk.chunk_id}.mjs`);
  let bundle;
  try {
    bundle = await rolldownModule.rolldown({ input: entryPath, treeshake: true });
    const result = await bundle.write({ file: bundlePath, format: 'esm', minify: true, comments: false });
    const outputChunk = result.output.find((item) => item.type === 'chunk');
    if (!outputChunk) reject(`${chunk.chunk_id} emitted no JavaScript chunk`);
    const moduleIds = Object.keys(outputChunk.modules ?? {}).map((id) => normalizeModuleId(id, candidateRoot, entryPath)).sort();
    const externalImports = [...(outputChunk.imports ?? []), ...(outputChunk.dynamicImports ?? [])].sort();
    const thirdPartyModules = moduleIds.filter((id) => id.includes('node_modules/'));
    return {
      bundlePath,
      moduleGraph: {
        chunk_id: chunk.chunk_id,
        entry_exports: chunk.entry_exports,
        modules: moduleIds,
        external_imports: externalImports,
        third_party_modules: thirdPartyModules,
      },
      buildTool: `rolldown@${rolldownModule.VERSION}`,
    };
  } finally {
    await bundle?.close();
    rmSync(entryPath, { force: true });
  }
}

function packageIdentity(name, version) {
  return `npm:${name.replaceAll('@', '').replaceAll('/', ':')}:${version}`;
}

function productionRuntimePackages(lock) {
  return Object.entries(lock.packages).flatMap(([lockPath, metadata]) => {
    if (!lockPath || metadata.dev === true || metadata.optional === true) return [];
    const marker = 'node_modules/';
    const name = lockPath.slice(lockPath.lastIndexOf(marker) + marker.length);
    return [{ lockPath, name, ...metadata }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function embeddedReadmeLicense(packageRoot) {
  for (const readme of readdirSync(packageRoot).filter((name) => /^readme(?:\.|$)/i.test(name)).sort()) {
    const body = readFileSync(path.join(packageRoot, readme), 'utf8');
    const heading = /^#{1,6}[ \t]+licen[cs]e[ \t]*$/im.exec(body);
    if (!heading) continue;
    const license = body.slice(heading.index + heading[0].length).trim();
    if (license) return Buffer.from(`${license}\n`, 'utf8');
  }
  return undefined;
}

export function materializeRuntimeLicenses({ chunkRoot, runtimePackages, runtimeRoot = HERE } = {}) {
  const refs = [];
  for (const runtime of runtimePackages) {
    const packageRoot = path.join(runtimeRoot, runtime.lockPath);
    const licenseFile = readdirSync(packageRoot).find((name) => /^(?:license|copying)(?:\.|$)/i.test(name));
    const logical = `licenses/npm-${runtime.name.replaceAll('@', '').replaceAll('/', '-')}-${runtime.version}.txt`;
    const standaloneLicense = licenseFile ? readFileSync(path.join(packageRoot, licenseFile)) : undefined;
    if (standaloneLicense?.toString('utf8').trim()) writeFileSync(path.join(chunkRoot, logical), standaloneLicense);
    else {
      const embedded = embeddedReadmeLicense(packageRoot);
      if (!embedded) reject(`runtime package ${runtime.name}@${runtime.version} has no reviewable license artifact`);
      writeFileSync(path.join(chunkRoot, logical), embedded);
    }
    refs.push(logical);
  }
  return refs.sort();
}

function prepareChunkFiles({ chunk, bundlePath, candidateRoot, outputRoot, runtimeLock }) {
  const chunkRoot = path.join(outputRoot, chunk.chunk_id);
  const bundleName = path.basename(bundlePath);
  const coreLicense = `licenses/${chunk.chunk_id}-omni-viewer-core-MIT.txt`;
  const coreNotice = `notices/${chunk.chunk_id}-core-third-party-notices.txt`;
  mkdirSync(path.join(chunkRoot, 'licenses'), { recursive: true });
  mkdirSync(path.join(chunkRoot, 'notices'), { recursive: true });
  copyFileSync(path.join(candidateRoot, 'LICENSE'), path.join(chunkRoot, coreLicense));
  copyFileSync(path.join(candidateRoot, 'THIRD_PARTY_NOTICES.md'), path.join(chunkRoot, coreNotice));
  const runtimePackages = chunk.chunk_id === 'viewer-office' ? productionRuntimePackages(runtimeLock) : [];
  const runtimeLicenses = materializeRuntimeLicenses({ chunkRoot, runtimePackages });
  const licenseInventory = runtimePackages.length ? `licenses/${chunk.chunk_id}-runtime-license-inventory.json` : undefined;
  if (licenseInventory) {
    writeFileSync(path.join(chunkRoot, licenseInventory), jsonBytes({
      schema_id: 'superwagie.viewer-runtime-license-inventory.v1',
      packages: runtimePackages.map((item) => ({ identity: packageIdentity(item.name, item.version), license: item.license })),
    }));
  }
  const runtimeNotice = runtimePackages.length ? `notices/${chunk.chunk_id}-runtime-dependencies.json` : undefined;
  if (runtimeNotice) {
    writeFileSync(path.join(chunkRoot, runtimeNotice), jsonBytes({
      schema_id: 'superwagie.viewer-runtime-dependencies.v1',
      packages: runtimePackages.map((item) => ({
        identity: packageIdentity(item.name, item.version),
        license: item.license,
        resolved: item.resolved,
        integrity: item.integrity,
      })),
    }));
  }
  const licenseRefs = [coreLicense, ...runtimeLicenses, ...(licenseInventory ? [licenseInventory] : [])].sort();
  const noticeRefs = [coreNotice, ...(runtimeNotice ? [runtimeNotice] : [])].sort();
  const files = [bundleName, ...licenseRefs, ...noticeRefs].sort();
  const fileBytes = files.map((name) => ({ name, bytes: readFileSync(path.join(chunkRoot, name)) }));
  const installedBytes = fileBytes.reduce((sum, item) => sum + item.bytes.length, 0);
  const compressionInput = Buffer.concat(fileBytes.flatMap((item) => [Buffer.from(`${item.name}\0`), item.bytes]));
  const compressedBytes = gzipSync(compressionInput, { level: 9 }).length;
  return { bundleName, files, fileBytes, installedBytes, compressedBytes, licenseRefs, noticeRefs };
}

function writeChunkManifest({ chunk, prepared, outputRoot, sourceLock, buildProvenanceHash }) {
  const fileHashes = prepared.fileBytes.map((item) => ({ logical_name: item.name, sha256: `sha256:${sha256(item.bytes)}` }));
  const manifest = {
    chunk_id: chunk.chunk_id,
    chunk_version: sourceLock.version,
    platform_id: 'macos-15-arm64',
    arch: 'arm64',
    compressed_bytes: prepared.compressedBytes,
    installed_bytes: prepared.installedBytes,
    code: [prepared.bundleName],
    assets: [],
    fonts: [],
    descriptor_ids: chunk.descriptor_ids,
    direct_dependencies: chunk.direct_dependencies ?? [],
    transitive_dependencies: chunk.transitive_dependencies ?? [],
    license_refs: prepared.licenseRefs,
    notice_refs: prepared.noticeRefs,
    source_provenance: {
      identity: `omni-viewer-core@${sourceLock.version}#${sourceLock.commit}`,
      sha256: `sha256:${sourceLock.source_tree_sha256}`,
    },
    build_provenance: {
      identity: 'superwagie-viewer-build-provenance:v1',
      sha256: buildProvenanceHash,
    },
    file_hashes: fileHashes,
    signature: POC_SIGNATURE_SENTINEL,
  };
  const evidence = {
    schema_id: 'superwagie.viewer-chunk-manifest-poc-evidence.v1',
    signature_state: 'poc_unsigned_not_loadable',
    production_loadable: false,
    manifest_candidate: manifest,
  };
  writeFileSync(path.join(outputRoot, chunk.chunk_id, 'chunk-manifest.poc.json'), jsonBytes(evidence));
  return { ...manifest, signature_state: evidence.signature_state, production_loadable: evidence.production_loadable };
}

function sanitizeSbom(raw) {
  const value = structuredClone(raw);
  delete value.serialNumber;
  if (value.metadata) delete value.metadata.timestamp;
  return value;
}

function writeBaseline(artifacts, baselineRoot) {
  prepareOwnedRoot(baselineRoot, 'staged baseline evidence root', {
    allowedRoot: baselineRoot,
    protectedRoots: [REPO_ROOT, path.join(HERE, 'fixtures')],
  });
  for (const [name, bytes] of Object.entries(artifacts)) {
    const target = path.join(baselineRoot, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const index = createEvidenceIndex(artifacts);
  writeFileSync(path.join(baselineRoot, 'index.json'), jsonBytes(index));
  verifyEvidenceIndex({ index, artifacts });
  return index;
}

export async function buildCandidate({
  candidateRoot,
  outputRoot,
  allowedOutputRoot = DEFAULT_DIST_ROOT,
  writeBaseline: persistBaseline = true,
  evidenceMode = 'fresh',
} = {}) {
  if (!['fresh', 'tracked-review'].includes(evidenceMode)) input('candidate evidence mode is unsupported');
  if (evidenceMode === 'tracked-review' && persistBaseline) {
    input('tracked review evidence cannot rewrite the admission baseline');
  }
  const sourceRoot = requireAbsoluteDirectory(candidateRoot, 'candidate root');
  const distRoot = requireAbsoluteDirectory(outputRoot, 'output root', true);
  if (distRoot !== path.resolve(allowedOutputRoot)) input('output root is outside its explicit allowed safe boundary');
  if (distRoot === sourceRoot || distRoot.startsWith(`${sourceRoot}${path.sep}`)) reject('output root must be outside the pristine candidate source');
  const sharesBaselineDomain = path.dirname(distRoot) === path.dirname(BASELINE_ROOT);
  if (persistBaseline && !sharesBaselineDomain) {
    input('baseline and output roots must share one transactional promotion domain');
  }
  const promotionUniverse = sharesBaselineDomain ? [distRoot, BASELINE_ROOT] : [distRoot];
  const sourceLockBytes = readFileSync(SOURCE_LOCK_PATH);
  const ledgerBytes = readFileSync(PATCH_LEDGER_PATH);
  const runtimeLockBytes = readFileSync(RUNTIME_LOCK_PATH);
  const sourceLock = JSON.parse(sourceLockBytes.toString('utf8'));
  const runtimeLock = JSON.parse(runtimeLockBytes.toString('utf8'));
  const receipt = verifyAcquiredCandidate({ candidateRoot: sourceRoot, sourceLock, lockBytes: sourceLockBytes });
  const ledger = JSON.parse(ledgerBytes.toString('utf8'));
  const plan = readJson(CHUNK_PLAN_PATH, 'chunk plan');
  verifyLedger(ledger, sourceLock, receipt);
  const chunks = builtChunks(plan);
  const sourcePolicy = auditSourcePolicy({ candidateRoot: sourceRoot });
  if (sourcePolicy.decision !== 'GO') reject(`source policy found ${sourcePolicy.forbidden_runtime_edges} forbidden edges`);

  const buildDomain = normalizePromotionDomain(promotionUniverse);
  const buildDomainLock = acquirePromotionDomainLock(buildDomain, 'build');
  const stagingRoot = `${distRoot}.staging-${randomBytes(16).toString('hex')}`;
  const baselineStagingRoot = `${BASELINE_ROOT}.staging-${randomBytes(16).toString('hex')}`;
  let developerRoot;
  try {
  recoverPromotionDomain(promotionUniverse);
  removeOrphanStagingRoots(buildDomain);
  mkdirSync(AUDIT_ROOT, { recursive: true });
  prepareOwnedRoot(stagingRoot, 'staging output root', {
    allowedRoot: stagingRoot,
    protectedRoots: [REPO_ROOT, sourceRoot, path.join(HERE, '.candidate'), path.join(HERE, 'fixtures')],
  });
  developerRoot = prepareDeveloperCache(sourceRoot, stagingRoot);
  let admittedRuntime;
  try { admittedRuntime = resolveAdmittedNodeNpmRuntime(); }
  catch (error) { input(error.message); }
  const npmCommand = (args) => `${admittedRuntime.npm_identity} ${args.join(' ')}`;
  const runNpm = (args, cwd, options = {}) => runCandidateCommand(
    admittedRuntime.node_executable,
    [admittedRuntime.npm_cli, ...args],
    cwd,
    { ...options, displayCommand: npmCommand(args) },
  );
  const runIsolatedNpm = (args, cwd, options = {}) => runIsolatedCandidateCommand(
    admittedRuntime.node_executable,
    [admittedRuntime.npm_cli, ...args],
    cwd,
    { ...options, displayCommand: npmCommand(args) },
  );
  const commands = [
    runNpm(UPSTREAM_INSTALL_ARGS, developerRoot, {
      timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS,
      envOverrides: evidenceMode === 'tracked-review' ? { NPM_CONFIG_OFFLINE: 'true' } : {},
    }),
    await runIsolatedNpm(['run', 'typecheck'], developerRoot),
    await runIsolatedNpm(UPSTREAM_TEST_ARGS, developerRoot, {
      envOverrides: {
        NPM_CONFIG_OFFLINE: 'true',
        VITEST_MIN_WORKERS: '1',
        VITEST_MAX_WORKERS: '1',
      },
    }),
    await runIsolatedNpm(['run', 'build'], developerRoot),
  ];
  const npmVersion = NPM_IDENTITY;
  const sbomRun = evidenceMode === 'fresh'
    ? runNpm(SBOM_ARGS, HERE, { timeoutMs: 30_000 })
    : { command: `tracked ${SBOM_ARGS.join(' ')}`, exit_code: 0, elapsed_millis: 0 };
  const trackedSbomBytes = evidenceMode === 'tracked-review'
    ? readFileSync(path.join(BASELINE_ROOT, 'source-sbom.cdx.json'))
    : null;
  const rawSbomBytes = trackedSbomBytes
    ?? Buffer.from(sbomRun.stdout.endsWith('\n') ? sbomRun.stdout : `${sbomRun.stdout}\n`);
  writeFileSync(path.join(AUDIT_ROOT, 'source-sbom.raw.cdx.json'), rawSbomBytes);
  const sanitizedSbom = sanitizeSbom(JSON.parse(rawSbomBytes.toString('utf8')));
  const sbomBytes = jsonBytes(sanitizedSbom);
  writeFileSync(path.join(AUDIT_ROOT, 'source-sbom.cdx.json'), sbomBytes);

  const npmAudit = evidenceMode === 'fresh'
    ? runNpm(['audit', '--omit=dev', '--json'], HERE, {
        allowNonzero: true,
        timeoutMs: SUPPLY_CHAIN_TIMEOUT_MS,
        requireFreshNetwork: true,
      })
    : {
        command: 'tracked npm audit --omit=dev --json',
        exit_code: 0,
        elapsed_millis: 0,
        stdout: readFileSync(path.join(BASELINE_ROOT, 'npm-audit.raw.json'), 'utf8'),
        stderr: '',
      };
  requireAdmittedAuditExit(npmAudit, 'PoC production audit');
  const rawAuditBytes = Buffer.from(npmAudit.stdout.endsWith('\n') ? npmAudit.stdout : `${npmAudit.stdout}\n`);
  writeFileSync(path.join(AUDIT_ROOT, 'npm-audit.raw.json'), rawAuditBytes);
  const rawAudit = requireFreshAuditDocument(JSON.parse(npmAudit.stdout), 'PoC production audit');
  const candidateAudit = evidenceMode === 'fresh'
    ? runNpm(['audit', '--omit=dev', '--json'], developerRoot, {
        allowNonzero: true,
        timeoutMs: SUPPLY_CHAIN_TIMEOUT_MS,
        requireFreshNetwork: true,
      })
    : {
        command: 'tracked candidate npm audit --omit=dev --json',
        exit_code: 0,
        elapsed_millis: 0,
        stdout: readFileSync(path.join(BASELINE_ROOT, 'candidate-npm-audit.raw.json'), 'utf8'),
        stderr: '',
      };
  requireAdmittedAuditExit(candidateAudit, 'candidate production audit');
  const candidateAuditBytes = Buffer.from(candidateAudit.stdout.endsWith('\n') ? candidateAudit.stdout : `${candidateAudit.stdout}\n`);
  writeFileSync(path.join(AUDIT_ROOT, 'candidate-npm-audit.raw.json'), candidateAuditBytes);
  const rawCandidateAudit = requireFreshAuditDocument(JSON.parse(candidateAudit.stdout), 'candidate production audit');
  const dependencyPolicy = readJson(DEPENDENCY_POLICY_PATH, 'dependency policy');
  const dependencyResult = auditDependencyData({
    lock: runtimeLock,
    audit: rawAudit,
    policy: dependencyPolicy,
  });
  dependencyResult.package_lock_sha256 = sha256(runtimeLockBytes);
  const candidateDependencyResult = auditDependencyData({
    lock: readJson(path.join(developerRoot, 'package-lock.json'), 'candidate package lock'),
    audit: rawCandidateAudit,
    policy: dependencyPolicy,
  });
  writeFileSync(path.join(AUDIT_ROOT, 'dependencies.json'), jsonBytes(dependencyResult));

  const moduleGraphs = [];
  const preparedChunks = [];
  let buildTool;
  for (const chunk of chunks) {
    const built = await bundleChunk({ chunk, candidateRoot: developerRoot, outputRoot: stagingRoot });
    buildTool ??= built.buildTool;
    moduleGraphs.push(built.moduleGraph);
    const admittedPackages = new Set([...(chunk.direct_dependencies ?? []), ...(chunk.transitive_dependencies ?? [])]
      .map((identity) => identity.replace(/^npm:/, '').replace(/:[^:]+$/, '')));
    const reachedPackages = new Set(built.moduleGraph.third_party_modules.map((id) => {
      const relative = id.slice('node_modules/'.length);
      return relative.startsWith('@') ? relative.split('/').slice(0, 2).join('/') : relative.split('/')[0];
    }));
    if (built.moduleGraph.external_imports.length) reject(`${chunk.chunk_id} contains unresolved runtime imports`);
    const undeclaredPackages = [...reachedPackages].filter((name) => !admittedPackages.has(name)).sort();
    if (undeclaredPackages.length) {
      reject(`${chunk.chunk_id} reaches undeclared runtime dependencies: ${undeclaredPackages.join(', ')}`);
    }
    preparedChunks.push({
      chunk,
      built,
      prepared: prepareChunkFiles({
        chunk,
        bundlePath: built.bundlePath,
        candidateRoot: developerRoot,
        outputRoot: stagingRoot,
        runtimeLock,
      }),
    });
  }
  const flatModules = moduleGraphs.flatMap((graph) => graph.modules);
  const builtSourceModules = [...new Set(flatModules.flatMap((id) => {
    if (!id.startsWith('dist/') || !id.endsWith('.js')) return [];
    return [`src/${id.slice('dist/'.length, -'.js'.length)}.ts`];
  }))].sort();
  const builtSourcePolicy = auditSourcePolicy({ candidateRoot: sourceRoot, selectedSources: builtSourceModules });
  writeFileSync(path.join(AUDIT_ROOT, 'source-policy.json'), jsonBytes(sourcePolicy));
  writeFileSync(path.join(AUDIT_ROOT, 'built-source-policy.json'), jsonBytes(builtSourcePolicy));
  const forbiddenNames = ['obsidian', 'electron', 'child_process', 'dompurify', 'mermaid', 'libreoffice', 'soffice'];
  const forbiddenModules = flatModules.filter((id) => forbiddenNames.some((name) => id.toLowerCase().includes(name)));
  const moduleGraphEvidence = {
    schema_id: 'superwagie.viewer-module-graph.v1',
    candidate_commit: sourceLock.commit,
    chunks: moduleGraphs,
    forbidden_modules: forbiddenModules,
    forbidden_runtime_edges: builtSourcePolicy.forbidden_runtime_edges + forbiddenModules.length,
    forbidden_source_findings: builtSourcePolicy.violations,
    audited_source_modules: builtSourceModules,
    excluded_host_closure: {
      audited_commit: '1db3137806dc4047513f6abd2ec010030e5029a2',
      reason: 'host_not_imported',
      packages: [
        { package: 'dompurify', reachable: flatModules.some((id) => id.toLowerCase().includes('dompurify')) },
        { package: 'mermaid', reachable: flatModules.some((id) => id.toLowerCase().includes('mermaid')) },
      ],
    },
  };
  const moduleGraphBytes = jsonBytes(moduleGraphEvidence);
  writeFileSync(path.join(AUDIT_ROOT, 'module-graph.json'), moduleGraphBytes);

  const smoke = await runOfficeClosureSmoke({
    bundlePath: path.join(stagingRoot, 'viewer-office', 'viewer-office.mjs'),
  });
  const smokeBytes = jsonBytes(smoke);
  writeFileSync(path.join(AUDIT_ROOT, 'office-smoke.json'), smokeBytes);

  const toolchain = {
    node: process.version.slice(1),
    node_executable_sha256: `sha256:${admittedRuntime.node_sha256}`,
    npm: npmVersion,
    npm_runtime_identity: admittedRuntime.npm_identity,
    npm_tree_sha256: `sha256:${admittedRuntime.npm_tree_sha256}`,
    git: runCandidateCommand('git', ['--version'], sourceRoot).stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    bundler: buildTool,
    sbom_command: `npm ${SBOM_ARGS.join(' ')}`,
    candidate_isolation: commands.slice(1).map((command) => command.isolation_toolchain),
  };
  const outputs = Object.fromEntries(preparedChunks.flatMap(({ chunk, prepared }) => prepared.fileBytes.map((file) => [
    `${chunk.chunk_id}/${file.name}`,
    file.bytes,
  ])));
  const provenanceInputs = {
    'source-lock.json': sourceLockBytes,
    'patch-ledger.json': ledgerBytes,
    'package-lock.json': runtimeLockBytes,
    'source-sbom.cdx.json': sbomBytes,
    'npm-audit.raw.json': rawAuditBytes,
    'module-graph.json': moduleGraphBytes,
    'office-smoke.json': smokeBytes,
  };
  const buildProvenance = createBuildProvenance({
    sourceIdentity: { commit: sourceLock.commit, archive_sha256: sourceLock.source_tree_sha256 },
    toolchain,
    inputs: provenanceInputs,
    outputs,
  });
  verifyBuildProvenance({
    provenance: buildProvenance,
    sourceIdentity: buildProvenance.source_identity,
    toolchain,
    inputs: provenanceInputs,
    outputs,
  });
  const buildProvenanceBytes = provenanceBytes(buildProvenance);
  const buildProvenanceHash = evidenceSha256(buildProvenanceBytes);
  writeFileSync(path.join(AUDIT_ROOT, 'build-provenance.json'), buildProvenanceBytes);

  const manifests = preparedChunks.map(({ chunk, prepared }) => writeChunkManifest({
    chunk,
    prepared,
    outputRoot: stagingRoot,
    sourceLock,
    buildProvenanceHash,
  }));
  const chunkResult = auditChunkData({ distRoot: stagingRoot });
  writeFileSync(path.join(AUDIT_ROOT, 'chunks.json'), jsonBytes(chunkResult));
  const hostExcluded = moduleGraphEvidence.excluded_host_closure.packages.every((item) => !item.reachable);
  const decision = sourcePolicy.decision === 'GO'
    && builtSourcePolicy.decision === 'GO'
    && dependencyResult.decision === 'GO'
    && candidateDependencyResult.decision === 'GO'
    && dependencyResult.moderate_or_higher === 0
    && candidateDependencyResult.moderate_or_higher === 0
    && forbiddenModules.length === 0
    && hostExcluded
    && smoke.placeholder_content === false
    && chunkResult.decision === 'GO'
    ? 'GO'
    : 'NO_GO';
  const admissionDecision = {
    schema_id: 'superwagie.viewer-candidate-admission-decision.v1',
    decision,
    candidate_commit: sourceLock.commit,
    patches: ledger.patches.length,
    forbidden_runtime_edges: moduleGraphEvidence.forbidden_runtime_edges,
    moderate_or_higher: dependencyResult.moderate_or_higher,
    office_smoke_non_placeholder: smoke.placeholder_content === false,
    chunks: chunkResult.decision,
  };
  const baselineArtifacts = {
    'README.md': Buffer.from(BASELINE_README, 'utf8'),
    'admission-decision.json': jsonBytes(admissionDecision),
    'build-provenance.json': buildProvenanceBytes,
    'built-source-policy.json': jsonBytes(builtSourcePolicy),
    'candidate-npm-audit.raw.json': candidateAuditBytes,
    'chunks.json': jsonBytes(chunkResult),
    'dependencies.json': jsonBytes(dependencyResult),
    'module-graph.json': moduleGraphBytes,
    'npm-audit.raw.json': rawAuditBytes,
    'office-smoke.json': smokeBytes,
    'source-policy.json': jsonBytes(sourcePolicy),
    'source-sbom.cdx.json': sbomBytes,
    ...Object.fromEntries(chunks.map((chunk) => [
      `manifests/${chunk.chunk_id}.chunk-manifest.poc.json`,
      readFileSync(path.join(stagingRoot, chunk.chunk_id, 'chunk-manifest.poc.json')),
    ])),
  };
  const baselineIndex = persistBaseline
    ? writeBaseline(baselineArtifacts, baselineStagingRoot)
    : createEvidenceIndex(baselineArtifacts);
  verifyEvidenceIndex({ index: baselineIndex, artifacts: baselineArtifacts });

  writeFileSync(path.join(AUDIT_ROOT, 'upstream-build.json'), jsonBytes({
    schema_id: 'superwagie.viewer-upstream-build.v1',
    candidate_commit: sourceLock.commit,
    commands,
  }));
  let runtimeAfter;
  try { runtimeAfter = resolveAdmittedNodeNpmRuntime(); }
  catch (error) { input(error.message); }
  if (runtimeAfter.node_sha256 !== admittedRuntime.node_sha256
    || runtimeAfter.npm_tree_sha256 !== admittedRuntime.npm_tree_sha256) {
    input('the admitted Node/npm runtime identity changed during candidate verification');
  }
  rmSync(developerRoot, { recursive: true, force: true });
  developerRoot = undefined;
  verifyAcquiredCandidate({ candidateRoot: sourceRoot, sourceLock, lockBytes: sourceLockBytes });
  if (decision === 'GO') {
    promoteOwnedRoots([
      { stagingRoot, outputRoot: distRoot, allowedRoot: allowedOutputRoot },
      ...(persistBaseline ? [{ stagingRoot: baselineStagingRoot, outputRoot: BASELINE_ROOT, allowedRoot: BASELINE_ROOT }] : []),
    ], { recoveryAllowedOutputs: promotionUniverse });
  } else if (persistBaseline) {
    promoteOwnedRoots(
      [{ stagingRoot: baselineStagingRoot, outputRoot: BASELINE_ROOT, allowedRoot: BASELINE_ROOT }],
      { recoveryAllowedOutputs: promotionUniverse },
    );
  }
  return {
    schema_id: 'superwagie.viewer-candidate-build.v1',
    evidence_mode: evidenceMode,
    release_admission: evidenceMode === 'fresh',
    decision,
    candidate_commit: sourceLock.commit,
    patches: ledger.patches.length,
    upstream_commands: commands.map((item) => ({ command: item.command, exit_code: item.exit_code, elapsed_millis: item.elapsed_millis })),
    module_graph: moduleGraphEvidence,
    office_smoke: smoke,
    manifests: manifests.map((manifest) => ({
      chunk_id: manifest.chunk_id,
      compressed_bytes: manifest.compressed_bytes,
      installed_bytes: manifest.installed_bytes,
      signature_state: manifest.signature_state,
      production_loadable: manifest.production_loadable,
    })),
    future_chunks: plan.chunks.filter((chunk) => chunk.status === 'planned_not_built').map((chunk) => chunk.chunk_id),
    sbom: { command: `npm ${SBOM_ARGS.join(' ')}`, bom_format: sanitizedSbom.bomFormat, component_count: sanitizedSbom.components?.length ?? 0 },
    npm_audit: { moderate_or_higher: dependencyResult.moderate_or_higher },
    build_provenance_sha256: buildProvenanceHash,
    baseline_artifact_count: baselineIndex.artifacts.length,
  };
  } finally {
    try { if (developerRoot) rmSync(developerRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(baselineStagingRoot, { recursive: true, force: true }); } catch {}
    releasePromotionDomainLock(buildDomainLock);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || !['--candidate-root', '--output-root'].includes(name)) input(`${name ?? '<argument>'} is unsupported or missing a value`);
    if (name === '--candidate-root') options.candidateRoot = value;
    else options.outputRoot = value;
  }
  if (!options.candidateRoot || !options.outputRoot) input('--candidate-root and --output-root are required');
  if (path.resolve(options.outputRoot) !== DEFAULT_DIST_ROOT) input('--output-root must be the designated Universal Viewer PoC dist root');
  return options;
}

async function main() {
  const result = await buildCandidate(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision !== 'GO') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof InputError ? 2 : 1;
  }
}
