import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const EXECUTOR = resolve(REPOSITORY_ROOT, 'scripts/poc/gate-3/html-gate.mjs');
const FIXTURE = resolve(REPOSITORY_ROOT, 'fixtures/gate-3/G3-HTML-001');
const PNG_BYTES = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('superwagie-browser-screenshot'),
]);

function evaluation(root, overrides = {}) {
  const screenshots = join(root, 'screenshots');
  mkdirSync(screenshots, { recursive: true });
  writeFileSync(join(screenshots, 'desktop.png'), PNG_BYTES);
  writeFileSync(join(screenshots, 'mobile.png'), PNG_BYTES);
  const document = {
    schema_id: 'superwagie.g3-html-browser-evaluation.v1',
    schema_version: 1,
    fixture: 'G3-HTML-001',
    platform: 'macos-15-arm64',
    executed_at: '2026-09-01T00:00:00.000Z',
    browser: { engine: 'Chromium', source: 'Codex browser runtime' },
    checks: {
      desktop_article_rendered: true,
      desktop_navigation_complete: true,
      mobile_layout_rendered: true,
      mobile_navigation_complete: true,
      console_errors_absent: true,
      external_requests_absent: true,
    },
    screenshots: {
      desktop: { path: 'screenshots/desktop.png' },
      mobile: { path: 'screenshots/mobile.png' },
    },
    ...overrides,
  };
  const file = join(root, 'evaluation.json');
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

function run(fixtureRoot, evaluationResult = '') {
  const output = mkdtempSync(join(tmpdir(), 'superwagie-g3-html-results-'));
  const args = [
    EXECUTOR, '--fixture', 'G3-HTML-001', '--platform', 'macos-15-arm64',
    '--fixture-root', fixtureRoot, '--results-json', join(output, 'results.json'),
    '--artifacts-dir', join(output, 'artifacts'),
  ];
  if (evaluationResult) args.push('--evaluation-result', evaluationResult);
  const completed = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const document = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8'));
  return { completed, document, output };
}

test('approved local HTML plus real browser evidence is CONDITIONAL_GO until Official Host exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-html-eval-'));
  const result = run(FIXTURE, evaluation(root));
  assert.equal(result.completed.status, 0);
  assert.equal(result.document.decision_hint, 'CONDITIONAL_GO');
  assert.equal(result.document.metrics.static_checks_passed, result.document.metrics.static_checks_total);
  assert.equal(result.document.metrics.browser_checks_passed, result.document.metrics.browser_checks_total);
  assert.deepEqual(result.document.reasons, []);
  assert.ok(result.document.limitations.some((item) => /Official Host/.test(item)));
});

test('missing browser evaluation is an environment block, not a fabricated pass', () => {
  const result = run(FIXTURE);
  assert.equal(result.completed.status, 2);
  assert.equal(result.document.decision_hint, 'BLOCKED_ENVIRONMENT');
  assert.deepEqual(result.document.reasons, ['REAL_BROWSER_EVALUATION_REQUIRED']);
});

test('external resources fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-html-fixture-'));
  cpSync(FIXTURE, root, { recursive: true });
  const index = join(root, 'site/index.html');
  writeFileSync(index, `${readFileSync(index, 'utf8')}\n<script src="https://example.invalid/tracker.js"></script>\n`);
  const evalRoot = mkdtempSync(join(tmpdir(), 'superwagie-g3-html-eval-'));
  const result = run(root, evaluation(evalRoot));
  assert.equal(result.completed.status, 1);
  assert.equal(result.document.decision_hint, 'NO_GO');
  assert.ok(result.document.reasons.includes('STATIC_HTML_AUDIT_FAILED'));
  rmSync(root, { recursive: true, force: true });
});

test('a false browser check fails the gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-html-eval-'));
  const checks = {
    desktop_article_rendered: true,
    desktop_navigation_complete: true,
    mobile_layout_rendered: false,
    mobile_navigation_complete: true,
    console_errors_absent: true,
    external_requests_absent: true,
  };
  const result = run(FIXTURE, evaluation(root, { checks }));
  assert.equal(result.completed.status, 1);
  assert.equal(result.document.decision_hint, 'NO_GO');
  assert.ok(result.document.reasons.includes('BROWSER_HTML_CHECK_FAILED'));
});

test('screenshot extension must match its raster signature', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g3-html-eval-'));
  const file = evaluation(root);
  writeFileSync(join(root, 'screenshots/desktop.png'), Buffer.from('ffd8ffe000104a464946', 'hex'));
  const result = run(FIXTURE, file);
  assert.equal(result.completed.status, 1);
  assert.equal(result.document.decision_hint, 'NO_GO');
  assert.deepEqual(result.document.reasons, ['HTML_EVIDENCE_INVALID']);
  assert.ok(result.document.limitations.some((item) => /PNG signature/.test(item)));
});
