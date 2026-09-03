import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAuthoritativeSourceLock, verifyAcquiredCandidate } from './acquire-frozen-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = path.join(HERE, 'source-lock.json');
const ZERO_PATCH_LEDGER = Object.freeze({
  schema_id: 'superwagie.viewer-patch-ledger.v1',
  patches: [],
});
const NPM_SBOM_COMMAND = 'npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx';

function fail(message) {
  throw new Error(`Frozen Core provenance rejected: ${message}`);
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail(`${label} must be an explicit absolute path`);
  }
  return path.resolve(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toolVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch (error) {
    fail(`could not identify ${command}: ${error.message}`);
  }
}

function npmIdentity() {
  const packageManifest = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8'));
  const admitted = /^npm@(\d+\.\d+\.\d+)$/.exec(packageManifest.packageManager ?? '');
  if (!admitted) fail('package.json must admit one exact npm version through packageManager');
  const actual = toolVersion('npm', ['--version']);
  if (actual !== admitted[1]) fail(`npm ${actual} is not admitted npm ${admitted[1]}`);
  const help = toolVersion('npm', ['sbom', '--help']);
  for (const option of ['--package-lock-only', '--omit', '--sbom-format']) {
    if (!help.includes(option)) fail(`admitted npm ${actual} does not support npm sbom ${option}`);
  }
  return actual;
}

function absolutePathKind(value) {
  if (path.posix.isAbsolute(value)) return 'POSIX';
  if (path.win32.isAbsolute(value)) return 'Windows';
  return undefined;
}

export function assertNoAbsolutePaths(value, location = '$') {
  if (typeof value === 'string') {
    const kind = absolutePathKind(value);
    if (kind) fail(`${kind} absolute path at ${location}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAbsolutePaths(item, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      assertNoAbsolutePaths(key, `${location}.<key>`);
      assertNoAbsolutePaths(nested, `${location}.${key}`);
    }
  }
}

export function collectProvenance({ candidateRoot, sourceLock, lockBytes } = {}) {
  const resolvedCandidate = requireAbsolute(candidateRoot, 'candidate root');
  const authority = parseAuthoritativeSourceLock({ sourceLock, lockBytes });
  sourceLock = authority.sourceLock;
  const actualLockBytes = authority.lockBytes;
  const receipt = verifyAcquiredCandidate({
    candidateRoot: resolvedCandidate,
    sourceLock,
    lockBytes: actualLockBytes,
  });
  const patchLedgerBytes = Buffer.from(`${JSON.stringify(ZERO_PATCH_LEDGER)}\n`, 'utf8');
  const provenance = {
    schema_id: 'superwagie.viewer-source-provenance.v1',
    version: sourceLock.version,
    commit: receipt.commit,
    tree: receipt.tree,
    archive_sha256: receipt.archive_sha256,
    source_lock_sha256: sha256(actualLockBytes),
    patch_ledger: ZERO_PATCH_LEDGER,
    patch_ledger_sha256: sha256(patchLedgerBytes),
    acquisition_mode: receipt.acquisition_mode,
    toolchain: {
      node: process.version,
      npm: npmIdentity(),
      git: toolVersion('git', ['--version']),
      platform: process.platform,
      arch: process.arch,
      npm_sbom_command: NPM_SBOM_COMMAND,
    },
  };
  assertNoAbsolutePaths(provenance);
  return provenance;
}

export function writeProvenance({ candidateRoot, outputPath, sourceLock, lockBytes } = {}) {
  const resolvedOutput = requireAbsolute(outputPath, 'output');
  const provenance = collectProvenance({ candidateRoot, sourceLock, lockBytes });
  mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const serialized = `${JSON.stringify(provenance, null, 2)}\n`;
  writeFileSync(resolvedOutput, serialized);
  return provenance;
}

export function parseProvenanceArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== '--candidate-root' && name !== '--output') fail(`unsupported argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${name} requires a value`);
    if (name === '--candidate-root') options.candidateRoot = value;
    else options.outputPath = value;
    index += 1;
  }
  if (!options.candidateRoot) fail('--candidate-root is required');
  if (!options.outputPath) fail('--output is required');
  return options;
}

function main() {
  const options = parseProvenanceArgs(process.argv.slice(2));
  const lockBytes = readFileSync(LOCK_PATH);
  const sourceLock = JSON.parse(lockBytes.toString('utf8'));
  const provenance = writeProvenance({ ...options, sourceLock, lockBytes });
  process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
