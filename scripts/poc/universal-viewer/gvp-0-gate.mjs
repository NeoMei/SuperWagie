#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from './node_modules/ajv/dist/2020.js';

import { verifyAcquiredCandidate } from './acquire-frozen-core.mjs';
import { verifyEvidenceIndex } from './evidence-bundle.mjs';
import { runMaliciousCorpus } from './malicious-corpus.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_POC_ROOT = path.dirname(MODULE_PATH);
const DEFAULT_REPO_ROOT = path.resolve(DEFAULT_POC_ROOT, '..', '..', '..');
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const REMAINING_GATES = Object.freeze(['GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5']);
const BASELINE_ARTIFACTS = Object.freeze([
  'admission-decision.json',
  'build-provenance.json',
  'built-source-policy.json',
  'candidate-npm-audit.raw.json',
  'chunks.json',
  'dependencies.json',
  'manifests/viewer-base.chunk-manifest.poc.json',
  'manifests/viewer-office.chunk-manifest.poc.json',
  'module-graph.json',
  'npm-audit.raw.json',
  'office-smoke.json',
  'README.md',
  'source-policy.json',
  'source-sbom.cdx.json',
]);

class Gvp0Error extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function rejectInput(code, message) {
  throw new Gvp0Error(code, message, 2);
}

function rejectAcceptance(code, message) {
  throw new Gvp0Error(code, message, 1);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hostPlatform() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-15-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-11-x64';
  return null;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !/^[A-Za-z]:[\\/]/u.test(value)
    && !value.split(/[\\/]/u).some((part) => part === '' || part === '.' || part === '..');
}

function readRegularFile(file, root, code = 'GVP0_REQUIRED_EVIDENCE_MISSING') {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) rejectAcceptance(code, `not a regular non-symlink file: ${path.basename(file)}`);
    const real = realpathSync(file);
    if (root && !isContained(realpathSync(root), real)) rejectAcceptance(code, `file escapes its evidence root: ${path.basename(file)}`);
    return readFileSync(real);
  } catch (error) {
    if (error instanceof Gvp0Error) throw error;
    rejectAcceptance(code, `required evidence is unavailable: ${path.basename(file)}`);
  }
}

function readJson(file, root, code) {
  const bytes = readRegularFile(file, root, code);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    rejectAcceptance(code ?? 'GVP0_EVIDENCE_SCHEMA_INVALID', `invalid JSON evidence: ${path.basename(file)}`);
  }
}

function writeJsonExclusive(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return readFileSync(file);
}

function copyBytesExclusive(destination, bytes) {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
}

function assertOutputBoundary(resultsPath, artifactsDir) {
  for (const [value, label] of [[resultsPath, 'results path'], [artifactsDir, 'artifacts directory']]) {
    if (!value || !path.isAbsolute(value)) rejectInput('GVP0_OUTPUT_PATH_INVALID', `${label} must be absolute`);
  }
  let artifactsStat;
  try { artifactsStat = lstatSync(artifactsDir); } catch { rejectInput('GVP0_OUTPUT_PATH_INVALID', 'artifacts directory must already exist'); }
  if (!artifactsStat.isDirectory() || artifactsStat.isSymbolicLink()) {
    rejectInput('GVP0_OUTPUT_PATH_INVALID', 'artifacts directory must be a real non-symlink directory');
  }
  if (readdirSync(artifactsDir).length !== 0) rejectInput('GVP0_OUTPUT_PATH_INVALID', 'artifacts directory must be empty');
  try {
    lstatSync(resultsPath);
    rejectInput('GVP0_OUTPUT_PATH_INVALID', 'results path must not exist');
  } catch (error) {
    if (error instanceof Gvp0Error) throw error;
  }
}

function assertCandidateBoundary(candidateRoot) {
  if (!candidateRoot) rejectInput('GVP0_CANDIDATE_ROOT_REQUIRED', 'candidate root is required');
  if (!path.isAbsolute(candidateRoot)) rejectInput('GVP0_CANDIDATE_ROOT_ABSOLUTE_REQUIRED', 'candidate root must be absolute');
  try {
    const stat = lstatSync(candidateRoot);
    if (stat.isSymbolicLink() || realpathSync(candidateRoot) !== path.resolve(candidateRoot)) {
      rejectInput('GVP0_CANDIDATE_ROOT_SYMLINK_REJECTED', 'candidate root and every path component must not be a symlink');
    }
    if (!stat.isDirectory()) rejectInput('GVP0_CANDIDATE_ROOT_INVALID', 'candidate root must be a directory');
  } catch (error) {
    if (error instanceof Gvp0Error) throw error;
    rejectInput('GVP0_CANDIDATE_ROOT_INVALID', 'candidate root does not exist');
  }
}

function verifyPatchLedger({ ledger, ledgerRoot, sourceLock, receipt }) {
  if (!ledger || ledger.schema_id !== 'superwagie.viewer-patch-ledger.v1' || !Array.isArray(ledger.patches)) {
    rejectAcceptance('GVP0_PATCH_LEDGER_INVALID', 'patch ledger shape is invalid');
  }
  if (ledger.candidate_commit !== receipt.commit
    || ledger.source_tree_sha256 !== sourceLock.source_tree_sha256
    || ledger.post_patch_tree_sha256 !== receipt.archive_sha256) {
    rejectAcceptance('GVP0_PATCH_LEDGER_INVALID', 'patch ledger is not bound to the verified source');
  }
  for (const patch of ledger.patches) {
    if (!patch || !safeRelativePath(patch.file) || !SHA256.test(patch.sha256 ?? '')) {
      rejectAcceptance('GVP0_PATCH_LEDGER_INVALID', 'declared patch binding is invalid');
    }
    const patchPath = path.resolve(ledgerRoot, patch.file);
    let bytes;
    try { bytes = readRegularFile(patchPath, ledgerRoot, 'GVP0_PATCH_FILE_MISSING'); }
    catch (error) { throw error; }
    if (sha256(bytes) !== patch.sha256) rejectAcceptance('GVP0_PATCH_HASH_MISMATCH', `patch hash mismatch: ${patch.file}`);
  }
}

function loadBaseline(pocRoot) {
  const baselineRoot = path.join(pocRoot, 'baseline-evidence');
  const indexPath = path.join(baselineRoot, 'index.json');
  const { value: index } = readJson(indexPath, baselineRoot, 'GVP0_BASELINE_EVIDENCE_STALE');
  const listed = Array.isArray(index.artifacts) ? index.artifacts.map((entry) => entry.logical_name) : [];
  if (JSON.stringify(listed) !== JSON.stringify(BASELINE_ARTIFACTS)) {
    rejectAcceptance('GVP0_BASELINE_EVIDENCE_STALE', 'baseline artifact set is not the reviewed exact set');
  }
  const artifacts = {};
  const parsed = {};
  for (const logicalName of BASELINE_ARTIFACTS) {
    if (!safeRelativePath(logicalName)) rejectAcceptance('GVP0_BASELINE_EVIDENCE_STALE', 'unsafe baseline artifact path');
    const file = path.resolve(baselineRoot, logicalName);
    const bytes = readRegularFile(file, baselineRoot, 'GVP0_BASELINE_EVIDENCE_STALE');
    artifacts[logicalName] = bytes;
    if (logicalName.endsWith('.json')) {
      try { parsed[logicalName] = JSON.parse(bytes.toString('utf8')); }
      catch { rejectAcceptance('GVP0_BASELINE_EVIDENCE_STALE', `baseline JSON invalid: ${logicalName}`); }
    }
  }
  try { verifyEvidenceIndex({ index, artifacts }); }
  catch { rejectAcceptance('GVP0_BASELINE_EVIDENCE_STALE', 'baseline artifact content no longer matches its index'); }
  return { baselineRoot, index, indexBytes: readFileSync(indexPath), artifacts, parsed };
}

function assertAuditSemantics({ parsed, sourceLock, patchBytes, packageLockBytes, receipt, platform }) {
  const admission = parsed['admission-decision.json'];
  const builtPolicy = parsed['built-source-policy.json'];
  const selectedPolicy = parsed['source-policy.json'];
  const chunks = parsed['chunks.json'];
  const dependencies = parsed['dependencies.json'];
  const sbom = parsed['source-sbom.cdx.json'];
  const pocAudit = parsed['npm-audit.raw.json'];
  const candidateAudit = parsed['candidate-npm-audit.raw.json'];
  const provenance = parsed['build-provenance.json'];

  if (admission?.candidate_commit !== receipt.commit || admission?.forbidden_runtime_edges !== builtPolicy?.forbidden_runtime_edges) {
    rejectAcceptance('GVP0_EVIDENCE_IDENTITY_MISMATCH', 'admission and built reachability evidence disagree');
  }
  if (builtPolicy?.decision !== (builtPolicy?.forbidden_runtime_edges === 0 ? 'GO' : 'NO_GO')) {
    rejectAcceptance('GVP0_EVIDENCE_SCHEMA_INVALID', 'built source policy decision is inconsistent');
  }
  if (selectedPolicy?.decision !== 'GO' || selectedPolicy?.forbidden_runtime_edges !== 0) {
    rejectAcceptance('GVP0_EVIDENCE_SCHEMA_INVALID', 'selected-source policy must retain its zero-edge result');
  }
  if (dependencies?.decision !== 'GO' || dependencies?.lockfile_version !== 3) {
    rejectAcceptance('GVP0_DEPENDENCY_LOCK_REJECTED', 'dependency audit or exact lock is invalid');
  }
  let packageLock;
  try { packageLock = JSON.parse(packageLockBytes.toString('utf8')); }
  catch { rejectAcceptance('GVP0_DEPENDENCY_LOCK_REJECTED', 'PoC dependency lock is invalid JSON'); }
  if (packageLock.lockfileVersion !== 3 || dependencies.dependency_count !== Object.keys(packageLock.packages ?? {}).length - 1) {
    rejectAcceptance('GVP0_DEPENDENCY_LOCK_REJECTED', 'dependency audit does not match the exact lock');
  }
  for (const audit of [pocAudit, candidateAudit]) {
    const counts = audit?.metadata?.vulnerabilities;
    if (audit?.auditReportVersion !== 2 || !counts || ['info', 'low', 'moderate', 'high', 'critical', 'total'].some((key) => !Number.isInteger(counts[key]))) {
      rejectAcceptance('GVP0_VULNERABILITY_REPORT_INVALID', 'raw vulnerability report is incomplete');
    }
    if (counts.moderate !== 0 || counts.high !== 0 || counts.critical !== 0) {
      rejectAcceptance('GVP0_VULNERABILITY_POLICY_REJECTED', 'moderate-or-higher production vulnerability remains');
    }
  }
  if (sbom?.bomFormat !== 'CycloneDX' || sbom?.specVersion !== '1.5' || !Array.isArray(sbom.components)) {
    rejectAcceptance('GVP0_SBOM_INVALID', 'CycloneDX SBOM is missing or invalid');
  }
  if (chunks?.decision !== 'GO' || chunks?.poc_manifests_non_loadable !== true) {
    rejectAcceptance('GVP0_CHUNK_EVIDENCE_INVALID', 'PoC chunk audit is invalid');
  }
  const expectedPlatform = platform === 'macos-15-arm64' ? ['darwin', 'arm64'] : ['win32', 'x64'];
  if (provenance?.source_identity?.commit !== receipt.commit
    || provenance?.source_identity?.archive_sha256 !== receipt.archive_sha256
    || provenance?.toolchain?.platform !== expectedPlatform[0]
    || provenance?.toolchain?.arch !== expectedPlatform[1]) {
    rejectAcceptance('GVP0_BUILD_PROVENANCE_INVALID', 'build provenance source or platform identity is stale');
  }
  const requiredInputs = new Map([
    ['module-graph.json', parsed['module-graph.json']],
    ['npm-audit.raw.json', pocAudit],
    ['office-smoke.json', parsed['office-smoke.json']],
    ['package-lock.json', packageLock],
    ['patch-ledger.json', JSON.parse(patchBytes.toString('utf8'))],
    ['source-lock.json', sourceLock],
    ['source-sbom.cdx.json', sbom],
  ]);
  const inputBytes = new Map([
    ['module-graph.json', Buffer.from(`${JSON.stringify(requiredInputs.get('module-graph.json'), null, 2)}\n`)],
    ['npm-audit.raw.json', Buffer.from(`${JSON.stringify(pocAudit, null, 2)}\n`)],
    ['office-smoke.json', Buffer.from(`${JSON.stringify(parsed['office-smoke.json'], null, 2)}\n`)],
    ['package-lock.json', packageLockBytes],
    ['patch-ledger.json', patchBytes],
    ['source-lock.json', Buffer.from(`${JSON.stringify(sourceLock, null, 2)}\n`)],
    ['source-sbom.cdx.json', Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`)],
  ]);
  const provenanceInputs = new Map((provenance.inputs ?? []).map((entry) => [entry.logical_name, entry.sha256]));
  for (const [name, bytes] of inputBytes) {
    if (provenanceInputs.get(name) !== sha256(bytes)) rejectAcceptance('GVP0_BUILD_PROVENANCE_INVALID', `build input hash changed: ${name}`);
  }
  return { admission, builtPolicy, chunks, provenance };
}

function schemaValidators(repoRoot) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) => !Number.isNaN(Date.parse(value)) && /T/u.test(value),
  });
  const resource = JSON.parse(readFileSync(path.join(repoRoot, 'docs/contracts/v1/resource-handle.schema.json'), 'utf8'));
  const chunk = JSON.parse(readFileSync(path.join(repoRoot, 'docs/contracts/v1/viewer-chunk-manifest.schema.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(path.join(repoRoot, 'docs/contracts/v1/viewer-gate-receipt.schema.json'), 'utf8'));
  ajv.addSchema(resource);
  ajv.addSchema(chunk);
  ajv.addSchema(receipt);
  return {
    chunk: ajv.getSchema(`${chunk.$id}#/$defs/ViewerChunkManifest`),
    receipt: ajv.getSchema(`${receipt.$id}#/$defs/ViewerGateReceipt`),
  };
}

function verifyChunkEvidence({ baseline, pocRoot, repoRoot, platform, provenance }) {
  const validators = schemaValidators(repoRoot);
  const manifests = [];
  const copiedOutputs = [];
  for (const chunkId of ['viewer-base', 'viewer-office']) {
    const logicalName = `manifests/${chunkId}.chunk-manifest.poc.json`;
    const envelope = baseline.parsed[logicalName];
    if (envelope?.signature_state !== 'poc_unsigned_not_loadable' || envelope?.production_loadable !== false) {
      rejectAcceptance('GVP0_PRODUCTION_MANIFEST_CLAIM_REJECTED', 'unsigned PoC manifest claimed production loadability or signature');
    }
    if (!validators.chunk(envelope.manifest_candidate)) {
      rejectAcceptance('GVP0_CHUNK_SCHEMA_INVALID', `chunk manifest schema invalid: ${chunkId}`);
    }
    const manifest = envelope.manifest_candidate;
    if (manifest.chunk_id !== chunkId || manifest.platform_id !== platform
      || manifest.signature !== 'poc_unsigned_not_loadable_reserved_sentinel_000') {
      rejectAcceptance('GVP0_CHUNK_MANIFEST_MISMATCH', `chunk manifest identity mismatch: ${chunkId}`);
    }
    if (manifest.build_provenance?.sha256 !== sha256(baseline.artifacts['build-provenance.json'])) {
      rejectAcceptance('GVP0_BUILD_PROVENANCE_INVALID', `chunk build provenance mismatch: ${chunkId}`);
    }
    const actualFiles = new Set();
    for (const binding of manifest.file_hashes ?? []) {
      if (!safeRelativePath(binding.logical_name) || !SHA256.test(binding.sha256 ?? '')) {
        rejectAcceptance('GVP0_CHUNK_MANIFEST_MISMATCH', `unsafe chunk file binding: ${chunkId}`);
      }
      const source = path.resolve(pocRoot, 'dist', chunkId, binding.logical_name);
      const bytes = readRegularFile(source, path.resolve(pocRoot, 'dist', chunkId), 'GVP0_CHUNK_OUTPUT_MISSING');
      if (sha256(bytes) !== binding.sha256) rejectAcceptance('GVP0_ARTIFACT_HASH_MISMATCH', `chunk output hash mismatch: ${binding.logical_name}`);
      actualFiles.add(binding.logical_name);
      copiedOutputs.push({ source, bytes, output: `chunks/${chunkId}/${binding.logical_name}` });
    }
    const provenanceOutputs = new Map((provenance.outputs ?? []).map((entry) => [entry.logical_name, entry.sha256]));
    for (const binding of manifest.file_hashes ?? []) {
      if (provenanceOutputs.get(`${chunkId}/${binding.logical_name}`) !== binding.sha256) {
        rejectAcceptance('GVP0_BUILD_PROVENANCE_INVALID', `output not bound by build provenance: ${chunkId}/${binding.logical_name}`);
      }
    }
    for (const relative of [...(manifest.code ?? []), ...(manifest.assets ?? []), ...(manifest.fonts ?? []), ...(manifest.license_refs ?? []), ...(manifest.notice_refs ?? [])]) {
      if (!actualFiles.has(relative)) rejectAcceptance('GVP0_LICENSE_NOTICE_MISSING', `manifest content is missing a bound output: ${relative}`);
    }
    manifests.push({ path: `artifacts/baseline/${logicalName}`, sha256: sha256(baseline.artifacts[logicalName]) });
  }
  return { manifests, copiedOutputs };
}

function listArtifactBindings(artifactsDir) {
  const result = [];
  const visit = (directory) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) rejectAcceptance('GVP0_ARTIFACT_BINDING_INVALID', 'artifact tree contains a symlink or non-directory');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) rejectAcceptance('GVP0_ARTIFACT_BINDING_INVALID', 'artifact tree contains a symlink');
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        const relative = path.relative(path.dirname(artifactsDir), child).split(path.sep).join('/');
        if (relative !== 'artifacts/evidence-manifest.json') result.push({ path: relative, sha256: sha256(readFileSync(child)) });
      } else rejectAcceptance('GVP0_ARTIFACT_BINDING_INVALID', 'artifact tree contains a non-regular entry');
    }
  };
  visit(artifactsDir);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function noAbsoluteFilesystemPaths(value) {
  if (typeof value === 'string') {
    return !value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value) && !/^\\\\/u.test(value);
  }
  if (Array.isArray(value)) return value.every(noAbsoluteFilesystemPaths);
  if (value && typeof value === 'object') return Object.values(value).every(noAbsoluteFilesystemPaths);
  return true;
}

export function evaluateGvp0Admission({ forbiddenRuntimeEdges, evidenceValid, behaviorPass, requestedVerdict = 'GO' } = {}) {
  const accepted = evidenceValid === true && behaviorPass === true && forbiddenRuntimeEdges === 0 && requestedVerdict === 'GO';
  return {
    verdict: accepted ? 'GO' : 'NO_GO',
    exitCode: accepted ? 0 : 1,
    releaseAdmission: 'NO_GO',
  };
}

export function validateReceiptBundle({ resultsPath, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const errors = [];
  let receipt;
  let runRoot;
  try {
    const resultStat = lstatSync(resultsPath);
    if (!resultStat.isFile() || resultStat.isSymbolicLink()) throw new Error('results must be a regular non-symlink file');
    receipt = JSON.parse(readFileSync(resultsPath, 'utf8'));
    runRoot = path.dirname(resultsPath);
    const validate = schemaValidators(repoRoot).receipt;
    if (!validate(receipt)) errors.push(`receipt schema invalid: ${JSON.stringify(validate.errors)}`);
    if (!/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(receipt.issued_at ?? '') || Number.isNaN(Date.parse(receipt.issued_at))) {
      errors.push('receipt issued_at is not a valid UTC date-time');
    }
  } catch (error) {
    return { valid: false, errors: [`results invalid: ${error.message}`], bindings_checked: 0 };
  }
  const manifestPath = path.join(runRoot, 'artifacts', 'evidence-manifest.json');
  let manifest;
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('evidence manifest must be a regular non-symlink file');
    const bytes = readFileSync(manifestPath);
    if (sha256(bytes) !== receipt.evidence_sha256) errors.push('evidence manifest hash mismatch');
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    errors.push(`evidence manifest invalid: ${error.message}`);
    return { valid: false, errors, bindings_checked: 0 };
  }
  if (manifest.schema_id !== 'superwagie.gvp-0-evidence-manifest.v1') errors.push('evidence manifest schema id mismatch');
  if (manifest.gate_id !== receipt.gate_id || manifest.corpus_id !== receipt.corpus_id || manifest.platform_id !== receipt.platform_id) {
    errors.push('evidence manifest receipt identity mismatch');
  }
  if (manifest.chunk_manifest_set_sha256 !== receipt.chunk_manifest_sha256) errors.push('chunk manifest set hash mismatch');
  const declared = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const seen = new Set();
  for (const binding of declared) {
    if (!binding || !safeRelativePath(binding.path) || !SHA256.test(binding.sha256 ?? '') || seen.has(binding.path)) {
      errors.push('artifact binding path/hash is invalid or duplicated');
      continue;
    }
    seen.add(binding.path);
    const artifact = path.resolve(runRoot, binding.path);
    if (!isContained(runRoot, artifact)) { errors.push('artifact binding escapes run root'); continue; }
    try {
      const stat = lstatSync(artifact);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('must be a regular non-symlink file');
      if (sha256(readFileSync(realpathSync(artifact))) !== binding.sha256) throw new Error('hash mismatch');
    } catch (error) { errors.push(`${binding.path} ${error.message}`); }
  }
  try {
    const actual = listArtifactBindings(path.join(runRoot, 'artifacts'));
    if (JSON.stringify(actual) !== JSON.stringify(declared)) errors.push('artifact manifest has missing, extra, or unsorted bindings');
  } catch (error) { errors.push(error.message); }
  try {
    const summary = JSON.parse(readFileSync(path.join(runRoot, 'artifacts', 'acceptance-summary.json'), 'utf8'));
    if (summary.scope !== 'disposable-admission-poc'
      || summary.production_registry_admitted !== false
      || summary.production_chunk_signed !== false
      || summary.release_admission !== 'NO_GO'
      || JSON.stringify(summary.remaining_gates) !== JSON.stringify(REMAINING_GATES)) {
      errors.push('acceptance summary may not claim Registry, signature, later Gate, or release admission');
    }
  } catch (error) { errors.push(`acceptance summary invalid: ${error.message}`); }
  if (!noAbsoluteFilesystemPaths(receipt) || !noAbsoluteFilesystemPaths(manifest)) errors.push('receipt or evidence manifest contains an absolute filesystem path');
  return { valid: errors.length === 0, errors, bindings_checked: declared.length };
}

export async function runGvp0Gate(options = {}) {
  try {
    const {
      candidateRoot,
      fixture,
      platform,
      resultsPath,
      artifactsDir,
      pocRoot = DEFAULT_POC_ROOT,
      repoRoot = DEFAULT_REPO_ROOT,
      issuedAt = new Date().toISOString(),
    } = options;
    assertOutputBoundary(resultsPath, artifactsDir);
    assertCandidateBoundary(candidateRoot);
    if (fixture !== 'GVP-0-CORE-001') rejectInput('GVP0_FIXTURE_UNSUPPORTED', 'GVP-0 requires fixture GVP-0-CORE-001');
    if (!['macos-15-arm64', 'windows-11-x64'].includes(platform)) rejectInput('GVP0_PLATFORM_INVALID', 'unsupported platform id');
    if (platform !== hostPlatform()) rejectInput('GVP0_PLATFORM_MISMATCH', `requested platform ${platform} does not match this host`);

    const sourceLockPath = path.join(pocRoot, 'source-lock.json');
    const patchLedgerPath = path.join(pocRoot, 'patch-ledger.json');
    const packageLockPath = path.join(pocRoot, 'package-lock.json');
    const sourceLockDocument = readJson(sourceLockPath, pocRoot, 'GVP0_SOURCE_IDENTITY_REJECTED');
    let sourceReceipt;
    try {
      sourceReceipt = verifyAcquiredCandidate({
        candidateRoot,
        sourceLock: sourceLockDocument.value,
        lockBytes: sourceLockDocument.bytes,
      });
    } catch (error) {
      rejectAcceptance('GVP0_SOURCE_IDENTITY_REJECTED', error.message);
    }
    const patchDocument = readJson(patchLedgerPath, pocRoot, 'GVP0_PATCH_LEDGER_INVALID');
    verifyPatchLedger({ ledger: patchDocument.value, ledgerRoot: pocRoot, sourceLock: sourceLockDocument.value, receipt: sourceReceipt });
    const packageLockBytes = readRegularFile(packageLockPath, pocRoot, 'GVP0_DEPENDENCY_LOCK_REJECTED');
    const baseline = loadBaseline(pocRoot);
    const audited = assertAuditSemantics({
      parsed: baseline.parsed,
      sourceLock: sourceLockDocument.value,
      patchBytes: patchDocument.bytes,
      packageLockBytes,
      receipt: sourceReceipt,
      platform,
    });
    const chunkEvidence = verifyChunkEvidence({ baseline, pocRoot, repoRoot, platform, provenance: audited.provenance });

    const hostTest = spawnSync(process.execPath, ['--test', path.join(DEFAULT_POC_ROOT, 'tests', 'host-adapter.test.mjs')], {
      cwd: DEFAULT_POC_ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_offline: 'true' },
    });
    if (hostTest.status !== 0) rejectAcceptance('GVP0_HOST_ADAPTER_TEST_FAILED', hostTest.stderr || hostTest.stdout || 'Host Adapter test failed');

    const maliciousOutput = path.join(artifactsDir, 'malicious-corpus.json');
    const malicious = await runMaliciousCorpus({
      candidateRoot,
      fixtureRoot: path.join(DEFAULT_POC_ROOT, 'fixtures', 'malicious'),
      acceptancePath: path.join(repoRoot, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'acceptance.json'),
      output: maliciousOutput,
      offline: true,
    });
    if (malicious.execution_pass !== true || malicious.behavior?.pass !== true
      || malicious.metrics?.forbidden_runtime_edges !== audited.builtPolicy.forbidden_runtime_edges
      || malicious.candidate?.commit !== sourceReceipt.commit) {
      rejectAcceptance('GVP0_MALICIOUS_BASELINE_INVALID', 'fresh malicious/offline evidence is incomplete or stale');
    }

    const sourceReceiptAfter = verifyAcquiredCandidate({
      candidateRoot,
      sourceLock: sourceLockDocument.value,
      lockBytes: sourceLockDocument.bytes,
    });
    if (JSON.stringify(sourceReceiptAfter) !== JSON.stringify(sourceReceipt)) {
      rejectAcceptance('GVP0_SOURCE_MUTATION_DETECTED', 'candidate identity changed during GVP-0');
    }

    copyBytesExclusive(path.join(artifactsDir, 'source', 'source-lock.json'), sourceLockDocument.bytes);
    copyBytesExclusive(path.join(artifactsDir, 'source', 'patch-ledger.json'), patchDocument.bytes);
    copyBytesExclusive(path.join(artifactsDir, 'source', 'package-lock.json'), packageLockBytes);
    copyBytesExclusive(path.join(artifactsDir, 'source', 'acquisition-receipt.json'), Buffer.from(`${JSON.stringify(sourceReceipt, null, 2)}\n`));
    for (const logicalName of BASELINE_ARTIFACTS) {
      copyBytesExclusive(path.join(artifactsDir, 'baseline', logicalName), baseline.artifacts[logicalName]);
    }
    copyBytesExclusive(path.join(artifactsDir, 'baseline', 'index.json'), baseline.indexBytes);
    for (const output of chunkEvidence.copiedOutputs) copyBytesExclusive(path.join(artifactsDir, output.output), output.bytes);
    copyBytesExclusive(path.join(artifactsDir, 'host-adapter-tests.tap'), Buffer.from(hostTest.stdout, 'utf8'));
    const acceptanceBytes = readRegularFile(
      path.join(repoRoot, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'acceptance.json'),
      path.join(repoRoot, 'fixtures', 'gvp-0', 'GVP-0-CORE-001'),
      'GVP0_ACCEPTANCE_FIXTURE_INVALID',
    );
    copyBytesExclusive(path.join(artifactsDir, 'acceptance.json'), acceptanceBytes);

    const chunkManifestSet = {
      schema_id: 'superwagie.gvp-0-chunk-manifest-set.v1',
      manifests: chunkEvidence.manifests,
    };
    const chunkSetBytes = writeJsonExclusive(path.join(artifactsDir, 'chunk-manifest-set.json'), chunkManifestSet);
    const admission = evaluateGvp0Admission({
      forbiddenRuntimeEdges: audited.builtPolicy.forbidden_runtime_edges,
      evidenceValid: true,
      behaviorPass: malicious.behavior.pass,
      requestedVerdict: audited.admission.decision === 'GO' ? 'GO' : 'NO_GO',
    });
    const summary = {
      schema_id: 'superwagie.gvp-0-acceptance-summary.v1',
      gate: 'GVP-0',
      fixture: 'GVP-0-CORE-001',
      platform,
      scope: 'disposable-admission-poc',
      acceptance_pass: admission.exitCode === 0,
      decision_hint: admission.verdict,
      production_registry_admitted: false,
      production_chunk_signed: false,
      release_admission: 'NO_GO',
      remaining_gates: [...REMAINING_GATES],
      metrics: {
        forbidden_runtime_edges: audited.builtPolicy.forbidden_runtime_edges,
        moderate_or_higher_reachable_vulnerabilities: audited.admission.moderate_or_higher,
        base_office_compressed_bytes: audited.chunks.base_office_compressed_bytes,
        total_compressed_bytes: audited.chunks.total_compressed_bytes,
        host_adapter_tests_passed: true,
        malicious_behavior_passed: true,
      },
      reasons: admission.verdict === 'NO_GO' ? ['TASK3_FORBIDDEN_RUNTIME_EDGES_REMAIN'] : [],
      limitations: [
        'PoC chunk manifests are deliberately unsigned and production-ineligible.',
        `No ${platform === 'macos-15-arm64' ? 'Windows 11 x64' : 'macOS 15 arm64'} receipt is present.`,
        'GVP-1 through GVP-5 remain RESEARCH_REQUIRED and non-executable.',
      ],
    };
    writeJsonExclusive(path.join(artifactsDir, 'acceptance-summary.json'), summary);
    const evidenceManifest = {
      schema_id: 'superwagie.gvp-0-evidence-manifest.v1',
      gate_id: 'GVP-0',
      corpus_id: 'GVP-0-CORE-001',
      platform_id: platform,
      chunk_manifest_set_sha256: sha256(chunkSetBytes),
      artifacts: listArtifactBindings(artifactsDir),
    };
    if (!noAbsoluteFilesystemPaths(evidenceManifest)) rejectAcceptance('GVP0_ABSOLUTE_PATH_DISCLOSURE', 'evidence manifest contains an absolute path');
    const manifestBytes = writeJsonExclusive(path.join(artifactsDir, 'evidence-manifest.json'), evidenceManifest);
    const receipt = {
      receipt_id: `gvp0-core-${platform}-${sha256(manifestBytes).slice(7, 23)}`,
      gate_id: 'GVP-0',
      format_variant_id: 'universal.viewer.core',
      viewer_id: 'omni-viewer-core',
      viewer_version: `${sourceLockDocument.value.version}+${sourceReceipt.commit}`,
      platform_id: platform,
      verdict: admission.verdict,
      corpus_id: 'GVP-0-CORE-001',
      corpus_sha256: sha256(acceptanceBytes),
      chunk_manifest_sha256: sha256(chunkSetBytes),
      evidence_sha256: sha256(manifestBytes),
      issued_at: issuedAt,
    };
    const validateReceipt = schemaValidators(repoRoot).receipt;
    if (!validateReceipt(receipt) || Number.isNaN(Date.parse(receipt.issued_at))) {
      rejectAcceptance('GVP0_RECEIPT_SCHEMA_INVALID', JSON.stringify(validateReceipt.errors));
    }
    writeJsonExclusive(resultsPath, receipt);
    const validation = validateReceiptBundle({ resultsPath, repoRoot });
    if (!validation.valid) rejectAcceptance('GVP0_RECEIPT_BINDING_INVALID', validation.errors.join('; '));
    return { ...admission, receipt, code: admission.verdict === 'GO' ? 'GVP0_ACCEPTED' : 'GVP0_ACCEPTANCE_NO_GO' };
  } catch (error) {
    if (error instanceof Gvp0Error) return { exitCode: error.exitCode, code: error.code, error: error.message };
    return { exitCode: 2, code: 'GVP0_ENVIRONMENT_FAILURE', error: error instanceof Error ? error.message : String(error) };
  }
}

function parseArgs(argv) {
  const values = {};
  const optionNames = {
    '--platform': 'platform',
    '--fixture': 'fixture',
    '--candidate-root': 'candidateRoot',
    '--results-json': 'resultsPath',
    '--artifacts-dir': 'artifactsDir',
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!optionNames[key] || !value) {
      rejectInput('GVP0_ARGUMENTS_INVALID', 'usage: gvp-0-gate.mjs --platform ID --fixture GVP-0-CORE-001 --candidate-root ABS --results-json ABS --artifacts-dir ABS');
    }
    values[optionNames[key]] = value;
  }
  return values;
}

async function main() {
  try {
    const result = await runGvp0Gate(parseArgs(process.argv.slice(2)));
    const stream = result.exitCode === 2 ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify({ code: result.code, verdict: result.receipt?.verdict, error: result.error })}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error.code ?? 'GVP0_ARGUMENTS_INVALID'}: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 2;
  }
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) main();
