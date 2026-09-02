import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditFixtureSet, buildSourceDefinitions, definitions, validateRelativePath } from './fixture-audit.mjs';

test('G3-REVIEW-001 has three primary formats and matching hashes', async () => {
  const result = await auditFixtureSet('G3-REVIEW-001');
  assert.deepEqual(result.primaryFormats.sort(), ['docx', 'pdf', 'pptx']);
  assert.equal(result.hashMismatches.length, 0);
  assert.equal(result.provenanceViolations.length, 0);
});

test('G3-REVIEW-001 has exact authoritative definitions and validated bytes', async () => {
  assert.deepEqual(definitions, [
    { path: 'fixtures/reviewer-torture-30p.docx', format: 'docx', expected_pages: 30 },
    { path: 'fixtures/reviewer-torture-20s.pptx', format: 'pptx', expected_pages: 20 },
    { path: 'fixtures/reviewer-torture-100p.pdf', format: 'pdf', expected_pages: 100 },
    { path: 'fixtures/corrupt-tail.pdf', format: 'pdf-corrupt', expected_outcome: 'failed_terminal' },
    { path: 'fixtures/oversize-placeholder.bin', format: 'oversize', expected_outcome: 'unsupported' }
  ]);
  const result = await auditFixtureSet('G3-REVIEW-001');
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingFiles, []);
  assert.deepEqual(result.signatureViolations, []);
  assert.deepEqual(result.countViolations, []);
  assert.deepEqual(result.featureViolations, []);
  assert.equal(result.files.find((item) => item.format === 'docx').observedCount, 30);
  assert.equal(result.files.find((item) => item.format === 'pptx').observedCount, 20);
  assert.equal(result.files.find((item) => item.format === 'pdf').observedCount, 100);
});

test('G3-REVIEW-001 has durable hashed builders and a pinned reproduction recipe', async () => {
  assert.deepEqual(buildSourceDefinitions.map(({ path: sourcePath }) => sourcePath), [
    'builders/build_docx.py',
    'builders/patch_docx_ooxml.py',
    'builders/build_pptx.mjs',
    'builders/build_pdf.py',
    'builders/structural_audit.py',
    'builders/runtime-lock.json',
    'builders/reproduce.sh',
    'builders/README.md',
  ]);
  const result = await auditFixtureSet('G3-REVIEW-001');
  assert.deepEqual(result.builderViolations, []);
});

test('manifest path validator rejects absolute, Codex.app, and root-escaping paths', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixtureRoot = path.resolve(here, '../../../fixtures/gate-3/G3-REVIEW-001');
  assert.ok(validateRelativePath('/tmp/outside.pdf', fixtureRoot).length > 0);
  assert.ok(validateRelativePath('fixtures/Codex.app/resource.pdf', fixtureRoot).length > 0);
  assert.ok(validateRelativePath('../outside.pdf', fixtureRoot).length > 0);
  assert.ok(validateRelativePath('..\\outside.pdf', fixtureRoot).length > 0);
  assert.ok(validateRelativePath('C:\\outside.pdf', fixtureRoot).length > 0);
  assert.ok(validateRelativePath('//server/share/outside.pdf', fixtureRoot).length > 0);
  assert.ok(validateRelativePath('fixtures//reviewer-torture-100p.pdf', fixtureRoot).length > 0);
  assert.ok(validateRelativePath('fixtures/./reviewer-torture-100p.pdf', fixtureRoot).length > 0);
  assert.deepEqual(validateRelativePath('fixtures/reviewer-torture-100p.pdf', fixtureRoot), []);
});

test('audit rejects an outside manifest path before touching the outside candidate', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixtureRoot = path.resolve(here, '../../../fixtures/gate-3/G3-REVIEW-001');
  const manifestPath = path.join(fixtureRoot, 'fixture-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files[0] = { ...manifest.files[0], path: '/private/tmp/fixture-audit-outside.docx' };
  const outsideAccesses = [];
  const observedFs = {
    existsSync(candidate) {
      if (!candidate.startsWith(fixtureRoot)) outsideAccesses.push(['existsSync', candidate]);
      return fs.existsSync(candidate);
    },
    realpathSync(candidate) {
      if (!candidate.startsWith(fixtureRoot)) outsideAccesses.push(['realpathSync', candidate]);
      return fs.realpathSync(candidate);
    },
    readFileSync(candidate, encoding) {
      if (!candidate.startsWith(fixtureRoot)) outsideAccesses.push(['readFileSync', candidate]);
      return fs.readFileSync(candidate, encoding);
    },
  };

  const result = await auditFixtureSet('G3-REVIEW-001', { fs: observedFs, manifest });

  assert.ok(result.provenanceViolations.some((item) => item.includes('absolute path')));
  assert.deepEqual(outsideAccesses, []);
});

test('audit rejects a disallowed fixture id before any filesystem access', async () => {
  const accesses = [];
  const observedFs = {
    existsSync(candidate) { accesses.push(['existsSync', candidate]); return false; },
    realpathSync(candidate) { accesses.push(['realpathSync', candidate]); return candidate; },
    readFileSync(candidate) { accesses.push(['readFileSync', candidate]); throw new Error('must not read'); },
  };

  await assert.rejects(
    auditFixtureSet('../G3-REVIEW-001', { fs: observedFs }),
    /unsupported fixture/,
  );
  assert.deepEqual(accesses, []);
});

test('audit detects a safe-looking parent symlink escape before reading candidate bytes', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixtureRoot = path.resolve(here, '../../../fixtures/gate-3/G3-REVIEW-001');
  const escapedParent = path.join(fixtureRoot, 'fixtures', 'linked-outside');
  const escapedCandidate = path.join(escapedParent, 'outside.docx');
  const manifest = {
    fixture: 'G3-REVIEW-001',
    provenance: 'SuperWagie project-owned torture documents generated for technical validation',
    redistributable: true,
    files: [{ path: 'fixtures/linked-outside/outside.docx', format: 'docx', expected_pages: 30, sha256: 'a'.repeat(64) }],
    build_sources: [],
  };
  const candidateReads = [];
  const observedFs = {
    existsSync(candidate) { return candidate === escapedParent || candidate === escapedCandidate; },
    realpathSync(candidate) {
      if (candidate === fixtureRoot) return fixtureRoot;
      if (candidate === escapedParent) return '/private/tmp/fixture-audit-symlink-target';
      return candidate;
    },
    readFileSync(candidate) { candidateReads.push(candidate); throw new Error('candidate must not be read'); },
  };

  const result = await auditFixtureSet('G3-REVIEW-001', { fs: observedFs, manifest });

  assert.ok(result.provenanceViolations.some((item) => item.includes('parent symlink escapes fixture root')));
  assert.deepEqual(candidateReads, []);
});

test('G3-REVIEW-002 contains the exact ten required isolation scenarios', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const scenariosPath = path.resolve(here, '../../../fixtures/gate-3/G3-REVIEW-002/scenarios.json');
  const scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  assert.equal(scenarios.fixture, 'G3-REVIEW-002');
  assert.deepEqual(scenarios.scenarios, [
    { id: 'codex-never-installed', required: true },
    { id: 'codex-installed-not-running', required: true },
    { id: 'codex-running', required: true },
    { id: 'codex-config-mutated', required: true },
    { id: 'wps-missing', required: true },
    { id: 'wps-timeout', required: true },
    { id: 'wps-crash', required: true },
    { id: 'webview-restart', required: true },
    { id: 'cache-corrupt', required: true },
    { id: 'source-revision-changed', required: true }
  ]);
});
