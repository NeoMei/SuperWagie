import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

const EXECUTOR = resolve('scripts/poc/gate-4/video-gate.mjs');
const ARTIFACTS = ['scene_ir', 'sample_mp4', 'final_mp4', 'subtitles_srt', 'cover_png', 'provenance', 'qa'];
const AUTOMATED = [
  'sample_duration_10_to_15_seconds', 'final_duration_30_to_60_seconds',
  'video_stream_present', 'audio_stream_present', 'fps_is_30', 'motion_present',
  'narration_present', 'subtitles_present', 'black_frame_qa_passed',
  'silence_qa_passed', 'local_rerender_isolated', 'cancel_resume_recovered',
  'clean_room_dependencies_absent', 'headless_chromium_frame_renderer_executed',
  'profile_visual_truth_preserved',
];
const CONDITIONAL = ['human_time_review_approved', 'credits_idempotency_verified', 'windows_decode_verified'];

function makeEvaluation(root, fixture = 'G4-VIDEO-003', overrides = {}) {
  const artifacts = {};
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  for (const name of ARTIFACTS) {
    const extension = name.includes('mp4') ? '.mp4' : name.endsWith('png') ? '.png'
      : name.endsWith('srt') ? '.srt' : '.json';
    const path = `artifacts/${name}${extension}`;
    const bytes = Buffer.from(`${name}-evidence\n`);
    writeFileSync(join(root, path), bytes);
    artifacts[name] = {
      path,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes: bytes.length,
    };
  }
  const document = {
    schema_id: 'superwagie.g4-video-evaluation.v1', schema_version: 1,
    fixture, platform: 'macos-15-arm64', profile: 'ppt_explainer',
    executed_at: '2026-09-01T00:00:00.000Z',
    runtime: {
      renderer: 'superwagie-clean-room-poc', ffmpeg_version: '9.0.1',
      openmontage_commit_researched: 'cd9f3c1f03368be87b140af494914b8ee4e3c7a4',
      openmontage_code_used: false, remotion_runtime_used: false,
    },
    artifacts,
    checks: Object.fromEntries(AUTOMATED.map((name) => [name, true])),
    conditional_checks: Object.fromEntries(CONDITIONAL.map((name) => [name, false])),
    ...overrides,
  };
  const file = join(root, 'evaluation.json');
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

function run(fixture, evaluation) {
  const output = mkdtempSync(join(tmpdir(), 'superwagie-g4-video-results-'));
  const completed = spawnSync(process.execPath, [
    EXECUTOR, '--fixture', fixture, '--platform', 'macos-15-arm64',
    '--results-json', join(output, 'results.json'), '--artifacts-dir', join(output, 'artifacts'),
    '--evaluation-result', evaluation,
  ], { encoding: 'utf8' });
  return { completed, document: JSON.parse(readFileSync(join(output, 'results.json'), 'utf8')), output };
}

test('real media checks pass conditionally until human, Credits, and Windows checks exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g4-video-eval-'));
  const result = run('G4-VIDEO-003', makeEvaluation(root));
  assert.equal(result.completed.status, 0);
  assert.equal(result.document.decision_hint, 'CONDITIONAL_GO');
  assert.equal(result.document.metrics.automated_checks_passed, AUTOMATED.length);
  assert.equal(result.document.metrics.conditional_checks_passed, 0);
  assert.equal(result.document.limitations.length, 3);
});

test('a failed deterministic media check is NO_GO', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g4-video-eval-'));
  const checks = Object.fromEntries(AUTOMATED.map((name) => [name, true]));
  checks.clean_room_dependencies_absent = false;
  const result = run('G4-VIDEO-003', makeEvaluation(root, 'G4-VIDEO-003', { checks }));
  assert.equal(result.completed.status, 1);
  assert.equal(result.document.decision_hint, 'NO_GO');
  assert.ok(result.document.reasons.includes('FAILED_CLEAN_ROOM_DEPENDENCIES_ABSENT'));
});

test('OpenMontage or Remotion production use fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g4-video-eval-'));
  const runtime = {
    renderer: 'superwagie-clean-room-poc', ffmpeg_version: '9.0.1',
    openmontage_commit_researched: 'cd9f3c1f03368be87b140af494914b8ee4e3c7a4',
    openmontage_code_used: true, remotion_runtime_used: false,
  };
  const result = run('G4-VIDEO-003', makeEvaluation(root, 'G4-VIDEO-003', { runtime }));
  assert.equal(result.completed.status, 1);
  assert.equal(result.document.decision_hint, 'NO_GO');
  assert.ok(result.document.reasons.includes('CLEAN_ROOM_BOUNDARY_VIOLATED'));
});

test('fixture identity mismatch is invalid evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g4-video-eval-'));
  const result = run('G4-VIDEO-002', makeEvaluation(root, 'G4-VIDEO-003'));
  assert.equal(result.completed.status, 1);
  assert.equal(result.document.decision_hint, 'NO_GO');
  assert.ok(result.document.reasons.includes('VIDEO_EVALUATION_INVALID'));
});

test('replacing a referenced artifact is rejected and cannot reuse the prior result', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g4-video-tamper-'));
  const evaluation = makeEvaluation(root);
  const baseline = run('G4-VIDEO-003', evaluation);
  assert.equal(baseline.completed.status, 0);

  const original = readFileSync(join(root, 'artifacts/subtitles_srt.srt'));
  writeFileSync(join(root, 'artifacts/subtitles_srt.srt'), Buffer.concat([original, Buffer.from('TAMPERED\n')]));
  const tampered = run('G4-VIDEO-003', evaluation);
  assert.equal(tampered.completed.status, 1);
  assert.equal(tampered.document.decision_hint, 'NO_GO');
  assert.ok(tampered.document.reasons.includes('VIDEO_EVALUATION_INVALID'));
  assert.notEqual(
    createHash('sha256').update(readFileSync(join(baseline.output, 'results.json'))).digest('hex'),
    createHash('sha256').update(readFileSync(join(tampered.output, 'results.json'))).digest('hex'),
  );
});

test('coordinated evaluation and artifact rewrite changes the admitted evaluation identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g4-video-coordinated-'));
  const evaluationPath = makeEvaluation(root);
  const baseline = run('G4-VIDEO-003', evaluationPath);
  assert.equal(baseline.completed.status, 0);

  const artifactPath = join(root, 'artifacts/subtitles_srt.srt');
  const rewritten = Buffer.from('coordinated but different subtitles\n');
  writeFileSync(artifactPath, rewritten);
  const evaluation = JSON.parse(readFileSync(evaluationPath, 'utf8'));
  evaluation.artifacts.subtitles_srt.sha256 = `sha256:${createHash('sha256').update(rewritten).digest('hex')}`;
  evaluation.artifacts.subtitles_srt.bytes = rewritten.length;
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);

  const coordinated = run('G4-VIDEO-003', evaluationPath);
  assert.equal(coordinated.completed.status, 0);
  assert.notEqual(baseline.document.evaluation_sha256, coordinated.document.evaluation_sha256);
  assert.notEqual(baseline.document.evaluation_receipt_sha256, coordinated.document.evaluation_receipt_sha256);
  assert.notEqual(
    createHash('sha256').update(readFileSync(join(baseline.output, 'results.json'))).digest('hex'),
    createHash('sha256').update(readFileSync(join(coordinated.output, 'results.json'))).digest('hex'),
  );
});
