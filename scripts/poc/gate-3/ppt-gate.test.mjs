import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const EXECUTOR = resolve('scripts/poc/gate-3/ppt-gate.mjs');

function candidate(root, mode = 'coupled') {
  mkdirSync(join(root, 'src/deck'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'skills/superppt'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'superppt', version: '0.1.0' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'superppt', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'superppt', version: '0.1.0' } } }));
  writeFileSync(join(root, 'skills/superppt/SKILL.md'), '# SuperPPT\n');
  writeFileSync(join(root, 'src/deck/pptx.ts'), mode === 'coupled'
    ? 'const BUILDER = `import { Presentation } from "@oai/artifact-tool"`;\nprocess.env.RUNTIME_NODE_MODULES;\n'
    : mode === 'decoupled'
      ? 'import pptxgen from "pptxgenjs";\nimport { writePresentation } from "./presentation-service";\nwritePresentation(pptxgen);\n'
      : 'export const writer = "independent";\n');
  writeFileSync(join(root, 'src/deck/presentation-service.ts'), mode === 'adapter-coupled'
    ? 'const runtime = process.env.RUNTIME_BIN_DIR;\n'
    : 'export const adapter = "owned";\n');
  writeFileSync(join(root, 'scripts/test.ts'), mode === 'coupled'
    ? 'const root = "codex-runtimes/codex-primary-runtime";\n'
    : mode === 'runtime-spelling'
      ? 'const root = "codex-primary-runtime/codex-runtimes";\n'
    : 'const root = "superwagie-runtime";\n');
}

function run(root) {
  const out = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-results-'));
  const results = join(out, 'results.json');
  const artifacts = join(out, 'artifacts');
  const completed = spawnSync(process.execPath, [
    EXECUTOR, '--fixture', 'G3-PPT-001', '--platform', 'macos-15-arm64',
    '--results-json', results, '--artifacts-dir', artifacts, '--candidate-root', root,
  ], { encoding: 'utf8' });
  return { completed, results, artifacts };
}

test('direct Codex artifact runtime coupling is a NO_GO product defect', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-'));
  candidate(root, 'coupled');
  const { completed, results } = run(root);
  assert.equal(completed.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.decision_hint, 'NO_GO');
  assert.ok(document.reasons.includes('CODEX_ARTIFACT_TOOL_RUNTIME_COUPLING'));
  assert.ok(document.reasons.includes('REAL_THREE_SLIDE_FLOW_NOT_EXECUTED'));
  assert.ok(document.reasons.includes('REAL_WPS_SMOKE_NOT_EXECUTED'));
});

test('a decoupled source still blocks until the real three-slide evaluation is supplied', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-'));
  candidate(root, 'decoupled');
  const { completed, results } = run(root);
  assert.equal(completed.status, 2);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.decision_hint, 'BLOCKED_ENVIRONMENT');
  assert.deepEqual(document.reasons, ['REAL_PPT_EVALUATION_REQUIRED']);
});

test('a source without Codex strings or an owned adapter is a NO_GO', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-'));
  candidate(root, 'unowned');
  const { completed, results } = run(root);
  assert.equal(completed.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.decision_hint, 'NO_GO');
  assert.deepEqual(document.reasons, ['OWNED_PRESENTATION_SERVICE_MISSING']);
  assert.match(document.limitations[0], /SuperWagie-owned PresentationService|audited OOXML adapter/);
});

test('any codex-primary-runtime spelling in audited sources is a NO_GO', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-'));
  candidate(root, 'runtime-spelling');
  const { completed, results } = run(root);
  assert.equal(completed.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.decision_hint, 'NO_GO');
  assert.ok(document.reasons.includes('CODEX_ARTIFACT_TOOL_RUNTIME_COUPLING'));
});

test('a clean delegate cannot hide a coupled presentation-service adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-'));
  candidate(root, 'adapter-coupled');
  const { completed, results, artifacts } = run(root);
  assert.equal(completed.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.ok(document.reasons.includes('CODEX_ARTIFACT_TOOL_RUNTIME_COUPLING'));
  const audit = JSON.parse(readFileSync(join(artifacts, 'source-audit.json'), 'utf8'));
  assert.match(audit.sources['src/deck/presentation-service.ts'].sha256, /^[a-f0-9]{64}$/);
  assert.ok(audit.findings.forbidden_source_markers.includes('src/deck/presentation-service.ts:RUNTIME_BIN_DIR'));
  assert.match(audit.forbidden_marker_set_sha256, /^[a-f0-9]{64}$/);
});

test('candidate root and critical files fail closed on unsafe paths', () => {
  const relative = spawnSync(process.execPath, [
    EXECUTOR, '--fixture', 'G3-PPT-001', '--platform', 'macos-15-arm64',
    '--results-json', '/tmp/result.json', '--artifacts-dir', '/tmp/artifacts', '--candidate-root', 'relative',
  ], { encoding: 'utf8' });
  assert.equal(relative.status, 2);

  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-'));
  candidate(root, 'coupled');
  const real = join(root, 'real-pptx.ts');
  writeFileSync(real, 'safe\n');
  const linked = join(root, 'src/deck/pptx.ts');
  const original = join(root, 'src/deck/pptx-original.ts');
  writeFileSync(original, readFileSync(linked));
  // The test fixture owns this temporary directory, so replacing this one file is safe.
  unlinkSync(linked);
  symlinkSync(real, linked);
  const { completed, results } = run(root);
  assert.equal(completed.status, 1);
  assert.match(JSON.parse(readFileSync(results, 'utf8')).limitations[0], /non-symlink/i);
});

test('critical files fail closed when a parent directory is a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-'));
  candidate(root, 'decoupled');
  const outside = mkdtempSync(join(tmpdir(), 'superwagie-g3-ppt-outside-'));
  const outsideDeck = join(outside, 'deck');
  mkdirSync(outsideDeck);
  writeFileSync(join(outsideDeck, 'pptx.ts'), readFileSync(join(root, 'src/deck/pptx.ts')));
  writeFileSync(join(outsideDeck, 'presentation-service.ts'), readFileSync(join(root, 'src/deck/presentation-service.ts')));
  unlinkSync(join(root, 'src/deck/pptx.ts'));
  unlinkSync(join(root, 'src/deck/presentation-service.ts'));
  rmdirSync(join(root, 'src/deck'));
  symlinkSync(outsideDeck, join(root, 'src/deck'));
  const { completed, results } = run(root);
  assert.equal(completed.status, 1);
  assert.match(JSON.parse(readFileSync(results, 'utf8')).limitations[0], /parent directory.*non-symlink/i);
});
