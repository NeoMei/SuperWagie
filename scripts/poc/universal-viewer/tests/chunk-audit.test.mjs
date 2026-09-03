import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditChunkData } from '../chunk-audit.mjs';

function manifest(chunkId, files, bytes = 1024) {
  return {
    chunk_id: chunkId,
    status: 'poc_built',
    compressed_bytes: bytes,
    installed_bytes: bytes * 2,
    files,
    signature_state: 'poc_unsigned_not_loadable',
    production_loadable: false,
  };
}

function fixture(t, manifests, extraFiles = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'viewer-chunk-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const item of manifests) {
    const candidate = item.manifest_candidate ?? item;
    const chunkId = candidate.chunk_id;
    const files = item.files ?? [
      ...(candidate.code ?? []),
      ...(candidate.assets ?? []),
      ...(candidate.fonts ?? []),
      ...(candidate.license_refs ?? []),
      ...(candidate.notice_refs ?? []),
    ];
    const chunk = path.join(root, chunkId);
    mkdirSync(chunk, { recursive: true });
    for (const file of files) {
      const target = path.join(chunk, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'fixture');
    }
    writeFileSync(path.join(chunk, 'chunk-manifest.poc.json'), `${JSON.stringify(item)}\n`);
  }
  for (const file of extraFiles) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'unowned');
  }
  return root;
}

test('rejects overlapping logical files across built chunks', (t) => {
  const dist = fixture(t, [manifest('viewer-base', ['shared.js']), manifest('viewer-office', ['shared.js'])]);
  const result = auditChunkData({ distRoot: dist });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.violations.some((item) => item.rule === 'overlapping_file'));
});

test('rejects files not owned by any chunk manifest', (t) => {
  const dist = fixture(t, [manifest('viewer-base', ['base.js'])], ['orphan.js']);
  const result = auditChunkData({ distRoot: dist });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.violations.some((item) => item.rule === 'unowned_file'));
});

test('rejects unsigned fixtures unless they are explicitly non-loadable PoC evidence', (t) => {
  const bad = manifest('viewer-base', ['base.js']);
  bad.signature_state = 'unsigned';
  bad.production_loadable = true;
  const dist = fixture(t, [bad]);
  const result = auditChunkData({ distRoot: dist });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.violations.some((item) => item.rule === 'signature_state'));
});

test('rejects base plus office over 20 MiB and total chunks over 50 MiB', (t) => {
  const mib = 1024 * 1024;
  const dist = fixture(t, [
    manifest('viewer-base', ['base.js'], 11 * mib),
    manifest('viewer-office', ['office.js'], 10 * mib),
    manifest('viewer-media', ['media.js'], 30 * mib),
  ]);
  const result = auditChunkData({ distRoot: dist });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.violations.some((item) => item.rule === 'base_office_budget'));
  assert.ok(result.violations.some((item) => item.rule === 'total_budget'));
});

test('accepts measured non-loadable PoC manifests within both budgets', (t) => {
  const dist = fixture(t, [manifest('viewer-base', ['base.js']), manifest('viewer-office', ['office.js'])]);
  const result = auditChunkData({ distRoot: dist });
  assert.equal(result.decision, 'GO');
  assert.equal(result.poc_manifests_non_loadable, true);
});

test('rejects a PoC envelope whose manifest candidate omits an authoritative schema field', (t) => {
  const envelope = {
    schema_id: 'superwagie.viewer-chunk-manifest-poc-evidence.v1',
    signature_state: 'poc_unsigned_not_loadable',
    production_loadable: false,
    manifest_candidate: {
      chunk_id: 'viewer-base',
      chunk_version: '0.16.0',
      platform_id: 'macos-15-arm64',
      compressed_bytes: 1024,
      installed_bytes: 2048,
      code: ['base.js'],
      assets: [],
      fonts: [],
      descriptor_ids: ['core-base'],
      direct_dependencies: [],
      transitive_dependencies: [],
      license_refs: [],
      notice_refs: [],
      source_provenance: { identity: 'source', sha256: `sha256:${'0'.repeat(64)}` },
      build_provenance: { identity: 'build', sha256: `sha256:${'1'.repeat(64)}` },
      file_hashes: [{ logical_name: 'base.js', sha256: `sha256:${'2'.repeat(64)}` }],
      signature: 'poc_unsigned_not_loadable_reserved_sentinel_000',
    },
  };
  const dist = fixture(t, [envelope]);
  const result = auditChunkData({ distRoot: dist });
  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.violations.some((item) => item.rule === 'manifest_contract_shape'));
});
