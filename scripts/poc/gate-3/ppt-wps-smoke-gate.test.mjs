import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

const EXECUTOR = resolve('scripts/poc/gate-3/ppt-wps-smoke-gate.mjs');
const SOURCE = resolve('evidence/gate-3/presentation-runtime-bundle-20260901T091243Z/artifacts/three-slide-bundled.pptx');
const FIXTURE = 'G3-PPT-WPS-MACOS-SMOKE-001';
const SOURCE_SHA256 = '853f89c05733671a6351bcbb7f1df2d0a7e55bec9c84ed56c4e78417ca3aa9e3';
const WPS_APP = '/Applications/wpsoffice.app';
const WPS_EXECUTABLE = '/Applications/wpsoffice.app/Contents/MacOS/wpsoffice';
const WPS_TEST = { skip: process.platform !== 'darwin' || process.arch !== 'arm64' || !existsSync(WPS_EXECUTABLE) };
const SCREENSHOTS = [
  'opened-slide-1.jpeg',
  'editable-title.jpeg',
  'undo-restored.jpeg',
  'saved-reopen.jpeg',
  'discard-prompt.jpeg',
  'discard-reopen.jpeg',
  'opened-slide-3.jpeg',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return out;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, typeBytes, data, crc32(Buffer.concat([typeBytes, data]))]);
}

function validPng(width = 1200, height = 800) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeSavedCopy(source, target) {
  const unpacked = mkdtempSync(join(tmpdir(), 'superwagie-ppt-wps-unpacked-'));
  execFileSync('/usr/bin/unzip', ['-q', source, '-d', unpacked]);
  const slide = join(unpacked, 'ppt/slides/slide2.xml');
  writeFileSync(slide, readFileSync(slide, 'utf8').replace('TITLE EDIT', 'TITLE SAVED'));
  execFileSync('/usr/bin/zip', ['-qr', target, '.'], { cwd: unpacked });
}

function prepareEvaluation() {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-ppt-wps-evaluation-'));
  const evidence = join(root, 'evidence');
  mkdirSync(join(evidence, 'screenshots'), { recursive: true });
  const source = join(evidence, 'source.pptx');
  const discard = join(evidence, 'discard-copy.pptx');
  const saved = join(evidence, 'save-copy.pptx');
  const identity = join(evidence, 'wps-identity.txt');
  cpSync(SOURCE, source);
  cpSync(SOURCE, discard);
  makeSavedCopy(SOURCE, saved);
  writeFileSync(identity, [
    'bundle_id=com.kingsoft.wpsoffice.mac',
    'version=12.1.28492',
    'build=28492',
    'team_identifier=YK4WKE5WAM',
    `app_path=${WPS_APP}`,
    `executable_path=${WPS_EXECUTABLE}`,
    'executable_sha256=b06539dcaa9cdb72dbb0b773c8f10693823f7ea79c63fa3d056f5482b6030261',
    'codesign_valid=true',
    '',
  ].join('\n'));
  for (const name of SCREENSHOTS) {
    writeFileSync(join(evidence, 'screenshots', name), validPng());
  }

  const files = [source, saved, discard, identity, ...SCREENSHOTS.map((name) => join(evidence, 'screenshots', name))]
    .map((path) => ({
      path: relative(root, path),
      sha256: sha256(readFileSync(path)),
    }));
  const evaluation = {
    schema_id: 'superwagie.g3-ppt-wps-macos-smoke-evaluation.v1',
    schema_version: 1,
    gate: 'gate-3-subprobe',
    fixture: FIXTURE,
    platform: 'macos-15-arm64',
    executed_at: '2026-09-01T10:20:24.000Z',
    operator_role: 'technical-validation-executor',
    source_sha256: SOURCE_SHA256,
    zoom: {
      requested_percent: 100,
      displayed_percent: 101,
      device_scale_adjusted: true,
    },
    wps: {
      bundle_id: 'com.kingsoft.wpsoffice.mac',
      version: '12.1.28492',
      build: '28492',
      team_identifier: 'YK4WKE5WAM',
      app_path: WPS_APP,
      executable_path: WPS_EXECUTABLE,
      executable_sha256: 'b06539dcaa9cdb72dbb0b773c8f10693823f7ea79c63fa3d056f5482b6030261',
    },
    assertions: {
      opened_without_document_repair_dialog: true,
      slide_count_3: true,
      slide_order_preserved: true,
      aspect_ratio_16_9: true,
      slide_1_visible: true,
      slide_2_visible: true,
      slide_3_visible: true,
      visual_quality_accepted_at_displayed_zoom: true,
      native_title_editable: true,
      undo_restored_title_edit: true,
      saved_reopen_title_saved: true,
      discard_reopen_title_edit: true,
      discard_hash_unchanged: true,
      source_hash_unchanged: true,
    },
    evidence: files,
  };
  const evaluationPath = join(root, 'evaluation.json');
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  return { root, evidence, evaluation, evaluationPath };
}

function run(evaluationPath) {
  const out = mkdtempSync(join(tmpdir(), 'superwagie-ppt-wps-results-'));
  const results = join(out, 'results.json');
  const artifacts = join(out, 'artifacts');
  const completed = spawnSync(process.execPath, [
    EXECUTOR,
    '--fixture', FIXTURE,
    '--platform', 'macos-15-arm64',
    '--results-json', results,
    '--artifacts-dir', artifacts,
    '--evaluation-result', evaluationPath,
  ], { encoding: 'utf8' });
  return { completed, results, artifacts };
}

test('a complete hash-bound WPS evaluation is conditional until owner-signed', WPS_TEST, () => {
  const { evaluationPath } = prepareEvaluation();
  const { completed, results, artifacts } = run(evaluationPath);
  assert.equal(completed.status, 0, completed.stderr);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.decision_hint, 'CONDITIONAL_GO');
  assert.equal(document.gate, 'gate-3-subprobe');
  assert.equal(document.metrics.parent_fixture_upgraded, false);
  assert.equal(document.metrics.source_sha256, SOURCE_SHA256);
  const savedSlide = execFileSync('/usr/bin/unzip', ['-p', join(artifacts, 'save-copy.pptx'), 'ppt/slides/slide2.xml'], { encoding: 'utf8' });
  assert.match(savedSlide, /TITLE SAVED/);
  assert.match(readFileSync(join(artifacts, 'wps-identity.txt'), 'utf8'), /com\.kingsoft\.wpsoffice\.mac/);
  assert.equal(JSON.parse(readFileSync(join(artifacts, 'evaluation-receipt.json'), 'utf8')).fixture, FIXTURE);
  assert.equal(JSON.parse(readFileSync(join(artifacts, 'live-wps-host-probe.json'), 'utf8')).codesign_valid, true);
  assert.deepEqual(readFileSync(join(artifacts, 'evaluation.json')), readFileSync(evaluationPath));
});

test('an all-true receipt without the required evidence fails closed', WPS_TEST, () => {
  const prepared = prepareEvaluation();
  prepared.evaluation.evidence = [];
  writeFileSync(prepared.evaluationPath, `${JSON.stringify(prepared.evaluation, null, 2)}\n`);
  const { completed, results } = run(prepared.evaluationPath);
  assert.equal(completed.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.decision_hint, 'NO_GO');
  assert.ok(document.reasons.includes('WPS_SMOKE_EVIDENCE_INVALID'));
});

test('evaluation evidence cannot escape its directory or use symlinks', WPS_TEST, () => {
  const escaped = prepareEvaluation();
  escaped.evaluation.evidence[0].path = '../outside.pptx';
  writeFileSync(join(dirname(escaped.root), 'outside.pptx'), 'outside');
  writeFileSync(escaped.evaluationPath, `${JSON.stringify(escaped.evaluation, null, 2)}\n`);
  const escapedRun = run(escaped.evaluationPath);
  assert.equal(escapedRun.completed.status, 1);
  assert.ok(JSON.parse(readFileSync(escapedRun.results, 'utf8')).reasons.includes('WPS_SMOKE_EVIDENCE_INVALID'));

  const linked = prepareEvaluation();
  const linkedPath = join(linked.root, linked.evaluation.evidence[0].path);
  cpSync(linkedPath, `${linkedPath}.real`);
  execFileSync('/bin/rm', [linkedPath]);
  symlinkSync(`${linkedPath}.real`, linkedPath);
  const linkedRun = run(linked.evaluationPath);
  assert.equal(linkedRun.completed.status, 1);
  assert.ok(JSON.parse(readFileSync(linkedRun.results, 'utf8')).reasons.includes('WPS_SMOKE_EVIDENCE_INVALID'));
});

test('hash drift and false saved-reopen content cannot pass', WPS_TEST, () => {
  const drifted = prepareEvaluation();
  const screenshot = join(drifted.root, drifted.evaluation.evidence.at(-1).path);
  writeFileSync(screenshot, 'tampered');
  const driftedRun = run(drifted.evaluationPath);
  assert.equal(driftedRun.completed.status, 1);

  const falseSaved = prepareEvaluation();
  const savedEntry = falseSaved.evaluation.evidence.find((entry) => entry.path.endsWith('save-copy.pptx'));
  const savedPath = join(falseSaved.root, savedEntry.path);
  cpSync(SOURCE, savedPath);
  savedEntry.sha256 = sha256(readFileSync(savedPath));
  writeFileSync(falseSaved.evaluationPath, `${JSON.stringify(falseSaved.evaluation, null, 2)}\n`);
  const falseSavedRun = run(falseSaved.evaluationPath);
  assert.equal(falseSavedRun.completed.status, 1);
  const document = JSON.parse(readFileSync(falseSavedRun.results, 'utf8'));
  assert.ok(document.reasons.includes('WPS_SMOKE_CONTENT_INVALID'));

  const fakeImage = prepareEvaluation();
  const imageEntry = fakeImage.evaluation.evidence.find((entry) => entry.path.endsWith('opened-slide-1.jpeg'));
  const imagePath = join(fakeImage.root, imageEntry.path);
  writeFileSync(imagePath, Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(128),
    Buffer.from([0xff, 0xd9]),
  ]));
  imageEntry.sha256 = sha256(readFileSync(imagePath));
  writeFileSync(fakeImage.evaluationPath, `${JSON.stringify(fakeImage.evaluation, null, 2)}\n`);
  const fakeImageRun = run(fakeImage.evaluationPath);
  assert.equal(fakeImageRun.completed.status, 1);
  assert.ok(JSON.parse(readFileSync(fakeImageRun.results, 'utf8')).reasons.includes('WPS_SMOKE_EVIDENCE_INVALID'));
});

test('WPS executable identity and codesign evidence must match the evaluation', WPS_TEST, () => {
  const wrongExecutable = prepareEvaluation();
  const identityEntry = wrongExecutable.evaluation.evidence.find((entry) => entry.path.endsWith('wps-identity.txt'));
  const identityPath = join(wrongExecutable.root, identityEntry.path);
  writeFileSync(identityPath, readFileSync(identityPath, 'utf8').replace(
    wrongExecutable.evaluation.wps.executable_sha256,
    '0'.repeat(64),
  ));
  identityEntry.sha256 = sha256(readFileSync(identityPath));
  writeFileSync(wrongExecutable.evaluationPath, `${JSON.stringify(wrongExecutable.evaluation, null, 2)}\n`);
  const wrongExecutableRun = run(wrongExecutable.evaluationPath);
  assert.equal(wrongExecutableRun.completed.status, 1);
  assert.ok(JSON.parse(readFileSync(wrongExecutableRun.results, 'utf8')).reasons.includes('WPS_SMOKE_EVIDENCE_INVALID'));

  const unsigned = prepareEvaluation();
  const unsignedIdentityEntry = unsigned.evaluation.evidence.find((entry) => entry.path.endsWith('wps-identity.txt'));
  const unsignedIdentityPath = join(unsigned.root, unsignedIdentityEntry.path);
  writeFileSync(unsignedIdentityPath, readFileSync(unsignedIdentityPath, 'utf8').replace('codesign_valid=true', 'codesign_valid=false'));
  unsignedIdentityEntry.sha256 = sha256(readFileSync(unsignedIdentityPath));
  writeFileSync(unsigned.evaluationPath, `${JSON.stringify(unsigned.evaluation, null, 2)}\n`);
  const unsignedRun = run(unsigned.evaluationPath);
  assert.equal(unsignedRun.completed.status, 1);
  assert.ok(JSON.parse(readFileSync(unsignedRun.results, 'utf8')).reasons.includes('WPS_SMOKE_EVIDENCE_INVALID'));

  const forgedHost = prepareEvaluation();
  const forgedIdentityEntry = forgedHost.evaluation.evidence.find((entry) => entry.path.endsWith('wps-identity.txt'));
  const forgedIdentityPath = join(forgedHost.root, forgedIdentityEntry.path);
  const fakeExecutableHash = '0'.repeat(64);
  writeFileSync(forgedIdentityPath, readFileSync(forgedIdentityPath, 'utf8').replace(
    forgedHost.evaluation.wps.executable_sha256,
    fakeExecutableHash,
  ));
  forgedHost.evaluation.wps.executable_sha256 = fakeExecutableHash;
  forgedIdentityEntry.sha256 = sha256(readFileSync(forgedIdentityPath));
  writeFileSync(forgedHost.evaluationPath, `${JSON.stringify(forgedHost.evaluation, null, 2)}\n`);
  const forgedHostRun = run(forgedHost.evaluationPath);
  assert.equal(forgedHostRun.completed.status, 1);
  assert.match(JSON.parse(readFileSync(forgedHostRun.results, 'utf8')).limitations[0], /live WPS identity mismatch/);
});

test('PPTX validation rejects an added fourth slide even when the receipt hash is updated', WPS_TEST, () => {
  const prepared = prepareEvaluation();
  const savedEntry = prepared.evaluation.evidence.find((entry) => entry.path.endsWith('save-copy.pptx'));
  const savedPath = join(prepared.root, savedEntry.path);
  const unpacked = mkdtempSync(join(tmpdir(), 'superwagie-ppt-wps-extra-slide-'));
  execFileSync('/usr/bin/unzip', ['-q', savedPath, '-d', unpacked]);
  cpSync(join(unpacked, 'ppt/slides/slide3.xml'), join(unpacked, 'ppt/slides/slide4.xml'));
  rmSync(savedPath);
  execFileSync('/usr/bin/zip', ['-qr', savedPath, '.'], { cwd: unpacked });
  savedEntry.sha256 = sha256(readFileSync(savedPath));
  writeFileSync(prepared.evaluationPath, `${JSON.stringify(prepared.evaluation, null, 2)}\n`);
  const completed = run(prepared.evaluationPath);
  assert.equal(completed.completed.status, 1);
  assert.ok(JSON.parse(readFileSync(completed.results, 'utf8')).reasons.includes('WPS_SMOKE_CONTENT_INVALID'));

  const reordered = prepareEvaluation();
  const reorderedEntry = reordered.evaluation.evidence.find((entry) => entry.path.endsWith('save-copy.pptx'));
  const reorderedPath = join(reordered.root, reorderedEntry.path);
  const reorderedUnpacked = mkdtempSync(join(tmpdir(), 'superwagie-ppt-wps-reordered-'));
  execFileSync('/usr/bin/unzip', ['-q', reorderedPath, '-d', reorderedUnpacked]);
  const relationshipsPath = join(reorderedUnpacked, 'ppt/_rels/presentation.xml.rels');
  const relationships = readFileSync(relationshipsPath, 'utf8')
    .replace('Target="slides/slide1.xml"', 'Target="slides/__swap__.xml"')
    .replace('Target="slides/slide2.xml"', 'Target="slides/slide1.xml"')
    .replace('Target="slides/__swap__.xml"', 'Target="slides/slide2.xml"');
  writeFileSync(relationshipsPath, relationships);
  rmSync(reorderedPath);
  execFileSync('/usr/bin/zip', ['-qr', reorderedPath, '.'], { cwd: reorderedUnpacked });
  reorderedEntry.sha256 = sha256(readFileSync(reorderedPath));
  writeFileSync(reordered.evaluationPath, `${JSON.stringify(reordered.evaluation, null, 2)}\n`);
  const reorderedRun = run(reordered.evaluationPath);
  assert.equal(reorderedRun.completed.status, 1);
  assert.ok(JSON.parse(readFileSync(reorderedRun.results, 'utf8')).reasons.includes('WPS_SMOKE_CONTENT_INVALID'));
});

test('the unified runner keeps the subprobe isolated from production admission', WPS_TEST, () => {
  const { evaluationPath } = prepareEvaluation();
  const completed = spawnSync(resolve('scripts/poc/run-gate.sh'), [
    'gate-3',
    '--platform', 'macos-15-arm64',
    '--fixture', FIXTURE,
    '--evaluation-result', evaluationPath,
  ], { cwd: resolve('.'), encoding: 'utf8' });
  const evidenceMatch = completed.stdout.match(/^evidence: (.+)$/m);
  try {
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    assert.ok(evidenceMatch, completed.stdout);
    const results = JSON.parse(readFileSync(join(evidenceMatch[1], 'results.json'), 'utf8'));
    assert.equal(results.gate, 'gate-3-subprobe');
    assert.equal(results.metrics.parent_fixture_upgraded, false);
    assert.equal(results.decision_hint, 'CONDITIONAL_GO');
    const decision = readFileSync(join(evidenceMatch[1], 'decision.md'), 'utf8');
    assert.match(decision, /- gate: gate-3-subprobe/);
    assert.match(decision, /- parent_gate: gate-3/);
    assert.match(decision, /- admission_effect: none/);
    const audit = spawnSync(process.execPath, [resolve('scripts/poc/validation-status-audit.mjs'), '--repo-root', resolve('.')], { encoding: 'utf8' });
    assert.equal(audit.status, 0, audit.stderr);
    const state = JSON.parse(audit.stdout);
    assert.equal(state.summary.expected, 31);
    assert.equal(state.summary.signed_go, 0);
    assert.equal(state.production_implementation_admission, 'NO_GO');
    assert.equal(state.fixtures.find((entry) => entry.fixture === 'G3-PPT-001').execution, 'no_go');
  } finally {
    if (evidenceMatch?.[1]?.startsWith(resolve('evidence/gate-3') + '/')) rmSync(evidenceMatch[1], { recursive: true, force: true });
  }
});
