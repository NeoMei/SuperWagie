#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from './node_modules/ajv/dist/2020.js';

import { verifyAcquiredCandidate } from './acquire-frozen-core.mjs';
import { verifyEvidenceIndex } from './evidence-bundle.mjs';
import { runMaliciousCorpus } from './malicious-corpus.mjs';
import { auditDependencyData } from './dependency-audit.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_POC_ROOT = path.dirname(MODULE_PATH);
const DEFAULT_REPO_ROOT = path.resolve(DEFAULT_POC_ROOT, '..', '..', '..');
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const LIVE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SUPPLY_CHAIN_TIMEOUT_MS = 15_000;
const MALICIOUS_OUTPUT_MARKER = 'superwagie-viewer-malicious-output-v1\n';
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
const STATIC_GVP0_ARTIFACTS = Object.freeze([
  'artifacts/acceptance-summary.json',
  'artifacts/acceptance.json',
  'artifacts/chunk-manifest-set.json',
  'artifacts/fresh/candidate-npm-audit.raw.json',
  'artifacts/fresh/npm-audit.raw.json',
  'artifacts/fresh/source-sbom.raw.cdx.json',
  'artifacts/fresh/supply-chain-freshness.json',
  'artifacts/host-adapter-tests.tap',
  'artifacts/malicious-corpus.json',
  'artifacts/malicious-corpus.json.superwagie-viewer-malicious-output-owned',
  'artifacts/run-context.json',
  'artifacts/source/acquisition-receipt.json',
  'artifacts/source/candidate-package-lock.json',
  'artifacts/source/package-lock.json',
  'artifacts/source/patch-ledger.json',
  'artifacts/source/source-lock.json',
]);
const EXACT_JSON_KEYS = new Map([
  ['results.json', ['chunk_manifest_sha256', 'corpus_id', 'corpus_sha256', 'evidence_sha256', 'format_variant_id', 'gate_id', 'issued_at', 'platform_id', 'receipt_id', 'verdict', 'viewer_id', 'viewer_version']],
  ['artifacts/acceptance-summary.json', ['acceptance_pass', 'candidate_commit', 'candidate_id', 'candidate_version', 'captured_at', 'corpus_id', 'corpus_sha256', 'decision_hint', 'fixture', 'gate', 'limitations', 'metrics', 'platform', 'production_chunk_signed', 'production_registry_admitted', 'reasons', 'release_admission', 'remaining_gates', 'schema_id', 'scope']],
  ['artifacts/chunk-manifest-set.json', ['manifests', 'schema_id']],
  ['artifacts/evidence-manifest.json', ['artifacts', 'chunk_manifest_set_sha256', 'corpus_id', 'gate_id', 'platform_id', 'schema_id']],
  ['artifacts/fresh/candidate-npm-audit.raw.json', ['auditReportVersion', 'metadata', 'vulnerabilities']],
  ['artifacts/fresh/npm-audit.raw.json', ['auditReportVersion', 'metadata', 'vulnerabilities']],
  ['artifacts/fresh/source-sbom.raw.cdx.json', ['$schema', 'bomFormat', 'components', 'dependencies', 'metadata', 'serialNumber', 'specVersion', 'version']],
  ['artifacts/fresh/supply-chain-freshness.json', ['captured_at', 'checks', 'evidence_issued_at', 'inputs', 'max_age_millis', 'probes', 'schema_id', 'source_commit', 'timeout_millis']],
  ['artifacts/malicious-corpus.json', ['behavior', 'candidate', 'cli_exit_semantics', 'deadline_probe', 'decision', 'execution_pass', 'fixture', 'fixtures', 'metrics', 'offline', 'pass', 'platform', 'reasons', 'schema_id', 'source_integrity', 'status', 'thresholds']],
  ['artifacts/run-context.json', ['candidate_commit', 'candidate_id', 'candidate_version', 'captured_at', 'fixture_id', 'gate_id', 'platform_id', 'schema_id']],
]);
const SECRET_KEY_NAMES = new Set([
  'apikey', 'apitoken', 'accesstoken', 'refreshtoken', 'auth', 'authorization', 'clientsecret',
  'credential', 'credentials', 'cookie', 'cookies', 'password', 'passwd', 'privatekey', 'secret',
]);
const SECRET_ASSIGNMENT_PATTERN = /["']?(?:api[-_ ]?(?:key|token)|access[-_ ]?token|refresh[-_ ]?token|auth(?:orization)?|client[-_ ]?secret|credentials?|cookies?|password|passwd|private[-_ ]?key|secret)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /gh[pousr]_[A-Za-z0-9_]{16,}/gu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/giu,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/giu,
]);

const stringSchema = { type: 'string' };
const booleanSchema = { type: 'boolean' };
const integerSchema = { type: 'integer' };
const stringArraySchema = { type: 'array', items: stringSchema };
const strictObject = (properties, optional = []) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties).filter(key => !optional.includes(key)),
  properties,
});
const hashBindingSchema = strictObject({ path: stringSchema, sha256: stringSchema });
const processIdentitySchema = strictObject({ executable_basename: stringSchema, executable_sha256: stringSchema });
const processTreeSchema = strictObject({
  collector_basename: stringSchema,
  collector_sha256: stringSchema,
  group_isolated: booleanSchema,
  root_observed: booleanSchema,
  observed: { type: 'array', items: processIdentitySchema },
  external_processes: integerSchema,
  forbidden_processes: { type: 'array', items: processIdentitySchema },
  pre_spawn_snapshot: booleanSchema,
  post_exit_snapshot: booleanSchema,
  sample_count: integerSchema,
  sample_failures: integerSchema,
  cleanup_signaled: booleanSchema,
  process_group_survivors_after_cleanup: integerSchema,
  known_descendant_survivors_after_cleanup: integerSchema,
  claim_scope: stringSchema,
  detection_limitations: stringArraySchema,
});
const vulnerabilityViaSchema = {
  oneOf: [
    stringSchema,
    strictObject({
      source: { anyOf: [integerSchema, stringSchema] },
      name: stringSchema,
      dependency: stringSchema,
      title: stringSchema,
      url: stringSchema,
      severity: stringSchema,
      cwe: stringArraySchema,
      cvss: strictObject({ score: { type: 'number' }, vectorString: { type: ['string', 'null'] } }),
      range: stringSchema,
    }),
  ],
};
const npmAuditSchema = strictObject({
  auditReportVersion: integerSchema,
  vulnerabilities: {
    type: 'object',
    propertyNames: { pattern: '^[^\\s/]+$' },
    additionalProperties: strictObject({
      name: stringSchema,
      severity: stringSchema,
      isDirect: booleanSchema,
      via: { type: 'array', items: vulnerabilityViaSchema },
      effects: stringArraySchema,
      range: stringSchema,
      nodes: stringArraySchema,
      fixAvailable: {
        oneOf: [
          booleanSchema,
          strictObject({ name: stringSchema, version: stringSchema, isSemVerMajor: booleanSchema }),
        ],
      },
    }),
  },
  metadata: strictObject({
    vulnerabilities: strictObject({
      info: integerSchema, low: integerSchema, moderate: integerSchema, high: integerSchema,
      critical: integerSchema, total: integerSchema,
    }),
    dependencies: strictObject({
      prod: integerSchema, dev: integerSchema, optional: integerSchema, peer: integerSchema,
      peerOptional: integerSchema, total: integerSchema,
    }),
  }),
});
const generatedArtifactSchemas = new Map([
  ['artifacts/acceptance-summary.json', strictObject({
    schema_id: stringSchema,
    gate: stringSchema,
    fixture: stringSchema,
    corpus_id: stringSchema,
    corpus_sha256: stringSchema,
    platform: stringSchema,
    scope: stringSchema,
    captured_at: stringSchema,
    candidate_id: stringSchema,
    candidate_version: stringSchema,
    candidate_commit: stringSchema,
    acceptance_pass: booleanSchema,
    decision_hint: stringSchema,
    production_registry_admitted: booleanSchema,
    production_chunk_signed: booleanSchema,
    release_admission: stringSchema,
    remaining_gates: stringArraySchema,
    metrics: strictObject({
      forbidden_runtime_edges: integerSchema,
      moderate_or_higher_reachable_vulnerabilities: integerSchema,
      base_office_compressed_bytes: integerSchema,
      total_compressed_bytes: integerSchema,
      host_adapter_tests_passed: booleanSchema,
      malicious_behavior_passed: booleanSchema,
    }),
    reasons: stringArraySchema,
    limitations: stringArraySchema,
  })],
  ['artifacts/chunk-manifest-set.json', strictObject({
    schema_id: stringSchema,
    manifests: { type: 'array', items: hashBindingSchema },
  })],
  ['artifacts/evidence-manifest.json', strictObject({
    schema_id: stringSchema,
    gate_id: stringSchema,
    corpus_id: stringSchema,
    platform_id: stringSchema,
    chunk_manifest_set_sha256: stringSchema,
    artifacts: { type: 'array', items: hashBindingSchema },
  })],
  ['artifacts/fresh/npm-audit.raw.json', npmAuditSchema],
  ['artifacts/fresh/candidate-npm-audit.raw.json', npmAuditSchema],
  ['artifacts/fresh/supply-chain-freshness.json', strictObject({
    schema_id: stringSchema,
    captured_at: stringSchema,
    evidence_issued_at: stringSchema,
    max_age_millis: integerSchema,
    timeout_millis: integerSchema,
    source_commit: stringSchema,
    inputs: strictObject({
      poc_package_lock_sha256: stringSchema,
      candidate_package_lock_sha256: stringSchema,
      baseline_index_sha256: stringSchema,
      build_provenance_sha256: stringSchema,
    }),
    probes: { type: 'array', items: strictObject({
      role: stringSchema,
      command: stringSchema,
      captured_at: stringSchema,
      exit_code: integerSchema,
      raw_sha256: stringSchema,
    }) },
    checks: strictObject({
      poc_production_audit: stringSchema,
      candidate_production_audit: stringSchema,
      cyclonedx_matches_provenance_input: booleanSchema,
      build_outputs_match_provenance: booleanSchema,
    }),
  })],
  ['artifacts/run-context.json', strictObject({
    schema_id: stringSchema,
    gate_id: stringSchema,
    fixture_id: stringSchema,
    platform_id: stringSchema,
    candidate_id: stringSchema,
    candidate_version: stringSchema,
    candidate_commit: stringSchema,
    captured_at: stringSchema,
  })],
  ['artifacts/malicious-corpus.json', strictObject({
    schema_id: stringSchema,
    fixture: stringSchema,
    platform: stringSchema,
    offline: booleanSchema,
    execution_pass: booleanSchema,
    behavior: strictObject({ pass: booleanSchema, status: stringSchema }),
    pass: booleanSchema,
    status: stringSchema,
    decision: stringSchema,
    reasons: stringArraySchema,
    candidate: strictObject({
      commit: stringSchema,
      tree: stringSchema,
      archive_sha256: stringSchema,
      materialized_tree_sha256: stringSchema,
      source_lock_sha256: stringSchema,
      source_hash_before: stringSchema,
      source_hash_after: stringSchema,
      admission_decision: stringSchema,
      pristine_before: booleanSchema,
      pristine_after: booleanSchema,
    }),
    thresholds: strictObject({
      external_processes: integerSchema,
      network_requests: integerSchema,
      filesystem_paths_exposed: integerSchema,
      source_mutations: integerSchema,
      moderate_or_higher_reachable_vulnerabilities: integerSchema,
      forbidden_runtime_edges: integerSchema,
      unexpected_fixture_outcomes: integerSchema,
      base_office_compressed_max_bytes: integerSchema,
      all_chunks_compressed_max_bytes: integerSchema,
    }),
    metrics: strictObject({
      external_processes: integerSchema,
      network_requests: integerSchema,
      filesystem_paths_exposed: integerSchema,
      source_mutations: integerSchema,
      moderate_or_higher_reachable_vulnerabilities: integerSchema,
      forbidden_runtime_edges: integerSchema,
      unexpected_fixture_outcomes: integerSchema,
      base_office_compressed_max_bytes: integerSchema,
      all_chunks_compressed_max_bytes: integerSchema,
    }),
    fixtures: { type: 'array', items: strictObject({
      fixture_id: stringSchema,
      file: stringSchema,
      sha256: stringSchema,
      expected_outcome: stringSchema,
      outcome: stringSchema,
      diagnostics: stringArraySchema,
      pass: booleanSchema,
      source_hash_unchanged: booleanSchema,
      network_requests: integerSchema,
      created_paths: integerSchema,
      parser_dispatches: integerSchema,
      expanded_bytes: integerSchema,
      metadata_rejected_before_expansion: booleanSchema,
      sanitized_sha256: stringSchema,
      process_tree: processTreeSchema,
    }, ['metadata_rejected_before_expansion', 'sanitized_sha256']) },
    deadline_probe: strictObject({
      timed_out: booleanSchema,
      killed: booleanSchema,
      child_alive_after_kill: booleanSchema,
      process_tree: processTreeSchema,
    }),
    source_integrity: strictObject({ post_atomic_write_recheck_required_for_successful_runner_return: booleanSchema }),
    cli_exit_semantics: strictObject({
      runner_exit_zero_means: stringSchema,
      aggregate_pass_remains_false_while_admission_is_no_go: booleanSchema,
    }),
  })],
]);
const generatedArtifactAjv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
const generatedArtifactValidators = new Map(
  [...generatedArtifactSchemas].map(([logicalName, schema]) => [logicalName, generatedArtifactAjv.compile(schema)]),
);

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

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sortedKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

function sameKeys(value, expected) {
  return JSON.stringify(sortedKeys(value)) === JSON.stringify([...expected].sort());
}

function hasSecretValue(text) {
  return SECRET_VALUE_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function normalizedSecretKey(value) {
  return String(value).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function isSecretKey(value) {
  return SECRET_KEY_NAMES.has(normalizedSecretKey(value));
}

function scanJsonSecrets(value, location = '$', errors = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanJsonSecrets(entry, `${location}[${index}]`, errors));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (isSecretKey(key)) errors.push(`secret-bearing key at ${location}.${key}`);
      scanJsonSecrets(entry, `${location}.${key}`, errors);
    }
  } else if (typeof value === 'string' && hasSecretValue(value)) {
    errors.push(`secret-bearing value at ${location}`);
  }
  return errors;
}

function artifactContentErrors(logicalName, bytes) {
  const errors = [];
  const text = Buffer.from(bytes).toString('utf8');
  if (hasSecretValue(text)) errors.push(`${logicalName} contains a secret-like value`);
  if (logicalName.endsWith('.json')) {
    let document;
    try { document = JSON.parse(text); }
    catch { return [...errors, `${logicalName} is invalid JSON`]; }
    errors.push(...scanJsonSecrets(document).map(error => `${logicalName} ${error}`));
    const allowedKeys = EXACT_JSON_KEYS.get(logicalName);
    if (allowedKeys) {
      const exact = logicalName === 'artifacts/fresh/source-sbom.raw.cdx.json'
        ? sameKeys(document, allowedKeys) || sameKeys(document, allowedKeys.filter(key => key !== 'serialNumber'))
        : sameKeys(document, allowedKeys);
      if (!exact) errors.push(`${logicalName} fields are not exact or contain an undeclared top-level field`);
    }
    const validateGeneratedArtifact = generatedArtifactValidators.get(logicalName);
    if (validateGeneratedArtifact && !validateGeneratedArtifact(document)) {
      const details = (validateGeneratedArtifact.errors ?? [])
        .map(error => `${error.instancePath || '$'} ${error.message}`)
        .join(', ');
      errors.push(`${logicalName} nested schema is not exact: ${details}`);
    }
    if (logicalName.endsWith('npm-audit.raw.json')) {
      if (!sameKeys(document.metadata, ['dependencies', 'vulnerabilities'])
        || !sameKeys(document.metadata?.vulnerabilities, ['critical', 'high', 'info', 'low', 'moderate', 'total'])
        || !sameKeys(document.metadata?.dependencies, ['dev', 'optional', 'peer', 'peerOptional', 'prod', 'total'])) {
        errors.push(`${logicalName} audit metadata fields are not exact`);
      }
    }
    if (logicalName === 'artifacts/fresh/supply-chain-freshness.json') {
      if (!sameKeys(document, EXACT_JSON_KEYS.get(logicalName))
        || !sameKeys(document.inputs, ['baseline_index_sha256', 'build_provenance_sha256', 'candidate_package_lock_sha256', 'poc_package_lock_sha256'])
        || !sameKeys(document.checks, ['build_outputs_match_provenance', 'candidate_production_audit', 'cyclonedx_matches_provenance_input', 'poc_production_audit'])
        || !Array.isArray(document.probes)
        || document.probes.some(probe => !sameKeys(probe, ['captured_at', 'command', 'exit_code', 'raw_sha256', 'role']))) {
        errors.push(`${logicalName} fields are not exact`);
      }
    }
  }
  return errors;
}

export function sanitizeDiagnostic(value) {
  let text = String(value ?? 'environment failure');
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  text = text.replace(SECRET_ASSIGNMENT_PATTERN, '[REDACTED_SECRET]');
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, '[REDACTED_SECRET]');
  }
  return text
    .replace(/\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*=[^\s,;]+/gu, '[REDACTED_ENV]')
    .replace(/file:\/\/\/[^\s,;:"']+/gu, '[REDACTED_PATH]')
    .replace(/(?<![\p{L}\p{N}._/-])\/(?!\/)[^\s,;:"']+/gu, '[REDACTED_PATH]')
    .replace(/[A-Za-z]:[\\/](?:[^\s,;:"']+[\\/]?)+/gu, '[REDACTED_PATH]')
    .slice(0, 512);
}

function requiredGvp0ArtifactPaths(chunkArtifactPaths) {
  return [...new Set([
    ...STATIC_GVP0_ARTIFACTS,
    ...BASELINE_ARTIFACTS.map(name => `artifacts/baseline/${name}`),
    'artifacts/baseline/index.json',
    ...chunkArtifactPaths,
  ])].sort();
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

function inodeIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function createOwnedOutputCapability({ resultsPath, artifactsDir, artifactPaths }) {
  const runRoot = path.dirname(resultsPath);
  if (path.resolve(artifactsDir) !== path.join(path.resolve(runRoot), 'artifacts')) {
    rejectInput('GVP0_OUTPUT_PATH_INVALID', 'artifacts directory must be the run-root artifacts directory');
  }
  const files = new Map([
    ['results.json', resultsPath],
    ...[...artifactPaths, 'artifacts/evidence-manifest.json'].map(logicalName => [logicalName, path.join(runRoot, logicalName)]),
  ]);
  const directories = new Set([runRoot, artifactsDir]);
  for (const file of files.values()) {
    let directory = path.dirname(file);
    while (isContained(runRoot, directory) && directory !== runRoot) {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    if (directory !== runRoot && directory !== artifactsDir) mkdirSync(directory, { mode: 0o700 });
  }
  const directoryIdentities = new Map([...directories].map(directory => [directory, inodeIdentity(lstatSync(directory))]));
  const handles = new Map();
  try {
    for (const [logicalName, file] of files) {
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
      const fd = openSync(file, flags, 0o600);
      handles.set(logicalName, { fd, file, identity: inodeIdentity(fstatSync(fd)), written: false, bytes: null });
    }
  } catch (error) {
    for (const handle of handles.values()) closeSync(handle.fd);
    rejectInput('GVP0_OUTPUT_RESERVATION_FAILED', sanitizeDiagnostic(error.message));
  }
  const capability = {
    write(logicalName, value) {
      const handle = handles.get(logicalName);
      if (!handle || handle.written) rejectInput('GVP0_OUTPUT_CAPABILITY_INVALID', `output capability unavailable: ${logicalName}`);
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const contentErrors = artifactContentErrors(logicalName, bytes);
      if (contentErrors.length > 0) rejectAcceptance('GVP0_ARTIFACT_CONTENT_REJECTED', contentErrors.join('; '));
      ftruncateSync(handle.fd, 0);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(handle.fd, bytes, offset, bytes.length - offset, offset);
      fsyncSync(handle.fd);
      handle.written = true;
      handle.bytes = bytes;
      return bytes;
    },
    artifactBindings() {
      const expected = [...artifactPaths].sort((left, right) => left.localeCompare(right));
      if (expected.some(logicalName => !handles.get(logicalName)?.written)) {
        rejectAcceptance('GVP0_ARTIFACT_BINDING_INVALID', 'not every reserved artifact was written');
      }
      return expected.map(logicalName => ({ path: logicalName, sha256: sha256(handles.get(logicalName).bytes) }));
    },
    assertPublicIdentity() {
      try {
        for (const [directory, identity] of directoryIdentities) {
          const stat = lstatSync(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink() || inodeIdentity(stat) !== identity
            || realpathSync(directory) !== normalizedCanonicalSpelling(directory)) throw new Error('directory identity changed');
        }
        for (const handle of handles.values()) {
          const stat = lstatSync(handle.file);
          if (!stat.isFile() || stat.isSymbolicLink() || inodeIdentity(stat) !== handle.identity) throw new Error('file identity changed');
        }
      } catch {
        rejectInput('GVP0_OUTPUT_IDENTITY_CHANGED', 'reserved output identity changed during execution');
      }
    },
    close() {
      for (const handle of handles.values()) closeSync(handle.fd);
    },
  };
  capability.assertPublicIdentity();
  return capability;
}

function normalizedCanonicalSpelling(value) {
  const resolved = path.resolve(value);
  if (process.platform !== 'darwin') return resolved;
  if (resolved === '/var' || resolved.startsWith('/var/')) return `/private${resolved}`;
  if (resolved === '/tmp' || resolved.startsWith('/tmp/')) return `/private${resolved}`;
  return resolved;
}

function sameInode(left, right) {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function assertOutputBoundary({ resultsPath, artifactsDir, protectedRoots, protectedFiles }) {
  for (const [value, label] of [[resultsPath, 'results path'], [artifactsDir, 'artifacts directory']]) {
    if (!value || !path.isAbsolute(value)) rejectInput('GVP0_OUTPUT_PATH_INVALID', `${label} must be absolute`);
    if (value.split(/[\\/]/u).includes('..')) rejectInput('GVP0_OUTPUT_DOT_SEGMENT_REJECTED', `${label} contains a dot-dot segment`);
  }
  let artifactsStat;
  try { artifactsStat = lstatSync(artifactsDir); } catch { rejectInput('GVP0_OUTPUT_PATH_INVALID', 'artifacts directory must already exist'); }
  if (!artifactsStat.isDirectory() || artifactsStat.isSymbolicLink()) {
    rejectInput('GVP0_OUTPUT_PATH_INVALID', 'artifacts directory must be a real non-symlink directory');
  }
  if (readdirSync(artifactsDir).length !== 0) rejectInput('GVP0_OUTPUT_PATH_INVALID', 'artifacts directory must be empty');
  let artifactsReal;
  let resultsParentReal;
  try {
    artifactsReal = realpathSync(artifactsDir);
    resultsParentReal = realpathSync(path.dirname(resultsPath));
  } catch { rejectInput('GVP0_OUTPUT_PATH_INVALID', 'output parents must already exist'); }
  if (artifactsReal !== normalizedCanonicalSpelling(artifactsDir)
    || resultsParentReal !== normalizedCanonicalSpelling(path.dirname(resultsPath))) {
    rejectInput('GVP0_OUTPUT_SYMLINK_REJECTED', 'output path may not traverse a symlink');
  }
  const resultsReal = path.join(resultsParentReal, path.basename(resultsPath));
  const protectedRealRoots = protectedRoots.map(root => realpathSync(root));
  if (protectedRealRoots.some(root => isContained(root, artifactsReal) || isContained(root, resultsReal))) {
    rejectInput('GVP0_OUTPUT_ALIASES_SOURCE', 'output path overlaps candidate or fixture source');
  }
  if (isContained(artifactsReal, resultsReal)) rejectInput('GVP0_OUTPUT_PATH_INVALID', 'results may not be written inside artifacts');
  try {
    lstatSync(resultsPath);
    if (protectedFiles.some(file => sameInode(resultsPath, file))) {
      rejectInput('GVP0_OUTPUT_ALIASES_SOURCE', 'results path aliases a protected source file');
    }
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

function sanitizeSbom(raw) {
  const value = structuredClone(raw);
  delete value.serialNumber;
  if (value.metadata) delete value.metadata.timestamp;
  return value;
}

function defaultSupplyChainExecutor({ args, cwd, timeoutMs }) {
  const offline = process.env.npm_config_offline ?? process.env.NPM_CONFIG_OFFLINE ?? '';
  if (/^(?:1|true)$/iu.test(offline)) {
    return {
      status: null,
      stdout: '',
      stderr: 'npm offline mode cannot establish current registry audit evidence',
      error: { code: 'OFFLINE_NOT_FRESH' },
    };
  }
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: process.env,
  });
}

function parseLiveJson(result, role) {
  if (result?.error || result?.status === null || typeof result?.stdout !== 'string' || result.stdout.trim() === '') {
    rejectInput('GVP0_LIVE_AUDIT_UNAVAILABLE', `${role} did not complete within the bounded environment contract`);
  }
  try { return JSON.parse(result.stdout); }
  catch { rejectInput('GVP0_LIVE_AUDIT_UNAVAILABLE', `${role} did not return complete JSON`); }
}

function validateAuditMetadata(audit, role) {
  const counts = audit?.metadata?.vulnerabilities;
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  if (audit?.auditReportVersion !== 2 || !audit.vulnerabilities || typeof audit.vulnerabilities !== 'object'
    || !counts || severities.some(key => !Number.isInteger(counts[key])) || !Number.isInteger(counts.total)
    || severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total) {
    rejectInput('GVP0_LIVE_AUDIT_UNAVAILABLE', `${role} audit metadata is missing or internally inconsistent`);
  }
}

function assertFreshTimestamp(timestamp, reference, code = 'GVP0_LIVE_EVIDENCE_STALE') {
  const actual = Date.parse(timestamp);
  const now = Date.parse(reference);
  if (!Number.isFinite(actual) || !Number.isFinite(now)
    || now - actual > LIVE_EVIDENCE_MAX_AGE_MS || actual - now > FUTURE_CLOCK_SKEW_MS) {
    rejectInput(code, 'live evidence timestamp is outside the admitted freshness window');
  }
}

function collectFreshSupplyChainEvidence({
  pocRoot,
  candidateRoot,
  baseline,
  runtimeLock,
  candidateLock,
  runtimeLockBytes,
  candidateLockBytes,
  issuedAt,
  now,
  executor = defaultSupplyChainExecutor,
}) {
  const policy = JSON.parse(readRegularFile(
    path.join(pocRoot, 'fixtures', 'dependency-policy.json'),
    path.join(pocRoot, 'fixtures'),
    'GVP0_DEPENDENCY_POLICY_INVALID',
  ).toString('utf8'));
  assertFreshTimestamp(issuedAt, now());
  const definitions = [
    { role: 'poc-production-audit', args: ['audit', '--omit=dev', '--json'], cwd: pocRoot },
    { role: 'candidate-production-audit', args: ['audit', '--omit=dev', '--json'], cwd: candidateRoot },
    { role: 'poc-cyclonedx-sbom', args: ['sbom', '--package-lock-only', '--omit=dev', '--omit=optional', '--sbom-format', 'cyclonedx'], cwd: pocRoot },
  ];
  const runs = definitions.map(definition => {
    const result = executor({ ...definition, timeoutMs: SUPPLY_CHAIN_TIMEOUT_MS });
    const capturedAt = typeof result?.capturedAt === 'string' ? result.capturedAt : now();
    assertFreshTimestamp(capturedAt, now());
    const document = parseLiveJson(result, definition.role);
    return {
      ...definition,
      status: result.status,
      capturedAt,
      document,
      bytes: Buffer.from(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`),
    };
  });
  const pocAudit = runs[0];
  const candidateAudit = runs[1];
  for (const auditRun of [pocAudit, candidateAudit]) validateAuditMetadata(auditRun.document, auditRun.role);
  const pocDecision = auditDependencyData({ lock: runtimeLock, audit: pocAudit.document, policy, now: issuedAt });
  const candidateDecision = auditDependencyData({ lock: candidateLock, audit: candidateAudit.document, policy, now: issuedAt });
  const liveDependencyPass = pocDecision.moderate_or_higher === 0 && candidateDecision.moderate_or_higher === 0
    && pocDecision.decision === 'GO' && candidateDecision.decision === 'GO';
  if ((pocAudit.status !== 0 || candidateAudit.status !== 0) && liveDependencyPass) {
    rejectInput('GVP0_LIVE_AUDIT_UNAVAILABLE', 'npm audit failed without a complete vulnerability finding');
  }
  const sbomRun = runs[2];
  if (sbomRun.status !== 0 || sbomRun.document?.bomFormat !== 'CycloneDX' || sbomRun.document?.specVersion !== '1.5') {
    rejectInput('GVP0_LIVE_AUDIT_UNAVAILABLE', 'fresh CycloneDX generation did not complete');
  }
  const sanitizedSbomBytes = Buffer.from(`${JSON.stringify(sanitizeSbom(sbomRun.document), null, 2)}\n`);
  const sbomMatches = sha256(sanitizedSbomBytes) === sha256(baseline.artifacts['source-sbom.cdx.json']);
  const capturedAt = now();
  assertFreshTimestamp(capturedAt, issuedAt);
  return {
    raw: {
      'fresh/npm-audit.raw.json': pocAudit.bytes,
      'fresh/candidate-npm-audit.raw.json': candidateAudit.bytes,
      'fresh/source-sbom.raw.cdx.json': sbomRun.bytes,
    },
    attestation: {
      schema_id: 'superwagie.gvp-0-supply-chain-freshness.v1',
      captured_at: capturedAt,
      evidence_issued_at: issuedAt,
      max_age_millis: LIVE_EVIDENCE_MAX_AGE_MS,
      timeout_millis: SUPPLY_CHAIN_TIMEOUT_MS,
      source_commit: baseline.parsed['admission-decision.json'].candidate_commit,
      inputs: {
        poc_package_lock_sha256: sha256(runtimeLockBytes),
        candidate_package_lock_sha256: sha256(candidateLockBytes),
        baseline_index_sha256: sha256(baseline.indexBytes),
        build_provenance_sha256: sha256(baseline.artifacts['build-provenance.json']),
      },
      probes: runs.map(run => ({
        role: run.role,
        command: `npm ${run.args.join(' ')}`,
        captured_at: run.capturedAt,
        exit_code: run.status,
        raw_sha256: sha256(run.bytes),
      })),
      checks: {
        poc_production_audit: pocDecision.decision,
        candidate_production_audit: candidateDecision.decision,
        cyclonedx_matches_provenance_input: sbomMatches,
        build_outputs_match_provenance: true,
      },
    },
    rejection: !liveDependencyPass
      ? { code: 'GVP0_LIVE_VULNERABILITY_REJECTED', message: 'fresh production dependency evidence is not admissible' }
      : !sbomMatches
        ? { code: 'GVP0_LIVE_SBOM_MISMATCH', message: 'fresh CycloneDX SBOM differs from the provenance-bound baseline' }
        : null,
  };
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

function gvp0AuthorityProfile(repoRoot) {
  const pocRoot = path.join(repoRoot, 'scripts', 'poc', 'universal-viewer');
  const sourceLockBytes = readFileSync(path.join(pocRoot, 'source-lock.json'));
  const patchLedgerBytes = readFileSync(path.join(pocRoot, 'patch-ledger.json'));
  const packageLockBytes = readFileSync(path.join(pocRoot, 'package-lock.json'));
  const sourceLock = JSON.parse(sourceLockBytes.toString('utf8'));
  const candidateRoot = path.join(pocRoot, '.candidate', 'source');
  const candidateLockBytes = readFileSync(path.join(candidateRoot, 'package-lock.json'));
  const acquisition = verifyAcquiredCandidate({ candidateRoot, sourceLock, lockBytes: sourceLockBytes });
  const acceptanceBytes = readFileSync(path.join(repoRoot, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'acceptance.json'));
  const acceptance = JSON.parse(acceptanceBytes.toString('utf8'));
  const baseline = loadBaseline(pocRoot);
  const chunkArtifactPaths = [];
  const immutableHashes = new Map([
    ['artifacts/acceptance.json', sha256(acceptanceBytes)],
    ['artifacts/source/package-lock.json', sha256(packageLockBytes)],
    ['artifacts/source/candidate-package-lock.json', sha256(candidateLockBytes)],
    ['artifacts/source/patch-ledger.json', sha256(patchLedgerBytes)],
    ['artifacts/source/source-lock.json', sha256(sourceLockBytes)],
    ['artifacts/baseline/index.json', sha256(baseline.indexBytes)],
    ['artifacts/malicious-corpus.json.superwagie-viewer-malicious-output-owned', sha256(Buffer.from(MALICIOUS_OUTPUT_MARKER))],
    ...BASELINE_ARTIFACTS.map(name => [`artifacts/baseline/${name}`, sha256(baseline.artifacts[name])]),
  ]);
  const chunkManifests = [];
  for (const chunkId of ['viewer-base', 'viewer-office']) {
    const logicalName = `manifests/${chunkId}.chunk-manifest.poc.json`;
    const envelope = baseline.parsed[logicalName];
    chunkManifests.push({ path: `artifacts/baseline/${logicalName}`, sha256: sha256(baseline.artifacts[logicalName]) });
    for (const binding of envelope.manifest_candidate.file_hashes) {
      const artifactPath = `artifacts/chunks/${chunkId}/${binding.logical_name}`;
      chunkArtifactPaths.push(artifactPath);
      immutableHashes.set(artifactPath, binding.sha256);
    }
  }
  const chunkManifestSet = { schema_id: 'superwagie.gvp-0-chunk-manifest-set.v1', manifests: chunkManifests };
  const chunkManifestSetBytes = Buffer.from(`${JSON.stringify(chunkManifestSet, null, 2)}\n`);
  immutableHashes.set('artifacts/chunk-manifest-set.json', sha256(chunkManifestSetBytes));
  return {
    pocRoot,
    sourceLock,
    sourceLockBytes,
    packageLockBytes,
    candidateLockBytes,
    acquisition,
    acceptance,
    acceptanceBytes,
    baseline,
    requiredArtifacts: requiredGvp0ArtifactPaths(chunkArtifactPaths),
    immutableHashes,
    chunkManifestSet,
    chunkManifestSetSha256: sha256(chunkManifestSetBytes),
    viewerId: 'omni-viewer-core',
    viewerVersion: `${sourceLock.version}+${sourceLock.commit}`,
  };
}

function validateExactGvp0Contract({ receipt, manifest, runRoot, declared, repoRoot, now, errors }) {
  let authority;
  try { authority = gvp0AuthorityProfile(repoRoot); }
  catch (error) { errors.push(`authoritative GVP-0 inputs unavailable: ${error.message}`); return; }
  const paths = declared.map(binding => binding.path).sort();
  if (JSON.stringify(paths) !== JSON.stringify(authority.requiredArtifacts)) {
    errors.push('required artifact set does not exactly match GVP-0-CORE-001');
  }
  const bindings = new Map(declared.map(binding => [binding.path, binding.sha256]));
  if (declared.some(binding => JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(['path', 'sha256']))) {
    errors.push('artifact bindings must contain only path and sha256');
  }
  for (const [artifactPath, expectedHash] of authority.immutableHashes) {
    if (bindings.get(artifactPath) !== expectedHash) errors.push(`authoritative artifact mismatch: ${artifactPath}`);
  }
  const readArtifact = relativePath => {
    try { return JSON.parse(readFileSync(path.join(runRoot, relativePath), 'utf8')); }
    catch (error) { errors.push(`${relativePath} invalid JSON: ${error.message}`); return null; }
  };
  const summary = readArtifact('artifacts/acceptance-summary.json');
  const context = readArtifact('artifacts/run-context.json');
  const acquisition = readArtifact('artifacts/source/acquisition-receipt.json');
  const candidateLock = readArtifact('artifacts/source/candidate-package-lock.json');
  const malicious = readArtifact('artifacts/malicious-corpus.json');
  const freshness = readArtifact('artifacts/fresh/supply-chain-freshness.json');
  const livePocAudit = readArtifact('artifacts/fresh/npm-audit.raw.json');
  const liveCandidateAudit = readArtifact('artifacts/fresh/candidate-npm-audit.raw.json');
  const liveSbom = readArtifact('artifacts/fresh/source-sbom.raw.cdx.json');
  const chunkSet = readArtifact('artifacts/chunk-manifest-set.json');
  const expectedPlatform = authority.baseline.parsed['build-provenance.json'].toolchain.platform === 'darwin'
    ? 'macos-15-arm64'
    : 'windows-11-x64';
  const expectedVerdict = authority.baseline.parsed['built-source-policy.json'].forbidden_runtime_edges === 0
    && malicious?.behavior?.pass === true ? 'GO' : 'NO_GO';
  const expectedReceipt = {
    gate_id: 'GVP-0',
    format_variant_id: 'universal.viewer.core',
    viewer_id: authority.viewerId,
    viewer_version: authority.viewerVersion,
    platform_id: expectedPlatform,
    verdict: expectedVerdict,
    corpus_id: 'GVP-0-CORE-001',
    corpus_sha256: sha256(authority.acceptanceBytes),
    chunk_manifest_sha256: authority.chunkManifestSetSha256,
  };
  for (const [field, expected] of Object.entries(expectedReceipt)) {
    if (receipt[field] !== expected) errors.push(`GVP-0 receipt ${field} differs from authoritative fixture`);
  }
  if (receipt.receipt_id !== `gvp0-core-${expectedPlatform}-${receipt.evidence_sha256.slice(7, 23)}`) {
    errors.push('GVP-0 receipt id is not derived from its evidence binding');
  }
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify([
    'artifacts', 'chunk_manifest_set_sha256', 'corpus_id', 'gate_id', 'platform_id', 'schema_id',
  ])) errors.push('GVP-0 evidence manifest fields are not exact');
  if (manifest.gate_id !== expectedReceipt.gate_id || manifest.corpus_id !== expectedReceipt.corpus_id
    || manifest.platform_id !== expectedReceipt.platform_id || manifest.chunk_manifest_set_sha256 !== expectedReceipt.chunk_manifest_sha256) {
    errors.push('GVP-0 evidence manifest identity differs from authoritative fixture');
  }
  if (JSON.stringify(chunkSet) !== JSON.stringify(authority.chunkManifestSet)) errors.push('GVP-0 Chunk Manifest set is not authoritative');
  const timestamp = Date.parse(receipt.issued_at);
  const reference = Date.parse(now);
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)
    || reference - timestamp > LIVE_EVIDENCE_MAX_AGE_MS || timestamp - reference > FUTURE_CLOCK_SKEW_MS) {
    errors.push('GVP-0 receipt is stale or future-dated');
  }
  const summaryKeys = [
    'acceptance_pass', 'candidate_commit', 'candidate_id', 'candidate_version', 'captured_at', 'corpus_id',
    'corpus_sha256', 'decision_hint', 'fixture', 'gate', 'limitations', 'metrics', 'platform',
    'production_chunk_signed', 'production_registry_admitted', 'reasons', 'release_admission',
    'remaining_gates', 'schema_id', 'scope',
  ];
  const summaryChecks = summary && [
    JSON.stringify(Object.keys(summary).sort()) === JSON.stringify(summaryKeys),
    summary.schema_id === 'superwagie.gvp-0-acceptance-summary.v1',
    summary.gate === 'GVP-0', summary.fixture === 'GVP-0-CORE-001', summary.corpus_id === 'GVP-0-CORE-001',
    summary.corpus_sha256 === expectedReceipt.corpus_sha256, summary.platform === expectedPlatform,
    summary.scope === 'disposable-admission-poc', summary.captured_at === receipt.issued_at,
    summary.candidate_id === authority.viewerId, summary.candidate_version === authority.viewerVersion,
    summary.candidate_commit === authority.sourceLock.commit,
    summary.acceptance_pass === (expectedVerdict === 'GO'), summary.decision_hint === expectedVerdict,
    summary.production_registry_admitted === false, summary.production_chunk_signed === false,
    summary.release_admission === 'NO_GO', JSON.stringify(summary.remaining_gates) === JSON.stringify(REMAINING_GATES),
    summary.metrics?.forbidden_runtime_edges === authority.baseline.parsed['built-source-policy.json'].forbidden_runtime_edges,
    summary.metrics?.moderate_or_higher_reachable_vulnerabilities === 0,
    summary.metrics?.base_office_compressed_bytes === authority.baseline.parsed['chunks.json'].base_office_compressed_bytes,
    summary.metrics?.total_compressed_bytes === authority.baseline.parsed['chunks.json'].total_compressed_bytes,
    summary.metrics?.host_adapter_tests_passed === true, summary.metrics?.malicious_behavior_passed === true,
    JSON.stringify(summary.reasons) === JSON.stringify(expectedVerdict === 'NO_GO' ? ['TASK3_FORBIDDEN_RUNTIME_EDGES_REMAIN'] : []),
    Array.isArray(summary.limitations) && summary.limitations.length === 3,
  ];
  if (!summaryChecks || summaryChecks.some(value => !value)) errors.push('GVP-0 acceptance summary is incoherent with authoritative evidence');
  if (!context || context.gate_id !== 'GVP-0' || context.fixture_id !== 'GVP-0-CORE-001'
    || context.platform_id !== expectedPlatform || context.candidate_id !== authority.viewerId
    || context.candidate_version !== authority.viewerVersion || context.candidate_commit !== authority.sourceLock.commit
    || context.captured_at !== receipt.issued_at) errors.push('GVP-0 run context is incoherent');
  if (!acquisition || JSON.stringify(acquisition) !== JSON.stringify(authority.acquisition)) {
    errors.push('GVP-0 acquisition identity is incoherent');
  }
  for (const audit of [livePocAudit, liveCandidateAudit]) {
    try { validateAuditMetadata(audit, 'bound fresh'); }
    catch { errors.push('bound fresh production audit metadata is invalid'); }
    const counts = audit?.metadata?.vulnerabilities;
    if (!counts || counts.moderate !== 0 || counts.high !== 0 || counts.critical !== 0) errors.push('bound fresh production audit is not GO');
  }
  try {
    const policy = JSON.parse(readFileSync(path.join(authority.pocRoot, 'fixtures', 'dependency-policy.json'), 'utf8'));
    const pocLock = JSON.parse(authority.packageLockBytes.toString('utf8'));
    const pocDecision = auditDependencyData({ lock: pocLock, audit: livePocAudit, policy, now: receipt.issued_at });
    const candidateDecision = auditDependencyData({ lock: candidateLock, audit: liveCandidateAudit, policy, now: receipt.issued_at });
    if (pocDecision.decision !== 'GO' || candidateDecision.decision !== 'GO') errors.push('bound fresh dependency policy is not GO');
  } catch { errors.push('bound fresh dependency policy could not be verified'); }
  const sanitizedLiveSbom = liveSbom ? Buffer.from(`${JSON.stringify(sanitizeSbom(liveSbom), null, 2)}\n`) : null;
  if (!sanitizedLiveSbom || sha256(sanitizedLiveSbom) !== sha256(authority.baseline.artifacts['source-sbom.cdx.json'])) {
    errors.push('bound fresh CycloneDX SBOM differs from provenance');
  }
  const candidateLockBytes = candidateLock ? Buffer.from(`${JSON.stringify(candidateLock, null, 2)}\n`) : null;
  const expectedProbeContracts = [
    ['poc-production-audit', 'npm audit --omit=dev --json'],
    ['candidate-production-audit', 'npm audit --omit=dev --json'],
    ['poc-cyclonedx-sbom', 'npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx'],
  ];
  const expectedProbeRoles = expectedProbeContracts.map(([role]) => role);
  if (!freshness || freshness.schema_id !== 'superwagie.gvp-0-supply-chain-freshness.v1'
    || freshness.evidence_issued_at !== receipt.issued_at
    || JSON.stringify(freshness.probes?.map(probe => probe.role)) !== JSON.stringify(expectedProbeRoles)
    || freshness.inputs?.poc_package_lock_sha256 !== sha256(authority.packageLockBytes)
    || !candidateLockBytes || sha256(candidateLockBytes) !== sha256(authority.candidateLockBytes)
    || freshness.inputs?.candidate_package_lock_sha256 !== sha256(authority.candidateLockBytes)
    || freshness.inputs?.baseline_index_sha256 !== sha256(authority.baseline.indexBytes)
    || freshness.inputs?.build_provenance_sha256 !== sha256(authority.baseline.artifacts['build-provenance.json'])
    || freshness.max_age_millis !== LIVE_EVIDENCE_MAX_AGE_MS || freshness.timeout_millis !== SUPPLY_CHAIN_TIMEOUT_MS
    || freshness.source_commit !== authority.sourceLock.commit
    || freshness.checks?.poc_production_audit !== 'GO' || freshness.checks?.candidate_production_audit !== 'GO'
    || freshness.checks?.cyclonedx_matches_provenance_input !== true || freshness.checks?.build_outputs_match_provenance !== true) {
    errors.push('GVP-0 supply-chain freshness attestation is incomplete or mismatched');
  } else {
    const freshnessCaptured = Date.parse(freshness.captured_at);
    if (!Number.isFinite(freshnessCaptured) || Math.abs(freshnessCaptured - timestamp) > FUTURE_CLOCK_SKEW_MS) {
      errors.push('supply-chain freshness capture timestamp mismatches receipt');
    }
    const rawByRole = new Map([
      ['poc-production-audit', 'artifacts/fresh/npm-audit.raw.json'],
      ['candidate-production-audit', 'artifacts/fresh/candidate-npm-audit.raw.json'],
      ['poc-cyclonedx-sbom', 'artifacts/fresh/source-sbom.raw.cdx.json'],
    ]);
    for (const [index, probe] of freshness.probes.entries()) {
      if (probe.command !== expectedProbeContracts[index][1]) errors.push(`fresh probe command mismatch: ${probe.role}`);
      if (probe.exit_code !== 0 || probe.raw_sha256 !== bindings.get(rawByRole.get(probe.role))) errors.push(`fresh probe binding mismatch: ${probe.role}`);
      const captured = Date.parse(probe.captured_at);
      if (!Number.isFinite(captured) || Math.abs(captured - timestamp) > FUTURE_CLOCK_SKEW_MS) errors.push(`fresh probe timestamp mismatch: ${probe.role}`);
    }
  }
  try {
    const tap = readFileSync(path.join(runRoot, 'artifacts/host-adapter-tests.tap'), 'utf8');
    if (/^not ok\b/mu.test(tap) || !/(?:#|ℹ) fail 0\b/u.test(tap) || !/(?:#|ℹ) pass 19\b/u.test(tap)) errors.push('Host Adapter TAP evidence is incomplete');
  } catch { errors.push('Host Adapter TAP evidence is missing'); }
  const expectedMaliciousPlatform = expectedPlatform === 'macos-15-arm64' ? 'darwin-arm64' : 'win32-x64';
  if (!malicious || malicious.fixture !== 'GVP-0-CORE-001' || malicious.platform !== expectedMaliciousPlatform
    || malicious.candidate?.commit !== authority.sourceLock.commit || malicious.behavior?.pass !== true
    || malicious.metrics?.forbidden_runtime_edges !== authority.baseline.parsed['built-source-policy.json'].forbidden_runtime_edges) {
    errors.push('GVP-0 malicious baseline is incoherent');
  }
  for (const value of [summary, context, acquisition, freshness, malicious, livePocAudit, liveCandidateAudit, liveSbom]) {
    if (value && !noAbsoluteFilesystemPaths(value)) errors.push('GVP-0 evidence contains an absolute filesystem path');
  }
}

export function evaluateGvp0Admission({ forbiddenRuntimeEdges, evidenceValid, behaviorPass, requestedVerdict = 'GO' } = {}) {
  const accepted = evidenceValid === true && behaviorPass === true && forbiddenRuntimeEdges === 0 && requestedVerdict === 'GO';
  return {
    verdict: accepted ? 'GO' : 'NO_GO',
    exitCode: accepted ? 0 : 1,
    releaseAdmission: 'NO_GO',
  };
}

function validationOutcome(errors, bindingsChecked) {
  return {
    valid: errors.length === 0,
    errors: errors.map(sanitizeDiagnostic),
    bindings_checked: bindingsChecked,
  };
}

export function validateReceiptBundle({ resultsPath, repoRoot = DEFAULT_REPO_ROOT, now = new Date().toISOString() } = {}) {
  const errors = [];
  let receipt;
  let runRoot;
  try {
    const resultStat = lstatSync(resultsPath);
    if (!resultStat.isFile() || resultStat.isSymbolicLink()) throw new Error('results must be a regular non-symlink file');
    const resultBytes = readFileSync(resultsPath);
    receipt = JSON.parse(resultBytes.toString('utf8'));
    errors.push(...artifactContentErrors('results.json', resultBytes));
    runRoot = path.dirname(resultsPath);
    const validate = schemaValidators(repoRoot).receipt;
    if (!validate(receipt)) errors.push(`receipt schema invalid: ${JSON.stringify(validate.errors)}`);
    if (!/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(receipt.issued_at ?? '') || Number.isNaN(Date.parse(receipt.issued_at))) {
      errors.push('receipt issued_at is not a valid UTC date-time');
    }
  } catch (error) {
    return validationOutcome([`results invalid: ${error.message}`], 0);
  }
  const manifestPath = path.join(runRoot, 'artifacts', 'evidence-manifest.json');
  let manifest;
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('evidence manifest must be a regular non-symlink file');
    const bytes = readFileSync(manifestPath);
    if (sha256(bytes) !== receipt.evidence_sha256) errors.push('evidence manifest hash mismatch');
    manifest = JSON.parse(bytes.toString('utf8'));
    errors.push(...artifactContentErrors('artifacts/evidence-manifest.json', bytes));
  } catch (error) {
    errors.push(`evidence manifest invalid: ${error.message}`);
    return validationOutcome(errors, 0);
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
      const artifactBytes = readFileSync(realpathSync(artifact));
      if (sha256(artifactBytes) !== binding.sha256) throw new Error('hash mismatch');
      errors.push(...artifactContentErrors(binding.path, artifactBytes));
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
  validateExactGvp0Contract({ receipt, manifest, runRoot, declared, repoRoot, now, errors });
  if (!noAbsoluteFilesystemPaths(receipt) || !noAbsoluteFilesystemPaths(manifest)) errors.push('receipt or evidence manifest contains an absolute filesystem path');
  return validationOutcome(errors, declared.length);
}

export async function runGvp0Gate(options = {}) {
  let outputCapability;
  try {
    const {
      candidateRoot,
      fixture,
      platform,
      resultsPath,
      artifactsDir,
      pocRoot = DEFAULT_POC_ROOT,
      repoRoot = DEFAULT_REPO_ROOT,
      now = () => new Date().toISOString(),
      supplyChainExecutor = defaultSupplyChainExecutor,
      finalizeRunEvidence,
    } = options;
    const issuedAt = options.issuedAt ?? now();
    const sourceLockPath = path.join(pocRoot, 'source-lock.json');
    const patchLedgerPath = path.join(pocRoot, 'patch-ledger.json');
    const packageLockPath = path.join(pocRoot, 'package-lock.json');
    const candidateLockPath = path.join(candidateRoot ?? '', 'package-lock.json');
    const fixtureRoot = path.join(repoRoot, 'fixtures', 'gvp-0', 'GVP-0-CORE-001');
    const acceptancePath = path.join(fixtureRoot, 'acceptance.json');
    assertCandidateBoundary(candidateRoot);
    assertOutputBoundary({
      resultsPath,
      artifactsDir,
      protectedRoots: [candidateRoot, fixtureRoot, pocRoot],
      protectedFiles: [sourceLockPath, patchLedgerPath, packageLockPath, candidateLockPath, acceptancePath],
    });
    if (fixture !== 'GVP-0-CORE-001') rejectInput('GVP0_FIXTURE_UNSUPPORTED', 'GVP-0 requires fixture GVP-0-CORE-001');
    if (!['macos-15-arm64', 'windows-11-x64'].includes(platform)) rejectInput('GVP0_PLATFORM_INVALID', 'unsupported platform id');
    if (platform !== hostPlatform()) rejectInput('GVP0_PLATFORM_MISMATCH', `requested platform ${platform} does not match this host`);

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
    const candidateLockBytes = readRegularFile(candidateLockPath, candidateRoot, 'GVP0_DEPENDENCY_LOCK_REJECTED');
    let runtimeLock;
    let candidateLock;
    try {
      runtimeLock = JSON.parse(packageLockBytes.toString('utf8'));
      candidateLock = JSON.parse(candidateLockBytes.toString('utf8'));
    } catch { rejectAcceptance('GVP0_DEPENDENCY_LOCK_REJECTED', 'dependency lock is invalid JSON'); }
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
    const acceptanceBytes = readRegularFile(acceptancePath, fixtureRoot, 'GVP0_ACCEPTANCE_FIXTURE_INVALID');
    const requiredArtifactPaths = requiredGvp0ArtifactPaths(
      chunkEvidence.copiedOutputs.map(output => `artifacts/${output.output}`),
    );
    outputCapability = createOwnedOutputCapability({ resultsPath, artifactsDir, artifactPaths: requiredArtifactPaths });
    const authoritativeInputHashes = new Map([
      [sourceLockPath, sha256(sourceLockDocument.bytes)],
      [patchLedgerPath, sha256(patchDocument.bytes)],
      [packageLockPath, sha256(packageLockBytes)],
      [candidateLockPath, sha256(candidateLockBytes)],
      [acceptancePath, sha256(acceptanceBytes)],
      [path.join(baseline.baselineRoot, 'index.json'), sha256(baseline.indexBytes)],
      ...Object.entries(baseline.artifacts).map(([logicalName, bytes]) => [path.join(baseline.baselineRoot, logicalName), sha256(bytes)]),
      ...chunkEvidence.copiedOutputs.map(output => [output.source, sha256(output.bytes)]),
    ]);
    const freshSupplyChain = collectFreshSupplyChainEvidence({
      pocRoot,
      candidateRoot,
      baseline,
      runtimeLock,
      candidateLock,
      runtimeLockBytes: packageLockBytes,
      candidateLockBytes,
      issuedAt,
      now,
      executor: supplyChainExecutor,
    });
    for (const [logicalName, bytes] of Object.entries(freshSupplyChain.raw)) {
      outputCapability.write(`artifacts/${logicalName}`, bytes);
    }
    outputCapability.write('artifacts/fresh/supply-chain-freshness.json', jsonBytes(freshSupplyChain.attestation));
    outputCapability.assertPublicIdentity();
    if (freshSupplyChain.rejection) {
      rejectAcceptance(freshSupplyChain.rejection.code, freshSupplyChain.rejection.message);
    }

    const hostTestEnvironment = { ...process.env, npm_config_offline: 'true' };
    delete hostTestEnvironment.NODE_TEST_CONTEXT;
    const hostTest = spawnSync(process.execPath, ['--test', path.join(DEFAULT_POC_ROOT, 'tests', 'host-adapter.test.mjs')], {
      cwd: DEFAULT_POC_ROOT,
      encoding: 'utf8',
      env: hostTestEnvironment,
    });
    if (hostTest.status !== 0) rejectAcceptance('GVP0_HOST_ADAPTER_TEST_FAILED', 'Host Adapter test process failed');
    outputCapability.assertPublicIdentity();

    const maliciousScratch = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-malicious-output-'));
    let malicious;
    try {
      malicious = await runMaliciousCorpus({
        candidateRoot,
        fixtureRoot: path.join(DEFAULT_POC_ROOT, 'fixtures', 'malicious'),
        acceptancePath: path.join(repoRoot, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'acceptance.json'),
        output: path.join(maliciousScratch, 'malicious-corpus.json'),
        offline: true,
      });
    } finally {
      rmSync(maliciousScratch, { recursive: true, force: true });
    }
    outputCapability.assertPublicIdentity();
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

    outputCapability.write('artifacts/source/source-lock.json', sourceLockDocument.bytes);
    outputCapability.write('artifacts/source/patch-ledger.json', patchDocument.bytes);
    outputCapability.write('artifacts/source/package-lock.json', packageLockBytes);
    outputCapability.write('artifacts/source/candidate-package-lock.json', candidateLockBytes);
    outputCapability.write('artifacts/source/acquisition-receipt.json', jsonBytes(sourceReceipt));
    for (const logicalName of BASELINE_ARTIFACTS) {
      outputCapability.write(`artifacts/baseline/${logicalName}`, baseline.artifacts[logicalName]);
    }
    outputCapability.write('artifacts/baseline/index.json', baseline.indexBytes);
    for (const output of chunkEvidence.copiedOutputs) outputCapability.write(`artifacts/${output.output}`, output.bytes);
    outputCapability.write('artifacts/host-adapter-tests.tap', Buffer.from(hostTest.stdout, 'utf8'));
    outputCapability.write('artifacts/acceptance.json', acceptanceBytes);
    outputCapability.write('artifacts/malicious-corpus.json', jsonBytes(malicious));
    outputCapability.write('artifacts/malicious-corpus.json.superwagie-viewer-malicious-output-owned', Buffer.from(MALICIOUS_OUTPUT_MARKER));

    const chunkManifestSet = {
      schema_id: 'superwagie.gvp-0-chunk-manifest-set.v1',
      manifests: chunkEvidence.manifests,
    };
    const chunkSetBytes = outputCapability.write('artifacts/chunk-manifest-set.json', jsonBytes(chunkManifestSet));
    const admission = evaluateGvp0Admission({
      forbiddenRuntimeEdges: audited.builtPolicy.forbidden_runtime_edges,
      evidenceValid: true,
      behaviorPass: malicious.behavior.pass,
      requestedVerdict: audited.admission.decision === 'GO' ? 'GO' : 'NO_GO',
    });
    const viewerVersion = `${sourceLockDocument.value.version}+${sourceReceipt.commit}`;
    outputCapability.write('artifacts/run-context.json', jsonBytes({
      schema_id: 'superwagie.gvp-0-run-context.v1',
      gate_id: 'GVP-0',
      fixture_id: 'GVP-0-CORE-001',
      platform_id: platform,
      candidate_id: 'omni-viewer-core',
      candidate_version: viewerVersion,
      candidate_commit: sourceReceipt.commit,
      captured_at: issuedAt,
    }));
    const summary = {
      schema_id: 'superwagie.gvp-0-acceptance-summary.v1',
      gate: 'GVP-0',
      fixture: 'GVP-0-CORE-001',
      corpus_id: 'GVP-0-CORE-001',
      corpus_sha256: sha256(acceptanceBytes),
      platform,
      scope: 'disposable-admission-poc',
      captured_at: issuedAt,
      candidate_id: 'omni-viewer-core',
      candidate_version: viewerVersion,
      candidate_commit: sourceReceipt.commit,
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
    outputCapability.write('artifacts/acceptance-summary.json', jsonBytes(summary));
    const evidenceManifest = {
      schema_id: 'superwagie.gvp-0-evidence-manifest.v1',
      gate_id: 'GVP-0',
      corpus_id: 'GVP-0-CORE-001',
      platform_id: platform,
      chunk_manifest_set_sha256: sha256(chunkSetBytes),
      artifacts: outputCapability.artifactBindings(),
    };
    if (!noAbsoluteFilesystemPaths(evidenceManifest)) rejectAcceptance('GVP0_ABSOLUTE_PATH_DISCLOSURE', 'evidence manifest contains an absolute path');
    const manifestBytes = outputCapability.write('artifacts/evidence-manifest.json', jsonBytes(evidenceManifest));
    const receipt = {
      receipt_id: `gvp0-core-${platform}-${sha256(manifestBytes).slice(7, 23)}`,
      gate_id: 'GVP-0',
      format_variant_id: 'universal.viewer.core',
      viewer_id: 'omni-viewer-core',
      viewer_version: viewerVersion,
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
    outputCapability.write('results.json', jsonBytes(receipt));
    outputCapability.assertPublicIdentity();
    const validation = validateReceiptBundle({ resultsPath, repoRoot, now: now() });
    if (!validation.valid) rejectAcceptance('GVP0_RECEIPT_BINDING_INVALID', validation.errors.join('; '));
    if (finalizeRunEvidence) {
      await finalizeRunEvidence({ admission, receipt });
      outputCapability.assertPublicIdentity();
    }
    const sourceReceiptFinal = verifyAcquiredCandidate({
      candidateRoot,
      sourceLock: sourceLockDocument.value,
      lockBytes: sourceLockDocument.bytes,
    });
    if (JSON.stringify(sourceReceiptFinal) !== JSON.stringify(sourceReceipt)
      || [...authoritativeInputHashes].some(([file, expectedHash]) => sha256(readRegularFile(file)) !== expectedHash)) {
      rejectAcceptance('GVP0_SOURCE_MUTATION_DETECTED', 'source or authoritative input changed during output persistence');
    }
    outputCapability.assertPublicIdentity();
    return { ...admission, receipt, code: admission.verdict === 'GO' ? 'GVP0_ACCEPTED' : 'GVP0_ACCEPTANCE_NO_GO' };
  } catch (error) {
    if (error instanceof Gvp0Error) return { exitCode: error.exitCode, code: error.code, error: sanitizeDiagnostic(error.message) };
    return { exitCode: 2, code: 'GVP0_ENVIRONMENT_FAILURE', error: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)) };
  } finally {
    outputCapability?.close();
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
