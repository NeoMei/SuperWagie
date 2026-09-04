#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const PROFILE_BY_FIXTURE = Object.freeze({
  'G4-VIDEO-001': 'website_demo',
  'G4-VIDEO-002': 'teaching_courseware',
  'G4-VIDEO-003': 'ppt_explainer',
  'G4-VIDEO-004': 'picture_book',
  'G4-VIDEO-005': 'photo_motion',
});
const EVIDENCE_REVISION = 'solution-b-v1';
const ARTIFACTS = ['scene_ir', 'sample_mp4', 'final_mp4', 'subtitles_srt', 'cover_png', 'provenance', 'qa'];
const AUTOMATED_CHECKS = [
  'sample_duration_10_to_15_seconds', 'final_duration_30_to_60_seconds',
  'video_stream_present', 'audio_stream_present', 'fps_is_30', 'motion_present',
  'narration_present', 'subtitles_present', 'black_frame_qa_passed',
  'silence_qa_passed', 'local_rerender_isolated', 'cancel_resume_recovered',
  'clean_room_dependencies_absent', 'headless_chromium_frame_renderer_executed',
  'profile_visual_truth_preserved', 'platform_decode_verified',
];
const CONDITIONAL_CHECKS = [
  'human_time_review_approved', 'credits_idempotency_verified', 'windows_decode_verified',
  'real_wps_or_powerpoint_visual_truth_approved',
];
const CONDITIONAL_LIMITATIONS = Object.freeze({
  human_time_review_approved: 'A human has not yet approved time-point review for this rendered profile.',
  credits_idempotency_verified: 'Video reserve, settle, refund, and retry idempotency require the real Credits service.',
  windows_decode_verified: 'Windows 11 decode and golden-render comparison require a Windows runner.',
  real_wps_or_powerpoint_visual_truth_approved: 'PPT narration visual truth requires a real WPS or PowerPoint human review.',
});
const MAX_BYTES = 100 * 1024 * 1024;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} keys are invalid`);
}

function regularBytes(file, label) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (metadata.size === 0 || metadata.size > MAX_BYTES) throw new Error(`${label} size is invalid`);
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw new Error(`${label} changed during validation`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function contained(root, candidate, label) {
  if (typeof candidate !== 'string' || candidate.length === 0 || isAbsolute(candidate)) throw new Error(`${label} path is invalid`);
  const full = resolve(root, candidate);
  const rel = relative(root, full);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error(`${label} escapes its root`);
  return full;
}

function result(decision, fixture, reasons, limitations, metrics = null, identities = null) {
  return {
    schema_id: 'superwagie.g4-video-gate-result.v1', schema_version: 1,
    gate: 'gate-4', fixture, evidence_revision: EVIDENCE_REVISION,
    pass: decision === 'GO' || decision === 'CONDITIONAL_GO',
    status: decision === 'BLOCKED_ENVIRONMENT' ? 'blocked' : decision === 'NO_GO' ? 'failed' : 'passed',
    decision_hint: decision, reasons, limitations,
    ...(metrics ? { metrics } : {}),
    ...(identities ? { ...identities } : {}),
  };
}

function writeResult(path, document) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

const fixture = arg('--fixture');
const platform = arg('--platform');
const resultsPath = arg('--results-json');
const artifactsDir = arg('--artifacts-dir');
const evaluationResult = arg('--evaluation-result');

if (!PROFILE_BY_FIXTURE[fixture] || !platform || !isAbsolute(resultsPath) || !isAbsolute(artifactsDir)
  || (evaluationResult && !isAbsolute(evaluationResult))) {
  console.error('usage: video-gate.mjs --fixture G4-VIDEO-001..005 --platform ID --results-json ABS --artifacts-dir ABS [--evaluation-result ABS]');
  process.exit(2);
}
if (!evaluationResult) {
  writeResult(resultsPath, result('BLOCKED_ENVIRONMENT', fixture, ['REAL_VIDEO_EVALUATION_REQUIRED'], [
    'A paper design or static source audit cannot replace real sample, final render, media QA, cancellation, and recovery evidence.',
  ], null, { evaluation_sha256: null, evaluation_receipt_sha256: null }));
  console.error('BLOCKED_ENVIRONMENT: real video evaluation required');
  process.exit(2);
}

try {
  let admittedIdentities = { evaluation_sha256: null, evaluation_receipt_sha256: null };
  const bytes = regularBytes(evaluationResult, 'video evaluation');
  const evaluationSha256 = `sha256:${sha256(bytes)}`;
  const evaluation = JSON.parse(bytes.toString('utf8'));
  exactKeys(evaluation, [
    'schema_id', 'schema_version', 'fixture', 'platform', 'profile', 'executed_at',
    'runtime', 'artifacts', 'checks', 'conditional_checks',
  ], 'video evaluation');
  if (evaluation.schema_id !== 'superwagie.g4-video-evaluation.v1' || evaluation.schema_version !== 1
    || evaluation.fixture !== fixture || evaluation.platform !== platform
    || evaluation.profile !== PROFILE_BY_FIXTURE[fixture] || !Number.isFinite(Date.parse(evaluation.executed_at))) {
    throw new Error('video evaluation identity mismatch');
  }
  exactKeys(evaluation.runtime, [
    'renderer', 'ffmpeg_version', 'openmontage_commit_researched',
    'openmontage_code_used', 'remotion_runtime_used',
  ], 'runtime');
  if (typeof evaluation.runtime.renderer !== 'string' || evaluation.runtime.renderer.length === 0
    || typeof evaluation.runtime.ffmpeg_version !== 'string' || evaluation.runtime.ffmpeg_version.length === 0
    || !/^[a-f0-9]{40}$/.test(evaluation.runtime.openmontage_commit_researched)
    || typeof evaluation.runtime.openmontage_code_used !== 'boolean'
    || typeof evaluation.runtime.remotion_runtime_used !== 'boolean') throw new Error('runtime identity is invalid');
  exactKeys(evaluation.artifacts, ARTIFACTS, 'artifacts');
  exactKeys(evaluation.checks, AUTOMATED_CHECKS, 'checks');
  exactKeys(evaluation.conditional_checks, CONDITIONAL_CHECKS, 'conditional checks');
  for (const [group, names] of [[evaluation.checks, AUTOMATED_CHECKS], [evaluation.conditional_checks, CONDITIONAL_CHECKS]]) {
    if (names.some((name) => typeof group[name] !== 'boolean')) throw new Error('check values must be boolean');
  }

  mkdirSync(artifactsDir, { recursive: true });
  const evaluationRoot = dirname(evaluationResult);
  const receipts = {};
  for (const name of ARTIFACTS) {
    exactKeys(evaluation.artifacts[name], ['bytes', 'path', 'sha256'], `artifact ${name}`);
    const expected = evaluation.artifacts[name];
    if (!/^sha256:[a-f0-9]{64}$/.test(expected.sha256 ?? '')
      || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) throw new Error(`artifact ${name} expected identity is invalid`);
    const source = contained(evaluationRoot, evaluation.artifacts[name].path, `artifact ${name}`);
    const artifactBytes = regularBytes(source, `artifact ${name}`);
    const actualSha256 = `sha256:${sha256(artifactBytes)}`;
    if (actualSha256 !== expected.sha256 || artifactBytes.length !== expected.bytes) {
      throw new Error(`artifact ${name} bytes do not match the evaluation binding`);
    }
    const extension = basename(source).includes('.') ? `.${basename(source).split('.').at(-1)}` : '';
    const destination = resolve(artifactsDir, `${name}${extension}`);
    writeFileSync(destination, artifactBytes, { flag: 'wx', mode: 0o600 });
    receipts[name] = { file: basename(destination), sha256: sha256(artifactBytes), bytes: artifactBytes.length };
  }
  const evaluationReceipt = `${JSON.stringify({
    schema_id: 'superwagie.g4-video-evaluation-receipt.v1', schema_version: 1,
    fixture, profile: evaluation.profile, evaluation_sha256: evaluationSha256, runtime: evaluation.runtime,
    artifacts: receipts,
  }, null, 2)}\n`;
  writeFileSync(resolve(artifactsDir, 'evaluation-receipt.json'), evaluationReceipt, { mode: 0o600 });
  admittedIdentities = {
    evaluation_sha256: evaluationSha256,
    evaluation_receipt_sha256: `sha256:${sha256(Buffer.from(evaluationReceipt))}`,
  };

  const automatedPassed = AUTOMATED_CHECKS.filter((name) => evaluation.checks[name]).length;
  const applicableConditionalChecks = fixture === 'G4-VIDEO-003'
    ? CONDITIONAL_CHECKS
    : CONDITIONAL_CHECKS.filter((name) => name !== 'real_wps_or_powerpoint_visual_truth_approved');
  const conditionalPassed = applicableConditionalChecks.filter((name) => evaluation.conditional_checks[name]).length;
  const metrics = {
    automated_checks_total: AUTOMATED_CHECKS.length,
    automated_checks_passed: automatedPassed,
    conditional_checks_total: applicableConditionalChecks.length,
    conditional_checks_passed: conditionalPassed,
  };
  if (evaluation.runtime.openmontage_code_used || evaluation.runtime.remotion_runtime_used) {
    writeResult(resultsPath, result('NO_GO', fixture, ['CLEAN_ROOM_BOUNDARY_VIOLATED'], [], metrics, admittedIdentities));
    console.error('NO_GO: clean-room boundary violated');
    process.exit(1);
  }
  const failed = AUTOMATED_CHECKS.filter((name) => !evaluation.checks[name]);
  if (failed.length > 0) {
    writeResult(resultsPath, result('NO_GO', fixture, [
      'AUTOMATED_VIDEO_CHECK_FAILED', ...failed.map((name) => `FAILED_${name.toUpperCase()}`),
    ], [], metrics, admittedIdentities));
    console.error(`NO_GO: ${failed.join(', ')}`);
    process.exit(1);
  }
  const missingConditional = applicableConditionalChecks.filter((name) => !evaluation.conditional_checks[name]);
  const decision = missingConditional.length === 0 ? 'GO' : 'CONDITIONAL_GO';
  writeResult(resultsPath, result(decision, fixture, [], missingConditional.map((name) => CONDITIONAL_LIMITATIONS[name]), metrics, admittedIdentities));
  console.log(`${decision} ${fixture}: automated=${automatedPassed}/${AUTOMATED_CHECKS.length} conditional=${conditionalPassed}/${applicableConditionalChecks.length}`);
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeResult(resultsPath, result('NO_GO', fixture, ['VIDEO_EVALUATION_INVALID'], [message], null, {
    evaluation_sha256: null,
    evaluation_receipt_sha256: null,
  }));
  console.error(`INVALID ${fixture}: ${message}`);
  process.exit(1);
}
