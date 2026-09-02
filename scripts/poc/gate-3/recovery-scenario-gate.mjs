#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOVERY_SCENARIOS, validateAuthoritativeScenarioRouting } from './recovery-scenario-routing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_HARNESS = path.join(HERE, 'recovery-harness-dist/ts-recovery-harness.mjs');
const RUST_HARNESS = path.join(
  HERE,
  `reviewer-shell/target/debug/recovery_contract_harness${process.platform === 'win32' ? '.exe' : ''}`
);
const SCENARIOS = new Set(RECOVERY_SCENARIOS);
const TS_SCENARIOS = new Set(['wps-missing', 'webview-restart', 'source-revision-changed']);
const RUST_SCENARIOS = new Set(['wps-timeout', 'wps-crash', 'webview-restart', 'cache-corrupt']);
const HASH = /^[0-9a-f]{64}$/;
const RESULT_KEYS = [
  'schema_id', 'schema_version', 'gate', 'fixture', 'scenario', 'platform', 'run_id',
  'captured_at', 'pass', 'status', 'decision_hint', 'reasons', 'artifacts', 'attestation'
];
const RECEIPT_KEYS = [
  'schema_id', 'schema_version', 'fixture', 'scenario', 'platform', 'run_id',
  'captured_at', 'harness', 'outcome'
];
const FORBIDDEN = /(?:^\/|^[A-Za-z]:[\\/]|\/Users\/|\/Applications\/|\.codex(?:[\\/]|$)|Codex(?:\.app|\.exe)|https?:\/\/)/i;

function parse(argv) {
  const result = {};
  const known = new Map([
    ['--fixture', 'fixture'], ['--scenario', 'scenario'], ['--platform', 'platform'],
    ['--results-json', 'resultsJson'], ['--artifacts-dir', 'artifactsDir']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = known.get(argv[index]);
    if (!key || index + 1 >= argv.length || result[key] !== undefined) {
      throw new Error('INVALID_ARGUMENTS');
    }
    result[key] = argv[++index];
  }
  if (Object.keys(result).length !== known.size
    || result.fixture !== 'G3-REVIEW-002'
    || !SCENARIOS.has(result.scenario)
    || !['macos-15-arm64', 'windows-11-x64'].includes(result.platform)
    || !path.isAbsolute(result.resultsJson)
    || !path.isAbsolute(result.artifactsDir)
    || path.dirname(result.resultsJson) !== path.dirname(result.artifactsDir)) {
    throw new Error('INVALID_ARGUMENTS');
  }
  return result;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

function sameHash(left, right) {
  return HASH.test(left) && HASH.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function admissionFresh(value, notBefore, now) {
  if (!validTimestamp(value) || !Number.isSafeInteger(notBefore) || !Number.isSafeInteger(now)
    || notBefore > now) return false;
  const timestamp = Date.parse(value);
  return timestamp >= notBefore && timestamp <= now && now - timestamp <= 5 * 60 * 1000;
}

function containsForbidden(value) {
  if (typeof value === 'string') return FORBIDDEN.test(value);
  if (Array.isArray(value)) return value.some(containsForbidden);
  return value && typeof value === 'object' && Object.values(value).some(containsForbidden);
}

export const ATOMIC_STAGES = [
  'open', 'write', 'flush', 'file-sync', 'precommit-directory-sync', 'rename'
];

export async function publishJsonAtomic(file, value, services = {}) {
  const stageHook = services.stageHook ?? (() => {});
  const temporary = `${file}.tmp-${randomBytes(8).toString('hex')}`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  let fileHandle = null;
  let directoryHandle = null;
  let committed = false;
  try {
    stageHook('open');
    fileHandle = await open(temporary, 'wx', 0o600);
    stageHook('write');
    await fileHandle.writeFile(bytes);
    stageHook('flush');
    await fileHandle.datasync();
    stageHook('file-sync');
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    stageHook('precommit-directory-sync');
    if (process.platform !== 'win32') {
      directoryHandle = await open(path.dirname(file), 'r');
      await directoryHandle.sync();
      await directoryHandle.close();
      directoryHandle = null;
    }
    stageHook('rename');
    await rename(temporary, file);
    committed = true;
    return bytes;
  } finally {
    if (fileHandle) await fileHandle.close().catch(() => {});
    if (directoryHandle) await directoryHandle.close().catch(() => {});
    if (!committed) await rm(temporary, { force: true }).catch(() => {});
  }
}

function runFixed(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { LANG: process.env.LANG ?? 'C.UTF-8' }
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error('FIXED_HARNESS_UNAVAILABLE');
  }
  try {
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) throw new Error('invalid output');
    return JSON.parse(lines[0]);
  } catch {
    throw new Error('FIXED_HARNESS_UNAVAILABLE');
  }
}

function validateHarnessDocument(value, scenario, language) {
  const schema = language === 'typescript'
    ? 'superwagie.recovery-ts-harness.v1'
    : 'superwagie.recovery-rust-harness.v1';
  if (!exact(value, ['schema_id', 'schema_version', 'scenario', 'contract_sources', 'outcome'])
    || value.schema_id !== schema || value.schema_version !== 1 || value.scenario !== scenario
    || !Array.isArray(value.contract_sources) || value.contract_sources.some((source) => typeof source !== 'string')
    || !validHarnessOutcomeShape(scenario, language, value.outcome)
    || containsForbidden(value)) {
    throw new Error('FIXED_HARNESS_INVALID');
  }
  return value;
}

async function runProductionHarness(scenario, privateRoot) {
  if (scenario === 'webview-restart') {
    const rust = validateHarnessDocument(runFixed(RUST_HARNESS, [scenario], privateRoot), scenario, 'rust');
    const typescript = validateHarnessDocument(
      runFixed(process.execPath, [TS_HARNESS, scenario], privateRoot), scenario, 'typescript'
    );
    return {
      schema_id: 'superwagie.recovery-composed-harness.v1',
      schema_version: 1,
      scenario,
      contract_sources: [...rust.contract_sources, ...typescript.contract_sources],
      outcome: { ...rust.outcome, ...typescript.outcome }
    };
  }
  if (TS_SCENARIOS.has(scenario)) {
    return validateHarnessDocument(
      runFixed(process.execPath, [TS_HARNESS, scenario], privateRoot), scenario, 'typescript'
    );
  }
  if (RUST_SCENARIOS.has(scenario)) {
    return validateHarnessDocument(runFixed(RUST_HARNESS, [scenario], privateRoot), scenario, 'rust');
  }
  throw new Error('FIXED_HARNESS_UNAVAILABLE');
}

function expectedSources(scenario) {
  return {
    'wps-missing': ['preview-orchestrator.ts', 'reviewer-ui/src/docx-fast-adapter.ts'],
    'wps-timeout': ['preview_cache.rs', 'review_state.rs', 'wps_worker.rs'],
    'wps-crash': ['preview_cache.rs', 'review_state.rs', 'wps_worker.rs'],
    'webview-restart': ['review_state.rs', 'reviewer-ui/src/review-shell.ts'],
    'cache-corrupt': ['preview_cache.rs', 'review_state.rs'],
    'source-revision-changed': ['annotation-reanchor.ts']
  }[scenario];
}

function harnessKind(scenario) {
  if (scenario === 'webview-restart') return 'composed-production-contracts';
  return TS_SCENARIOS.has(scenario) ? 'typescript-production-contracts' : 'rust-production-contracts';
}

function stringsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isBoolean(value) { return typeof value === 'boolean'; }
function isString(value) { return typeof value === 'string'; }
function isInteger(value) { return Number.isSafeInteger(value); }

function validBinding(value) {
  return exact(value, ['annotation_id', 'artifact_revision_id', 'preview_revision_id', 'page_id'])
    && isString(value.annotation_id) && isString(value.artifact_revision_id)
    && isString(value.preview_revision_id) && isString(value.page_id);
}

function validHarnessOutcomeShape(scenario, language, outcome) {
  if (scenario !== 'webview-restart') return validOutcomeShape(scenario, outcome);
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
  if (language === 'rust') {
    return exact(outcome, [
      'state_bytes_before_sha256', 'state_bytes_after_sha256',
      'annotation_bytes_before_sha256', 'annotation_bytes_after_sha256',
      'accepted_revision_before', 'accepted_revision_after'
    ])
      && HASH.test(outcome.state_bytes_before_sha256) && HASH.test(outcome.state_bytes_after_sha256)
      && HASH.test(outcome.annotation_bytes_before_sha256)
      && HASH.test(outcome.annotation_bytes_after_sha256)
      && isString(outcome.accepted_revision_before) && isString(outcome.accepted_revision_after);
  }
  return exact(outcome, [
    'active_page_before', 'active_page_after', 'accepted_state_restored', 'render_side_effects'
  ])
    && exact(outcome.render_side_effects, ['before_restart', 'after_restart', 'replayed'])
    && isInteger(outcome.active_page_before) && isInteger(outcome.active_page_after)
    && isBoolean(outcome.accepted_state_restored)
    && isInteger(outcome.render_side_effects.before_restart)
    && isInteger(outcome.render_side_effects.after_restart)
    && isBoolean(outcome.render_side_effects.replayed);
}

function validOutcomeShape(scenario, outcome) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
  switch (scenario) {
    case 'wps-missing':
      return exact(outcome, ['docx', 'pptx'])
        && exact(outcome.docx, ['state', 'fidelity', 'readable', 'acceptance_enabled'])
        && exact(outcome.pptx, ['state', 'preview_published', 'acceptance_enabled'])
        && isString(outcome.docx.state) && isString(outcome.docx.fidelity)
        && isBoolean(outcome.docx.readable) && isBoolean(outcome.docx.acceptance_enabled)
        && isString(outcome.pptx.state) && isBoolean(outcome.pptx.preview_published)
        && isBoolean(outcome.pptx.acceptance_enabled);
    case 'wps-timeout':
    case 'wps-crash':
      return exact(outcome, [
        'state', 'error_code', 'partial_preview_published', 'partial_bytes_sha256',
        'publication_cache_bytes_after_error', 'prior_accepted_hash', 'accepted_hash_after',
        'owned_child'
      ])
        && exact(outcome.owned_child, ['started', 'reaped', 'termination', 'other_processes_inspected'])
        && isString(outcome.state) && isString(outcome.error_code)
        && isBoolean(outcome.partial_preview_published) && HASH.test(outcome.partial_bytes_sha256)
        && isInteger(outcome.publication_cache_bytes_after_error)
        && isString(outcome.prior_accepted_hash) && isString(outcome.accepted_hash_after)
        && isBoolean(outcome.owned_child.started) && isBoolean(outcome.owned_child.reaped)
        && isString(outcome.owned_child.termination)
        && isBoolean(outcome.owned_child.other_processes_inspected);
    case 'webview-restart':
      return exact(outcome, [
        'state_bytes_before_sha256', 'state_bytes_after_sha256',
        'annotation_bytes_before_sha256', 'annotation_bytes_after_sha256',
        'accepted_revision_before', 'accepted_revision_after', 'active_page_before',
        'active_page_after', 'accepted_state_restored', 'render_side_effects'
      ])
        && exact(outcome.render_side_effects, ['before_restart', 'after_restart', 'replayed'])
        && HASH.test(outcome.state_bytes_before_sha256) && HASH.test(outcome.state_bytes_after_sha256)
        && HASH.test(outcome.annotation_bytes_before_sha256)
        && HASH.test(outcome.annotation_bytes_after_sha256)
        && isString(outcome.accepted_revision_before) && isString(outcome.accepted_revision_after)
        && isInteger(outcome.active_page_before) && isInteger(outcome.active_page_after)
        && isBoolean(outcome.accepted_state_restored)
        && isInteger(outcome.render_side_effects.before_restart)
        && isInteger(outcome.render_side_effects.after_restart)
        && isBoolean(outcome.render_side_effects.replayed);
    case 'cache-corrupt':
      return exact(outcome, [
        'corrupt_entry_rejected', 'clean_entry_preserved', 'rerendered',
        'corrupt_bytes_sha256', 'replacement_bytes_sha256', 'expected_bytes_sha256',
        'prior_accepted_hash', 'accepted_hash_after'
      ])
        && isBoolean(outcome.corrupt_entry_rejected) && isBoolean(outcome.clean_entry_preserved)
        && isBoolean(outcome.rerendered) && HASH.test(outcome.corrupt_bytes_sha256)
        && HASH.test(outcome.replacement_bytes_sha256) && HASH.test(outcome.expected_bytes_sha256)
        && isString(outcome.prior_accepted_hash) && isString(outcome.accepted_hash_after);
    case 'source-revision-changed':
      return exact(outcome, [
        'old_annotation_binding_before', 'old_annotation_binding_after', 'target_revision',
        'relocation', 'silent_movement'
      ])
        && validBinding(outcome.old_annotation_binding_before)
        && validBinding(outcome.old_annotation_binding_after)
        && exact(outcome.target_revision, ['artifact_revision_id', 'preview_revision_id'])
        && isString(outcome.target_revision.artifact_revision_id)
        && isString(outcome.target_revision.preview_revision_id)
        && exact(outcome.relocation, ['status', 'method', 'page_id'])
        && isString(outcome.relocation.status)
        && (outcome.relocation.method === null || isString(outcome.relocation.method))
        && (outcome.relocation.page_id === null || isString(outcome.relocation.page_id))
        && isBoolean(outcome.silent_movement);
    default:
      return false;
  }
}

function scenarioReason(scenario, outcome) {
  switch (scenario) {
    case 'wps-missing':
      return outcome.docx?.state === 'fast_ready' && outcome.docx?.fidelity === 'fast'
        && outcome.docx?.readable === true && outcome.docx?.acceptance_enabled === false
        && outcome.pptx?.state === 'dependency_missing' && outcome.pptx?.preview_published === false
        && outcome.pptx?.acceptance_enabled === false ? null : 'WPS_MISSING_FALLBACK_INVALID';
    case 'wps-timeout':
    case 'wps-crash': {
      const expectedError = scenario === 'wps-timeout'
        ? 'WPS_RENDER_TIMEOUT' : 'WPS_RENDER_PROTOCOL_INVALID';
      const expectedTermination = scenario === 'wps-timeout' ? 'deadline_kill_wait' : 'exit_86';
      return outcome.state === 'failed_recoverable' && outcome.error_code === expectedError
        && outcome.partial_preview_published === false
        && outcome.publication_cache_bytes_after_error === 0
        && HASH.test(outcome.prior_accepted_hash) && outcome.prior_accepted_hash === outcome.accepted_hash_after
        && outcome.owned_child?.started === true && outcome.owned_child?.reaped === true
        && outcome.owned_child?.termination === expectedTermination
        && outcome.owned_child?.other_processes_inspected === false ? null : 'WPS_FAILURE_RECOVERY_INVALID';
    }
    case 'webview-restart':
      return HASH.test(outcome.state_bytes_before_sha256)
        && outcome.state_bytes_before_sha256 === outcome.state_bytes_after_sha256
        && HASH.test(outcome.annotation_bytes_before_sha256)
        && outcome.annotation_bytes_before_sha256 === outcome.annotation_bytes_after_sha256
        && outcome.accepted_revision_before === outcome.accepted_revision_after
        && /^preview-sha256:[0-9a-f]{64}$/.test(outcome.accepted_revision_after)
        && outcome.active_page_before === outcome.active_page_after
        && Number.isSafeInteger(outcome.active_page_after) && outcome.active_page_after >= 1
        && outcome.accepted_state_restored === true
        && outcome.render_side_effects?.before_restart === outcome.render_side_effects?.after_restart
        && outcome.render_side_effects?.replayed === false ? null : 'WEBVIEW_RESTART_RECOVERY_INVALID';
    case 'cache-corrupt':
      return outcome.corrupt_entry_rejected === true && outcome.clean_entry_preserved === true
        && outcome.rerendered === true && HASH.test(outcome.corrupt_bytes_sha256)
        && HASH.test(outcome.replacement_bytes_sha256) && HASH.test(outcome.expected_bytes_sha256)
        && outcome.corrupt_bytes_sha256 !== outcome.replacement_bytes_sha256
        && outcome.replacement_bytes_sha256 === outcome.expected_bytes_sha256
        && HASH.test(outcome.prior_accepted_hash) && outcome.prior_accepted_hash === outcome.accepted_hash_after
        ? null : 'CACHE_CORRUPTION_RECOVERY_INVALID';
    case 'source-revision-changed':
      return JSON.stringify(stable(outcome.old_annotation_binding_before))
          === JSON.stringify(stable(outcome.old_annotation_binding_after))
        && outcome.old_annotation_binding_after?.artifact_revision_id
          !== outcome.target_revision?.artifact_revision_id
        && ['resolved', 'unresolved'].includes(outcome.relocation?.status)
        && outcome.silent_movement === false ? null : 'SOURCE_REVISION_REANCHOR_INVALID';
    default:
      return 'UNKNOWN_RECOVERY_SCENARIO';
  }
}

function normalizeHarness(raw, scenario) {
  const composed = scenario === 'webview-restart';
  const expectedSchema = composed ? 'superwagie.recovery-composed-harness.v1'
    : TS_SCENARIOS.has(scenario) ? 'superwagie.recovery-ts-harness.v1'
      : 'superwagie.recovery-rust-harness.v1';
  if (!exact(raw, ['schema_id', 'schema_version', 'scenario', 'contract_sources', 'outcome'])
    || raw.schema_id !== expectedSchema || raw.schema_version !== 1 || raw.scenario !== scenario
    || !stringsEqual(raw.contract_sources, expectedSources(scenario))
    || !validOutcomeShape(scenario, raw.outcome)
    || containsForbidden(raw)) throw new Error('FIXED_HARNESS_INVALID');
  return {
    harness: { kind: harnessKind(scenario), contract_sources: [...raw.contract_sources] },
    outcome: raw.outcome
  };
}

export function evaluateHarnessForScenario(raw, scenario) {
  const normalized = normalizeHarness(raw, scenario);
  return { ...normalized, reason: scenarioReason(scenario, normalized.outcome) };
}

function resultDocument(args, runId, capturedAt, decision, artifact = null) {
  const unsigned = {
    schema_id: 'superwagie.g3-review-recovery-result.v1', schema_version: 1,
    gate: 'gate-3', fixture: args.fixture, scenario: args.scenario, platform: args.platform,
    run_id: runId, captured_at: capturedAt,
    pass: decision === 'GO', status: decision === 'GO' ? 'passed' : decision === 'NO_GO' ? 'failed' : 'blocked',
    decision_hint: decision,
    reasons: decision === 'GO' ? [] : [artifact?.reason ?? 'FIXED_HARNESS_UNAVAILABLE'],
    artifacts: artifact?.record ? { recovery_receipt: artifact.record } : {}
  };
  return { ...unsigned, attestation: { algorithm: 'sha256', canonical_sha256: sha(JSON.stringify(stable(unsigned))) } };
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parse(argv); } catch { return 2; }
  try { await validateAuthoritativeScenarioRouting(); } catch { return 2; }
  const admissionNotBefore = Date.now();
  const runId = `recovery-${randomBytes(8).toString('hex')}`;
  await mkdir(args.artifactsDir, { recursive: true, mode: 0o700 });
  const privateRoot = await mkdtemp(path.join(args.artifactsDir, '.recovery-private-'));
  let raw;
  try {
    raw = await runProductionHarness(args.scenario, privateRoot);
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true });
    const capturedAt = new Date().toISOString();
    const reason = error instanceof Error && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.message)
      ? error.message : 'FIXED_HARNESS_UNAVAILABLE';
    await publishJsonAtomic(args.resultsJson, resultDocument(args, runId, capturedAt, 'BLOCKED_ENVIRONMENT', { reason }));
    return 2;
  }
  await rm(privateRoot, { recursive: true, force: true });
  const capturedAt = new Date().toISOString();
  let normalized;
  try { normalized = normalizeHarness(raw, args.scenario); } catch {
    await publishJsonAtomic(args.resultsJson, resultDocument(args, runId, capturedAt, 'BLOCKED_ENVIRONMENT', { reason: 'FIXED_HARNESS_INVALID' }));
    return 2;
  }
  const reason = scenarioReason(args.scenario, normalized.outcome);
  const receipt = {
    schema_id: 'superwagie.g3-review-recovery-receipt.v1', schema_version: 1,
    fixture: args.fixture, scenario: args.scenario, platform: args.platform,
    run_id: runId, captured_at: capturedAt, harness: normalized.harness, outcome: normalized.outcome
  };
  if (containsForbidden(receipt)) {
    await publishJsonAtomic(args.resultsJson, resultDocument(args, runId, capturedAt, 'BLOCKED_ENVIRONMENT', { reason: 'FIXED_HARNESS_INVALID' }));
    return 2;
  }
  const receiptPath = path.join(args.artifactsDir, 'recovery-receipt.json');
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const record = { relative_path: 'artifacts/recovery-receipt.json', sha256: sha(receiptBytes) };
  await publishJsonAtomic(receiptPath, receipt);
  const result = resultDocument(args, runId, capturedAt, reason ? 'NO_GO' : 'GO', { record, reason });
  await publishJsonAtomic(args.resultsJson, result);
  if (!reason) {
    try {
      await validateRecoveryEvidence(args.resultsJson, path.dirname(args.resultsJson), {
        mode: 'admission', notBefore: admissionNotBefore, now: Date.now()
      });
    } catch {
      return 2;
    }
  }
  return reason ? 1 : 0;
}

export async function validateRecoveryEvidence(resultsFile, evidenceRoot, options = { mode: 'archive' }) {
  const archival = exact(options, ['mode']) && options.mode === 'archive';
  const admission = exact(options, ['mode', 'notBefore', 'now']) && options.mode === 'admission';
  if (!archival && !admission) throw new Error('INVALID_VALIDATION_MODE');
  if (!path.isAbsolute(resultsFile) || !path.isAbsolute(evidenceRoot)) throw new Error('INVALID_PATH');
  const root = await realpath(evidenceRoot);
  const resultPath = await realpath(resultsFile);
  const metadata = await lstat(resultsFile);
  if (metadata.isSymbolicLink() || !metadata.isFile()
    || (resultPath !== root && !resultPath.startsWith(`${root}${path.sep}`))) throw new Error('INVALID_RESULT');
  const value = JSON.parse(await readFile(resultPath, 'utf8'));
  if (!exact(value, RESULT_KEYS) || value.schema_id !== 'superwagie.g3-review-recovery-result.v1'
    || value.schema_version !== 1 || value.gate !== 'gate-3' || value.fixture !== 'G3-REVIEW-002'
    || !SCENARIOS.has(value.scenario) || !['macos-15-arm64', 'windows-11-x64'].includes(value.platform)
    || !/^recovery-[0-9a-f]{16}$/.test(value.run_id) || !validTimestamp(value.captured_at)
    || value.pass !== true || value.status !== 'passed' || value.decision_hint !== 'GO'
    || !Array.isArray(value.reasons) || value.reasons.length !== 0
    || !exact(value.artifacts, ['recovery_receipt'])
    || !exact(value.attestation, ['algorithm', 'canonical_sha256'])
    || value.attestation.algorithm !== 'sha256' || !HASH.test(value.attestation.canonical_sha256)
    || containsForbidden(value)) throw new Error('INVALID_RESULT');
  if (admission && !admissionFresh(value.captured_at, options.notBefore, options.now)) {
    throw new Error('INVALID_FRESHNESS');
  }
  const { attestation, ...unsigned } = value;
  if (!sameHash(attestation.canonical_sha256, sha(JSON.stringify(stable(unsigned))))) {
    throw new Error('INVALID_ATTESTATION');
  }
  const record = value.artifacts.recovery_receipt;
  if (!exact(record, ['relative_path', 'sha256']) || record.relative_path !== 'artifacts/recovery-receipt.json'
    || !HASH.test(record.sha256)) throw new Error('INVALID_ARTIFACT');
  const receiptFile = path.resolve(root, record.relative_path);
  const receiptPath = await realpath(receiptFile);
  const receiptMetadata = await lstat(receiptFile);
  if (receiptMetadata.isSymbolicLink() || !receiptMetadata.isFile()
    || !receiptPath.startsWith(`${root}${path.sep}`)) throw new Error('INVALID_ARTIFACT');
  const receiptBytes = await readFile(receiptPath);
  if (!sameHash(record.sha256, sha(receiptBytes))) throw new Error('INVALID_ARTIFACT_HASH');
  const receipt = JSON.parse(receiptBytes);
  if (!exact(receipt, RECEIPT_KEYS)
    || receipt.schema_id !== 'superwagie.g3-review-recovery-receipt.v1' || receipt.schema_version !== 1
    || receipt.fixture !== value.fixture || receipt.scenario !== value.scenario
    || receipt.platform !== value.platform || receipt.run_id !== value.run_id
    || receipt.captured_at !== value.captured_at || !validTimestamp(receipt.captured_at)
    || !exact(receipt.harness, ['kind', 'contract_sources'])
    || !['typescript-production-contracts', 'rust-production-contracts', 'composed-production-contracts']
      .includes(receipt.harness.kind)
    || !Array.isArray(receipt.harness.contract_sources)
    || receipt.harness.contract_sources.some((source) => typeof source !== 'string')
    || !validOutcomeShape(receipt.scenario, receipt.outcome)
    || containsForbidden(receipt)) throw new Error('INVALID_RECEIPT');
  if (admission && !admissionFresh(receipt.captured_at, options.notBefore, options.now)) {
    throw new Error('INVALID_FRESHNESS');
  }
  const normalized = normalizeHarness({
    schema_id: receipt.harness.kind === 'composed-production-contracts'
      ? 'superwagie.recovery-composed-harness.v1'
      : receipt.harness.kind === 'typescript-production-contracts'
        ? 'superwagie.recovery-ts-harness.v1' : 'superwagie.recovery-rust-harness.v1',
    schema_version: 1, scenario: receipt.scenario,
    contract_sources: receipt.harness.contract_sources, outcome: receipt.outcome
  }, receipt.scenario);
  if (scenarioReason(receipt.scenario, normalized.outcome)) throw new Error('INVALID_OUTCOME');
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
