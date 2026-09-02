import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const script = path.join(repoRoot, 'scripts', 'poc', 'gate-1', 'markdown-gate.mjs');
let runSequence = 0;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function makeBoundReview() {
  runSequence += 1;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-md-binding-test-'));
  const runId = '20991231T235959Z-' + process.pid + String(runSequence).padStart(3, '0');
  const vault = path.join(tmp, 'vault');
  const reviewDir = path.join(vault, 'SuperWagie验收', 'G1-MARKDOWN-001', runId);
  const reviewPath = path.join(reviewDir, 'torture-edited.md');
  const preparationArtifactDir = path.join(repoRoot, 'evidence', 'gate-1', runId, 'artifacts');
  const preparedBytes = Buffer.from('# prepared review\n', 'utf8');
  const savedBytes = Buffer.from('# prepared review\n\nObsidian saved edit.\n', 'utf8');

  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.mkdirSync(preparationArtifactDir, { recursive: true });
  fs.writeFileSync(reviewPath, savedBytes);

  const preparation = {
    fixture: 'G1-MARKDOWN-001',
    run_id: runId,
    vault,
    review_path: reviewPath,
    sha256: sha256(preparedBytes),
    source_sha256: sha256(Buffer.from('# source\n', 'utf8')),
    dependency_files: []
  };
  const preparationPath = path.join(preparationArtifactDir, 'obsidian-review.json');
  fs.writeFileSync(preparationPath, JSON.stringify(preparation, null, 2) + '\n');

  const checklist = {
    schema_id: 'superwagie.g1-markdown-obsidian-checklist.v1',
    schema_version: 1,
    fixture: 'G1-MARKDOWN-001',
    reviewed_run: runId,
    platform: 'macos-15-arm64',
    host: {
      application: 'Obsidian',
      version: '1.13.7',
      vault
    },
    executed_at: '2026-09-01T20:39:50+08:00',
    executed_by: 'test operator',
    all_passed: true,
    items: [1, 2, 3, 4].map(function (id) {
      return { id, passed: true, evidence: 'host observation ' + id };
    }),
    artifact_binding: {
      prepared_vault_sha256: sha256(preparedBytes),
      saved_vault_sha256: sha256(savedBytes),
      review_path: reviewPath
    },
    owner_signature: null,
    notes: 'Execution evidence only.'
  };

  return {
    tmp,
    runId,
    vault,
    reviewPath,
    preparation,
    preparationPath,
    preparationEvidenceDir: path.join(repoRoot, 'evidence', 'gate-1', runId),
    checklist,
    savedBytes
  };
}

function runGate(fixture, checklistOverride = fixture.checklist, options = {}) {
  const executionDir = fs.mkdtempSync(path.join(fixture.tmp, 'execution-'));
  const resultsPath = path.join(executionDir, 'results.json');
  const artifactsDir = path.join(executionDir, 'artifacts');
  const args = [
    script,
    '--fixture', 'G1-MARKDOWN-001',
    '--platform', 'macos-15-arm64',
    '--results-json', resultsPath,
    '--artifacts-dir', artifactsDir
  ];
  let checklistPath = null;
  let checklistBytes = null;
  if (checklistOverride !== null) {
    checklistPath = path.join(executionDir, 'checklist.json');
    checklistBytes = Buffer.isBuffer(checklistOverride)
      ? checklistOverride
      : Buffer.from(JSON.stringify(checklistOverride, null, 2) + '\n');
    fs.writeFileSync(checklistPath, checklistBytes);
    args.push('--checklist-result', checklistPath);
  }
  const processResult = spawnSync(process.execPath, [...(options.nodeArgs || []), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) }
  });
  const results = fs.existsSync(resultsPath)
    ? JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
    : null;
  return { processResult, results, resultsPath, artifactsDir, checklistBytes };
}

function cleanup(fixture) {
  fs.rmSync(fixture.preparationEvidenceDir, { recursive: true, force: true });
  fs.rmSync(fixture.tmp, { recursive: true, force: true });
}

test('accepts only a hash-bound Obsidian checklist and preserves the unsigned Owner boundary', function () {
  const fixture = makeBoundReview();
  try {
    const actual = runGate(fixture);
    assert.equal(actual.processResult.status, 0, actual.processResult.stderr || actual.processResult.stdout);
    assert.equal(actual.results.pass, true);
    assert.equal(actual.results.decision_hint, 'GO');
    assert.deepEqual(actual.results.evidence_binding, {
      reviewed_run: fixture.runId,
      checklist_sha256: sha256(actual.checklistBytes),
      prepared_vault_sha256: fixture.checklist.artifact_binding.prepared_vault_sha256,
      saved_vault_sha256: fixture.checklist.artifact_binding.saved_vault_sha256,
      review_path: fixture.reviewPath,
      host: fixture.checklist.host,
      owner_signature_status: 'unsigned'
    });
    assert.deepEqual(
      fs.readFileSync(path.join(actual.artifactsDir, 'checklist-result.json')),
      actual.checklistBytes,
      'the raw checklist receipt must be copied without reserialization'
    );
    assert.deepEqual(
      fs.readFileSync(path.join(actual.artifactsDir, 'reviewed-obsidian-review.json')),
      fs.readFileSync(fixture.preparationPath),
      'the reviewed preparation receipt must be copied without reserialization'
    );
    assert.deepEqual(fs.readFileSync(fixture.reviewPath), fixture.savedBytes, 'verification must not modify the reviewed Vault file');
  } finally {
    cleanup(fixture);
  }
});

test('fails closed for legacy or incomplete checklist receipts instead of returning conditional GO', function () {
  const fixture = makeBoundReview();
  try {
    const legacy = {
      fixture: 'G1-MARKDOWN-001',
      all_passed: true,
      items: [true, true, true, true]
    };
    const actual = runGate(fixture, legacy);
    assert.equal(actual.processResult.status, 1, actual.processResult.stderr || actual.processResult.stdout);
    assert.equal(actual.results.pass, false);
    assert.equal(actual.results.decision_hint, 'NO_GO');
  } finally {
    cleanup(fixture);
  }
});

test('rejects undeclared fields at every v1 receipt object boundary', function () {
  const fixture = makeBoundReview();
  try {
    const cases = [
      ['checklist', function (checklist) { checklist.untrusted_owner_claim = 'signed'; }],
      ['host', function (checklist) { checklist.host.owner_signature_status = 'signed'; }],
      ['item', function (checklist) { checklist.items[0].owner_signature = 'signed'; }],
      ['artifact_binding', function (checklist) { checklist.artifact_binding.owner = 'Markdown Engine'; }],
      ['preparation', function (_checklist, preparation) { preparation.owner_signature_status = 'signed'; }]
    ];
    for (const [label, mutate] of cases) {
      const checklist = structuredClone(fixture.checklist);
      const preparation = structuredClone(fixture.preparation);
      mutate(checklist, preparation);
      fs.writeFileSync(fixture.preparationPath, JSON.stringify(preparation, null, 2) + '\n');
      const actual = runGate(fixture, checklist);
      assert.equal(actual.processResult.status, 1, label + ': ' + (actual.processResult.stderr || actual.processResult.stdout));
      assert.equal(actual.results.decision_hint, 'NO_GO', label);
      assert.equal(actual.results.evidence_binding, undefined, label);
    }
  } finally {
    cleanup(fixture);
  }
});

test('rejects duplicate JSON keys before JSON.parse can collapse them', function () {
  const fixture = makeBoundReview();
  try {
    const bytes = Buffer.from(JSON.stringify(fixture.checklist, null, 2)
      .replace('"id": 1,', '"id": 1,\n      "id": 1,') + '\n');
    const actual = runGate(fixture, bytes);
    assert.equal(actual.processResult.status, 1, actual.processResult.stderr || actual.processResult.stdout);
    assert.equal(actual.results.decision_hint, 'NO_GO');
    assert.equal(actual.results.evidence_binding, undefined);
  } finally {
    cleanup(fixture);
  }
});

test('rejects a checklist that names a preparation run that does not exist', function () {
  const fixture = makeBoundReview();
  try {
    const checklist = structuredClone(fixture.checklist);
    checklist.reviewed_run = '20990101T000000Z-404';
    const actual = runGate(fixture, checklist);
    assert.equal(actual.processResult.status, 1, actual.processResult.stderr || actual.processResult.stdout);
    assert.equal(actual.results.decision_hint, 'NO_GO');
  } finally {
    cleanup(fixture);
  }
});

test('rejects prepared and saved SHA-256 tampering', function () {
  const fixture = makeBoundReview();
  try {
    for (const field of ['prepared_vault_sha256', 'saved_vault_sha256']) {
      const checklist = structuredClone(fixture.checklist);
      checklist.artifact_binding[field] = '0'.repeat(64);
      const actual = runGate(fixture, checklist);
      assert.equal(actual.processResult.status, 1, field + ': ' + (actual.processResult.stderr || actual.processResult.stdout));
      assert.equal(actual.results.decision_hint, 'NO_GO', field);
    }
  } finally {
    cleanup(fixture);
  }
});

test('rejects tampering in every preparation receipt identity binding', function () {
  const fixture = makeBoundReview();
  try {
    const mutations = [
      ['fixture', 'G1-MARKDOWN-OTHER'],
      ['run_id', '20990101T000000Z-1'],
      ['vault', path.join(fixture.tmp, 'other-vault')],
      ['review_path', path.join(fixture.tmp, 'other.md')],
      ['sha256', 'f'.repeat(64)]
    ];
    for (const [field, value] of mutations) {
      const preparation = { ...fixture.preparation, [field]: value };
      fs.writeFileSync(fixture.preparationPath, JSON.stringify(preparation, null, 2) + '\n');
      const actual = runGate(fixture);
      assert.equal(actual.processResult.status, 1, field + ': ' + (actual.processResult.stderr || actual.processResult.stdout));
      assert.equal(actual.results.decision_hint, 'NO_GO', field);
    }
  } finally {
    cleanup(fixture);
  }
});

test('rejects a symlink or directory in place of the reviewed regular file', function () {
  const fixture = makeBoundReview();
  try {
    const realFile = path.join(fixture.tmp, 'real-reviewed.md');
    fs.writeFileSync(realFile, fixture.savedBytes);
    fs.rmSync(fixture.reviewPath);
    fs.symlinkSync(realFile, fixture.reviewPath);
    let actual = runGate(fixture);
    assert.equal(actual.processResult.status, 1, 'symlink: ' + (actual.processResult.stderr || actual.processResult.stdout));
    assert.equal(actual.results.decision_hint, 'NO_GO');

    fs.rmSync(fixture.reviewPath);
    fs.mkdirSync(fixture.reviewPath);
    actual = runGate(fixture);
    assert.equal(actual.processResult.status, 1, 'directory: ' + (actual.processResult.stderr || actual.processResult.stdout));
    assert.equal(actual.results.decision_hint, 'NO_GO');
  } finally {
    cleanup(fixture);
  }
});

test('rejects a reviewed path that escapes the declared Vault and run directory', function () {
  const fixture = makeBoundReview();
  try {
    const escapedPath = path.join(fixture.tmp, 'escaped.md');
    fs.writeFileSync(escapedPath, fixture.savedBytes);
    const checklist = structuredClone(fixture.checklist);
    checklist.artifact_binding.review_path = escapedPath;
    const preparation = { ...fixture.preparation, review_path: escapedPath };
    fs.writeFileSync(fixture.preparationPath, JSON.stringify(preparation, null, 2) + '\n');
    const actual = runGate(fixture, checklist);
    assert.equal(actual.processResult.status, 1, actual.processResult.stderr || actual.processResult.stdout);
    assert.equal(actual.results.decision_hint, 'NO_GO');
  } finally {
    cleanup(fixture);
  }
});

test('rejects a preparation run or artifacts directory that is an intermediate symlink', function () {
  const fixture = makeBoundReview();
  try {
    const outsideRun = path.join(fixture.tmp, 'outside-preparation-run');
    fs.mkdirSync(path.join(outsideRun, 'artifacts'), { recursive: true });
    fs.copyFileSync(fixture.preparationPath, path.join(outsideRun, 'artifacts', 'obsidian-review.json'));
    fs.rmSync(fixture.preparationEvidenceDir, { recursive: true, force: true });
    fs.symlinkSync(outsideRun, fixture.preparationEvidenceDir);
    const actual = runGate(fixture);
    assert.equal(actual.processResult.status, 1, actual.processResult.stderr || actual.processResult.stdout);
    assert.equal(actual.results.decision_hint, 'NO_GO');
  } finally {
    cleanup(fixture);
  }
});

test('rejects a same-inode same-size in-place rewrite that occurs after the first read', function () {
  const fixture = makeBoundReview();
  try {
    const replacement = Buffer.from(fixture.savedBytes);
    replacement[0] = replacement[0] === 35 ? 33 : 35;
    const hook = path.join(fixture.tmp, 'rewrite-after-read.mjs');
    fs.writeFileSync(hook, [
      "import fs from 'node:fs';",
      "const target = process.env.SUPERWAGIE_TEST_REWRITE_TARGET;",
      "const replacement = Buffer.from(process.env.SUPERWAGIE_TEST_REWRITE_BYTES, 'base64');",
      "const identity = fs.statSync(target, { bigint: true });",
      "const originalReadSync = fs.readSync.bind(fs);",
      "let rewritten = false;",
      "fs.readSync = function (fd, ...args) {",
      "  const count = originalReadSync(fd, ...args);",
      "  const opened = fs.fstatSync(fd, { bigint: true });",
      "  if (!rewritten && count === 0 && opened.dev === identity.dev && opened.ino === identity.ino) {",
      "    fs.writeFileSync(target, replacement);",
      "    rewritten = true;",
      "  }",
      "  return count;",
      "};",
      ''
    ].join('\n'));
    const actual = runGate(fixture, fixture.checklist, {
      nodeArgs: ['--import', hook],
      env: {
        SUPERWAGIE_TEST_REWRITE_TARGET: fixture.reviewPath,
        SUPERWAGIE_TEST_REWRITE_BYTES: replacement.toString('base64')
      }
    });
    assert.deepEqual(fs.readFileSync(fixture.reviewPath), replacement, 'the fault injector must perform the same-size rewrite');
    assert.equal(actual.processResult.status, 1, actual.processResult.stderr || actual.processResult.stdout);
    assert.equal(actual.results.decision_hint, 'NO_GO');
  } finally {
    cleanup(fixture);
  }
});

test('keeps CONDITIONAL_GO when no checklist result is provided', function () {
  const fixture = makeBoundReview();
  try {
    const actual = runGate(fixture, null);
    assert.equal(actual.processResult.status, 0, actual.processResult.stderr || actual.processResult.stdout);
    assert.equal(actual.results.pass, true);
    assert.equal(actual.results.decision_hint, 'CONDITIONAL_GO');
    assert.equal(actual.results.evidence_binding, undefined);
  } finally {
    cleanup(fixture);
  }
});
