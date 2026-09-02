import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { variedPng } from './helpers.mjs';
import { validateWpsTruthRecord } from '../src/task7-lib.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX = (seed) => sha256(Buffer.from(seed));

const identity = {
  target_kind: 'macos-app-bundle',
  executable_sha256: HEX('executable'),
  bundle_manifest_sha256: HEX('bundle'),
  bridge_sha256: HEX('bridge'),
};

function truthRecord(overrides = {}) {
  const page = variedPng(5, 5);
  return {
    schema: 'superwagie.wps-truth.v1',
    wps: {
      identity,
      version: '12.1.26055',
      session: { pid: 4242, started_at: '2026-09-02T04:00:00.000Z', receipt_sha256: HEX('receipt') },
    },
    source: { name: 'reviewer-torture-30p.docx', artifact_sha256: HEX('artifact') },
    output: { kind: 'pdf', pdf_sha256: HEX('pdf'), page_count: 1 },
    pages: [{ index: 1, bytes: page, sha256: sha256(page), width: 5, height: 5 }],
    ...overrides,
  };
}

test('a fully bound WPS truth record is accepted', () => {
  const result = validateWpsTruthRecord(truthRecord());
  assert.deepEqual(result, { ok: true, page_count: 1 });
});

test('wrong WPS executable identity is rejected', () => {
  const wrong = truthRecord();
  wrong.wps.identity = { ...identity, executable_sha256: HEX('other-executable') };
  const result = validateWpsTruthRecord(wrong, { expected_identity: identity });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WPS_IDENTITY_MISMATCH');
});

test('malformed WPS identity is rejected before comparison', () => {
  const malformed = truthRecord();
  malformed.wps.identity = { target_kind: 'web-view', executable_sha256: HEX('x') };
  const result = validateWpsTruthRecord(malformed);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WPS_IDENTITY_INVALID');
});

test('truth without a live WPS session binding is rejected', () => {
  const unbound = truthRecord();
  unbound.wps.session = null;
  const result = validateWpsTruthRecord(unbound);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WPS_SESSION_UNBOUND');
});

test('truth without the converted output binding is rejected', () => {
  const unbound = truthRecord();
  unbound.output = { kind: 'pdf', page_count: 1 };
  const result = validateWpsTruthRecord(unbound);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WPS_OUTPUT_UNBOUND');
});

test('page truth with mismatched bytes is rejected', () => {
  const poisoned = truthRecord();
  poisoned.pages[0].sha256 = HEX('poisoned-page');
  const result = validateWpsTruthRecord(poisoned);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAGE_TRUTH_INVALID');
});
