import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectImageBytes,
  readGitBlobFromSnapshot,
  readCleanDetachedGitSnapshot,
  validateGenerationReceiptBytes,
  validateWriterCollectorReceiptBytes,
  validateWpsAutomationObservationBytes,
  verifyGenerationExecutableClosure,
} from './writer-evidence-trust.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const HASH = (value) => createHash('sha256').update(value).digest('hex');
const FIXTURE = 'G3-WRITER-001';
const PLATFORM = 'macos-15-arm64';

function generationReceipt() {
  return {
    schema_id: 'superwagie.g3-writer-generation-receipt.v1', schema_version: 1,
    fixture: FIXTURE, platform: PLATFORM, generation_id: 'generation-1', generated_at: '2026-09-01T12:00:00.000Z',
    sources: {
      superwriter: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), status: 'clean', snapshot: 'detached' },
      wpscomposer: { commit: 'c'.repeat(40), tree: 'd'.repeat(40), status: 'clean', snapshot: 'detached' },
    },
    invocation: {
      capability_id: 'superwriter.writer', capability_version: '1.2.3',
      executable_source_path: 'scripts/generate.py', executable_sha256: 'e'.repeat(64), arguments_sha256: 'f'.repeat(64),
    },
    artifacts: {
      source_md_sha256: '1'.repeat(64), canonical_docx_sha256: '2'.repeat(64),
      restart_docx_sha256: '3'.repeat(64), pdf_sha256: '4'.repeat(64),
    },
  };
}

test('page evidence is a decodable media container with machine-verifiable dimensions', () => {
  assert.deepEqual(inspectImageBytes(PNG, 'page evidence'), { media_type: 'image/png', width: 1, height: 1 });
  assert.throws(() => inspectImageBytes(Buffer.from('not really a png\n'), 'page evidence'), /image|PNG|JPEG|media/i);
  assert.throws(() => inspectImageBytes(PNG, 'page evidence', { minWidth: 320, minHeight: 240 }), /dimensions|minimum|page/i);
});

test('PNG evidence rejects a valid payload when any chunk CRC is corrupted', () => {
  const corrupted = Buffer.from(PNG);
  corrupted[29] ^= 0x01;
  assert.throws(() => inspectImageBytes(corrupted, 'page evidence'), /CRC|PNG/i);
});

test('JPEG evidence rejects a truncated scan with fabricated frame dimensions', () => {
  const truncated = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xff, 0xd9,
  ]);
  assert.throws(() => inspectImageBytes(truncated, 'page evidence'), /JPEG|scan|table|decode|entropy/i);
});

test('trusted page evidence rejects JPEG instead of trusting a partial container parser', () => {
  const malformed = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64),
    Buffer.from([
      0xff, 0xc4, 0x00, 0x14, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00,
    ]),
    Buffer.from([
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80,
      0x01, 0x01, 0x11, 0x00,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
      0x00,
      0xff, 0xd9,
    ]),
  ]);
  assert.equal(malformed.length, 119);
  assert.throws(
    () => inspectImageBytes(malformed, 'page evidence', { minWidth: 320, minHeight: 240 }),
    /JPEG.*not accepted|PNG.*required|unsupported.*JPEG/i,
  );
});

test('generation receipt exact schema binds clean detached sources, invocation, and artifact hashes', () => {
  const receipt = generationReceipt();
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const expected = {
    fixture: FIXTURE, platform: PLATFORM,
    superwriter: receipt.sources.superwriter, wpscomposer: receipt.sources.wpscomposer,
    artifacts: receipt.artifacts,
  };
  assert.equal(validateGenerationReceiptBytes(bytes, expected).receiptSha256, HASH(bytes));
  expected.artifacts = { ...expected.artifacts, pdf_sha256: '9'.repeat(64) };
  assert.throws(() => validateGenerationReceiptBytes(bytes, expected), /artifact.*binding|pdf.*mismatch/i);
  receipt.sources.superwriter.status = 'dirty';
  assert.throws(() => validateGenerationReceiptBytes(Buffer.from(JSON.stringify(receipt)), {}), /clean.*detached|source/i);
});

test('source snapshot verification fails closed for dirty or attached checkouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-source-snapshot-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  writeFileSync(join(root, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  assert.throws(() => readCleanDetachedGitSnapshot(root, 'source'), /detached/i);
  execFileSync('git', ['-C', root, 'checkout', '--detach', '-q']);
  const snapshot = readCleanDetachedGitSnapshot(root, 'source');
  assert.equal(snapshot.status, 'clean'); assert.equal(snapshot.snapshot, 'detached');
  writeFileSync(join(root, 'tracked.txt'), 'dirty\n');
  assert.throws(() => readCleanDetachedGitSnapshot(root, 'source'), /not clean|dirty/i);
});

test('generation executable bytes are read from the verified immutable Git tree, not the mutable worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-source-blob-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  writeFileSync(join(root, 'generate.py'), 'trusted snapshot\n');
  execFileSync('git', ['-C', root, 'add', 'generate.py']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  execFileSync('git', ['-C', root, 'checkout', '--detach', '-q']);
  const snapshot = readCleanDetachedGitSnapshot(root, 'source');
  writeFileSync(join(root, 'generate.py'), 'mutated worktree\n');

  const immutable = readGitBlobFromSnapshot(root, snapshot, 'generate.py', 'generation executable');
  assert.equal(immutable.bytes.toString('utf8'), 'trusted snapshot\n');
  assert.match(immutable.oid, /^[a-f0-9]{40,64}$/);
  assert.equal(immutable.sha256, HASH(Buffer.from('trusted snapshot\n')));
});

test('generation receipt v2 binds immutable SuperWriter and WPSComposer executable blobs', () => {
  const repositories = {};
  for (const name of ['superwriter', 'wpscomposer']) {
    const root = mkdtempSync(join(tmpdir(), `superwagie-${name}-closure-`));
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    writeFileSync(join(root, 'runtime.js'), `${name} trusted runtime\n`);
    execFileSync('git', ['-C', root, 'add', 'runtime.js']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
    execFileSync('git', ['-C', root, 'checkout', '--detach', '-q']);
    const snapshot = readCleanDetachedGitSnapshot(root, name);
    const blob = readGitBlobFromSnapshot(root, snapshot, 'runtime.js', name);
    repositories[name] = { root, snapshot, blob };
  }
  const receipt = generationReceipt();
  receipt.schema_id = 'superwagie.g3-writer-generation-receipt.v2'; receipt.schema_version = 2;
  receipt.sources = {
    superwriter: repositories.superwriter.snapshot,
    wpscomposer: repositories.wpscomposer.snapshot,
  };
  delete receipt.invocation.executable_source_path;
  delete receipt.invocation.executable_sha256;
  receipt.invocation.executables = ['superwriter', 'wpscomposer'].map((repository) => ({
    repository,
    source_path: 'runtime.js',
    git_blob_oid: repositories[repository].blob.oid,
    sha256: repositories[repository].blob.sha256,
  }));
  const validation = validateGenerationReceiptBytes(Buffer.from(JSON.stringify(receipt)));
  assert.equal(verifyGenerationExecutableClosure(validation.receipt, {
    superwriter: repositories.superwriter,
    wpscomposer: repositories.wpscomposer,
  }), true);

  writeFileSync(join(repositories.wpscomposer.root, 'runtime.js'), 'mutated worktree runtime\n');
  assert.equal(verifyGenerationExecutableClosure(validation.receipt, {
    superwriter: repositories.superwriter,
    wpscomposer: repositories.wpscomposer,
  }), true);
  validation.receipt.invocation.executables[1].sha256 = '0'.repeat(64);
  assert.throws(() => verifyGenerationExecutableClosure(validation.receipt, {
    superwriter: repositories.superwriter,
    wpscomposer: repositories.wpscomposer,
  }), /WPSComposer|executable|blob|hash/i);
});

function collectorAttestationPayload(receipt) {
  const { attestation: _attestation, ...signedFields } = receipt;
  return Buffer.from(JSON.stringify(signedFields));
}

test('collector receipt is authenticated only by a signer authorized outside the evidence', () => {
  const evaluationBytes = Buffer.from('{"schema_id":"superwagie.g3-writer-evaluation.v4"}\n');
  const collectorBytes = Buffer.from('trusted collector executable\n');
  const authorized = generateKeyPairSync('ed25519');
  const attacker = generateKeyPairSync('ed25519');
  const trustConfig = {
    schema_id: 'superwagie.g3-writer-collector-trust.v1', schema_version: 1,
    fixture: FIXTURE, authorization: 'writer-go-collector',
    signers: [{
      signer_id: 'authorized-host-collector', algorithm: 'ed25519',
      public_key_pem: authorized.publicKey.export({ type: 'spki', format: 'pem' }),
      platforms: [PLATFORM], status: 'active',
    }],
  };
  const receipt = {
    schema_id: 'superwagie.g3-writer-collector-receipt.v5', schema_version: 5,
    fixture: FIXTURE, platform: PLATFORM,
    run_identity: { run_id: 'run-1', evaluation_id: 'writer-evaluation-run-1' },
    collected_at: '2026-09-02T01:00:00.000Z',
    collector_executable_sha256: HASH(collectorBytes), evaluation_sha256: HASH(evaluationBytes),
    automation_observation_sha256: '1'.repeat(64), generation_receipt_sha256: '2'.repeat(64),
    renderer_identity_sha256: '3'.repeat(64), wps_session_id: 'wps-session-1',
    superwriter_commit: 'a'.repeat(40), superwriter_tree: 'b'.repeat(40),
    wpscomposer_commit: 'c'.repeat(40), wpscomposer_tree: 'd'.repeat(40),
    human_receipt_sha256: null,
    attestation: null,
  };
  receipt.attestation = {
    signer_id: 'authorized-host-collector', algorithm: 'ed25519',
    signature_base64: sign(null, collectorAttestationPayload(receipt), authorized.privateKey).toString('base64'),
  };
  const expected = {
    fixture: FIXTURE, platform: PLATFORM, run_identity: receipt.run_identity,
    collector_executable_sha256: HASH(collectorBytes), evaluation_sha256: HASH(evaluationBytes),
  };
  const valid = validateWriterCollectorReceiptBytes(Buffer.from(JSON.stringify(receipt)), expected, trustConfig);
  assert.equal(valid.authenticated, true);
  assert.equal(valid.signerId, 'authorized-host-collector');

  receipt.attestation.signature_base64 = sign(null, collectorAttestationPayload(receipt), attacker.privateKey).toString('base64');
  assert.throws(
    () => validateWriterCollectorReceiptBytes(Buffer.from(JSON.stringify(receipt)), expected, trustConfig),
    /signature|authenticated|authorized signer/i,
  );
  receipt.attestation.public_key_pem = attacker.publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(
    () => validateWriterCollectorReceiptBytes(Buffer.from(JSON.stringify(receipt)), expected, trustConfig),
    /keys.*exact|attestation/i,
  );
});

test('collector receipt without authorized signing material remains explicitly unauthenticated', () => {
  const receipt = {
    schema_id: 'superwagie.g3-writer-collector-receipt.v5', schema_version: 5,
    fixture: FIXTURE, platform: PLATFORM,
    run_identity: { run_id: 'run-unsigned', evaluation_id: 'writer-evaluation-run-unsigned' },
    collected_at: '2026-09-02T01:00:00.000Z',
    collector_executable_sha256: '0'.repeat(64), evaluation_sha256: '1'.repeat(64),
    automation_observation_sha256: '2'.repeat(64), generation_receipt_sha256: '3'.repeat(64),
    renderer_identity_sha256: '4'.repeat(64), wps_session_id: 'wps-session-unsigned',
    superwriter_commit: 'a'.repeat(40), superwriter_tree: 'b'.repeat(40),
    wpscomposer_commit: 'c'.repeat(40), wpscomposer_tree: 'd'.repeat(40),
    human_receipt_sha256: null, attestation: null,
  };
  const validation = validateWriterCollectorReceiptBytes(Buffer.from(JSON.stringify(receipt)), {
    fixture: FIXTURE, platform: PLATFORM, run_identity: receipt.run_identity,
    collector_executable_sha256: receipt.collector_executable_sha256,
    evaluation_sha256: receipt.evaluation_sha256,
  }, {
    schema_id: 'superwagie.g3-writer-collector-trust.v1', schema_version: 1,
    fixture: FIXTURE, authorization: 'writer-go-collector', signers: [],
  });
  assert.equal(validation.authenticated, false);
  assert.equal(validation.signerId, null);
});

test('WPS observation binds renderer identity, session, run, and actual screenshot media facts', () => {
  const renderer = {
    application: 'WPS Office', application_path: '/Applications/wpsoffice.app', bundle_id: 'com.kingsoft.wpsoffice.mac',
    version: '12.1.28492', build: '1001', executable_path: '/Applications/wpsoffice.app/Contents/MacOS/wpsoffice',
    executable_sha256: 'a'.repeat(64), codesign_identifier: 'com.kingsoft.wpsoffice.mac', team_identifier: 'YK4WKE5WAM',
  };
  const screenshot = { sha256: HASH(PNG), media_type: 'image/png', width: 1, height: 1, session_id: 'wps-session-1' };
  const observation = {
    schema_id: 'superwagie.g3-writer-wps-automation-observation.v2', schema_version: 2,
    fixture: FIXTURE, platform: PLATFORM, executed_at: '2026-09-01T12:20:00.000Z', operator_role: 'technical-validation-operator',
    session: { session_id: 'wps-session-1', run_id: 'run-1', started_at: '2026-09-01T12:10:00.000Z', finished_at: '2026-09-01T12:20:00.000Z' },
    renderer_identity: renderer, document: 'writer-restarted.docx', document_sha256_after_automation: 'b'.repeat(64),
    observations: { wps_opened_real_document: true, wps_edit_entered_dirty_state: true, wps_undo_restored_original_text: true, canonical_hash_unchanged: true, wps_discard_close_reopen_confirmed: false },
    screenshots: { opened: screenshot, edited: screenshot, restored: screenshot, discard_prompt: screenshot }, note: 'observed',
  };
  const expected = {
    fixture: FIXTURE, platform: PLATFORM, run_id: 'run-1', restart_docx_sha256: 'b'.repeat(64),
    screenshots: { opened: { sha256: HASH(PNG), media_type: 'image/png', width: 1, height: 1 }, edited: { sha256: HASH(PNG), media_type: 'image/png', width: 1, height: 1 }, restored: { sha256: HASH(PNG), media_type: 'image/png', width: 1, height: 1 }, discard_prompt: { sha256: HASH(PNG), media_type: 'image/png', width: 1, height: 1 } },
  };
  const valid = validateWpsAutomationObservationBytes(Buffer.from(JSON.stringify(observation)), expected);
  assert.equal(valid.sessionId, 'wps-session-1');
  observation.screenshots.edited.session_id = 'other-session';
  assert.throws(() => validateWpsAutomationObservationBytes(Buffer.from(JSON.stringify(observation)), expected), /session.*binding|session.*mismatch/i);
});
