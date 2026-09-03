import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createBuildProvenance,
  verifyBuildProvenance,
  verifyEvidenceIndex,
} from '../evidence-bundle.mjs';

const sourceIdentity = {
  commit: 'f'.repeat(40),
  archive_sha256: 'a'.repeat(64),
};
const toolchain = {
  node: '24.18.0',
  npm: '11.16.0',
  git: 'git version 2.51.0',
  platform: 'darwin',
  arch: 'arm64',
  bundler: 'rolldown@1.1.5',
  sbom_command: 'npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx',
};
const inputs = {
  'source-lock.json': Buffer.from('source-lock'),
  'patch-ledger.json': Buffer.from('patch-ledger'),
  'package-lock.json': Buffer.from('package-lock'),
  'source-sbom.cdx.json': Buffer.from('sbom'),
  'npm-audit.raw.json': Buffer.from('audit'),
  'module-graph.json': Buffer.from('graph'),
  'office-smoke.json': Buffer.from('smoke'),
};
const outputs = {
  'viewer-base/viewer-base.mjs': Buffer.from('base'),
  'viewer-office/viewer-office.mjs': Buffer.from('office'),
};

test('rejects tampering of every bound source, ledger, lock, SBOM, audit, graph, toolchain, and output input', () => {
  const provenance = createBuildProvenance({ sourceIdentity, toolchain, inputs, outputs });
  verifyBuildProvenance({ provenance, sourceIdentity, toolchain, inputs, outputs });

  for (const name of Object.keys(inputs)) {
    const tampered = { ...inputs, [name]: Buffer.from(`${inputs[name]}!`) };
    assert.throws(() => verifyBuildProvenance({ provenance, sourceIdentity, toolchain, inputs: tampered, outputs }), name);
  }
  for (const name of Object.keys(outputs)) {
    const tampered = { ...outputs, [name]: Buffer.from(`${outputs[name]}!`) };
    assert.throws(() => verifyBuildProvenance({ provenance, sourceIdentity, toolchain, inputs, outputs: tampered }), name);
  }
  assert.throws(() => verifyBuildProvenance({ provenance, sourceIdentity: { ...sourceIdentity, commit: 'e'.repeat(40) }, toolchain, inputs, outputs }));
  assert.throws(() => verifyBuildProvenance({ provenance, sourceIdentity, toolchain: { ...toolchain, npm: '11.15.0' }, inputs, outputs }));
});

test('rejects missing, extra, and tampered artifacts in the immutable evidence index', () => {
  const artifacts = { 'audit.json': Buffer.from('audit'), 'manifest.json': Buffer.from('manifest') };
  const index = {
    schema_id: 'superwagie.viewer-baseline-evidence-index.v1',
    artifacts: Object.entries(artifacts).map(([logical_name, bytes]) => ({
      logical_name,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    })),
  };
  verifyEvidenceIndex({ index, artifacts });
  assert.throws(() => verifyEvidenceIndex({ index, artifacts: { ...artifacts, 'audit.json': Buffer.from('changed') } }));
  assert.throws(() => verifyEvidenceIndex({ index, artifacts: { 'audit.json': artifacts['audit.json'] } }));
  assert.throws(() => verifyEvidenceIndex({ index, artifacts: { ...artifacts, 'extra.json': Buffer.from('extra') } }));
});
