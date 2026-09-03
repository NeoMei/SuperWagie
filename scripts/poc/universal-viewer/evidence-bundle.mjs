import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const REQUIRED_INPUTS = [
  'module-graph.json',
  'npm-audit.raw.json',
  'office-smoke.json',
  'package-lock.json',
  'patch-ledger.json',
  'source-lock.json',
  'source-sbom.cdx.json',
];

function fail(message) {
  throw new Error(`Build evidence rejected: ${message}`);
}

export function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function hashEntries(value, label) {
  exactObject(value, label);
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([logical_name, bytes]) => ({
    logical_name,
    sha256: sha256(bytes),
  }));
}

export function createBuildProvenance({ sourceIdentity, toolchain, inputs, outputs } = {}) {
  exactObject(sourceIdentity, 'source identity');
  exactObject(toolchain, 'toolchain');
  const missing = REQUIRED_INPUTS.filter((name) => !(name in exactObject(inputs, 'inputs')));
  if (missing.length) fail(`missing required inputs: ${missing.join(', ')}`);
  return {
    schema_id: 'superwagie.viewer-build-provenance.v1',
    source_identity: structuredClone(sourceIdentity),
    toolchain: structuredClone(toolchain),
    inputs: hashEntries(inputs, 'inputs'),
    outputs: hashEntries(outputs, 'outputs'),
  };
}

export function provenanceBytes(provenance) {
  return Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
}

export function verifyBuildProvenance({ provenance, sourceIdentity, toolchain, inputs, outputs } = {}) {
  const expected = createBuildProvenance({ sourceIdentity, toolchain, inputs, outputs });
  if (!isDeepStrictEqual(provenance, expected)) fail('bound input, toolchain, source identity, or output hash changed');
  return { provenance_sha256: sha256(provenanceBytes(provenance)) };
}

export function createEvidenceIndex(artifacts) {
  return {
    schema_id: 'superwagie.viewer-baseline-evidence-index.v1',
    artifacts: hashEntries(artifacts, 'artifacts'),
  };
}

export function verifyEvidenceIndex({ index, artifacts } = {}) {
  const expected = createEvidenceIndex(artifacts);
  if (!isDeepStrictEqual(index, expected)) fail('baseline artifact set or content changed');
  return true;
}
