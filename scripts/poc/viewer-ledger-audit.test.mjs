import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auditViewerLedgerData } from './viewer-ledger-audit.mjs';

const allGates = ['GVP-0', 'GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5'];
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function record(overrides = {}) {
  return {
    format_variant_id: 'office.docx.ooxml',
    extensions: ['docx'],
    container: 'zip-ooxml',
    target_support_modes: ['visual'],
    current_state: 'RESEARCH_REQUIRED',
    required_platforms: ['macos-15-arm64', 'windows-11-x64'],
    required_gates: allGates,
    corpus_id: 'GVP-CORPUS-OFFICE-DOCX-001',
    descriptor_id: 'viewer.office.docx',
    candidate_id: 'frozen-omni-core',
    candidate_version: '0.16.0-ffdcda3',
    chunk_manifest_sha256: null,
    admission_receipt_refs: [],
    ...overrides
  };
}

function receipt(overrides = {}) {
  return {
    receipt_id: 'receipt-gvp0-macos',
    gate_id: 'GVP-0',
    format_variant_id: 'office.docx.ooxml',
    viewer_id: 'frozen-omni-core',
    viewer_version: '0.16.0-ffdcda3',
    platform_id: 'macos-15-arm64',
    verdict: 'GO',
    corpus_id: 'GVP-CORPUS-OFFICE-DOCX-001',
    corpus_sha256: `sha256:${'a'.repeat(64)}`,
    chunk_manifest_sha256: `sha256:${'b'.repeat(64)}`,
    evidence_sha256: `sha256:${'c'.repeat(64)}`,
    issued_at: '2026-09-04T00:00:00Z',
    ...overrides
  };
}

function binding(document, overrides = {}) {
  const text = `${JSON.stringify(document)}\n`;
  return {
    ref: {
      receipt_id: document.receipt_id,
      gate_id: document.gate_id,
      platform_id: document.platform_id,
      receipt_path: `receipts/${document.receipt_id}.json`,
      receipt_sha256: sha(text),
      ...overrides
    },
    text
  };
}

function audit(records, options = {}) {
  return auditViewerLedgerData({
    ledger: { schema_version: 1, records },
    designExtensions: options.designExtensions ?? new Set(records.flatMap(item => item.extensions)),
    matrixGateMap: options.matrixGateMap ?? new Map(records.flatMap(item => item.required_gates.map(gate => [`VIEW-${gate.slice(-1)}`, gate]))),
    requireInitialResearch: options.requireInitialResearch ?? true,
    receiptResolver: options.receiptResolver,
    designGateMeanings: options.designGateMeanings,
    gateMeaningDocuments: options.gateMeaningDocuments
  });
}

test('rejects duplicate format_variant_id', () => {
  assert.match(audit([record(), record({ extensions: ['pptx'] })]).errors.join('\n'), /DUPLICATE_FORMAT_VARIANT_ID/);
});

test('rejects non-RESEARCH_REQUIRED initial records', () => {
  assert.match(audit([record({ current_state: 'PROVEN_POC' })]).errors.join('\n'), /INITIAL_STATE_NOT_RESEARCH_REQUIRED/);
});

test('rejects a design extension missing from the ledger', () => {
  assert.match(audit([record()], { designExtensions: new Set(['docx', 'pptx']) }).errors.join('\n'), /DESIGN_EXTENSION_MISSING_FROM_LEDGER.*pptx/);
});

test('rejects heterogeneous extensions consolidated into one admission record', () => {
  const result = audit([record({ format_variant_id: 'text.structured.mixed', extensions: ['json', 'yaml'], container: 'text' })]);
  assert.match(result.errors.join('\n'), /HETEROGENEOUS_VARIANTS_CONSOLIDATED.*json.*yaml/);
});

test('allows only true aliases with identical detection and parser behavior', () => {
  const result = audit([record({ format_variant_id: 'image.jpeg.binary', extensions: ['jpg', 'jpeg'], container: 'jpeg' })]);
  assert.doesNotMatch(result.errors.join('\n'), /HETEROGENEOUS_VARIANTS_CONSOLIDATED/);
});

test('rejects a matrix requirement without the same Gate mapping', () => {
  assert.match(audit([record()], { matrixGateMap: new Map([['VIEW-0', 'GVP-0']]) }).errors.join('\n'), /MATRIX_GATE_MAPPING_MISSING.*GVP-1/);
});

test('rejects any GVP meaning that differs from design section 12.5', () => {
  const designGateMeanings = new Map([
    ['GVP-0', 'Contract + Provenance'], ['GVP-1', 'Office Fidelity'], ['GVP-2', 'Per-format Corpus'],
    ['GVP-3', 'Isolation + Malicious Files'], ['GVP-4', 'Package + Performance'], ['GVP-5', 'Product Integration + Recovery']
  ]);
  const wrong = new Map(designGateMeanings);
  wrong.set('GVP-1', 'Per-format Corpus');
  const result = audit([record()], {
    designGateMeanings,
    gateMeaningDocuments: [{ path: 'docs/current.md', meanings: wrong }]
  });
  assert.match(result.errors.join('\n'), /GVP_GATE_MEANING_MISMATCH.*docs\/current\.md.*GVP-1/);
});

test('admits a PROVEN record only from resolvable GO receipts bound to every platform and gate', () => {
  const documents = new Map();
  const refs = [];
  for (const gateId of allGates) for (const platformId of ['macos-15-arm64', 'windows-11-x64']) {
    const document = receipt({ receipt_id: `receipt-${gateId}-${platformId}`, gate_id: gateId, platform_id: platformId });
    const bound = binding(document);
    refs.push(bound.ref);
    documents.set(bound.ref.receipt_path, bound.text);
  }
  const result = audit([record({
    current_state: 'PROVEN_POC',
    chunk_manifest_sha256: `sha256:${'b'.repeat(64)}`,
    admission_receipt_refs: refs
  })], { requireInitialResearch: false, receiptResolver: path => documents.get(path) });
  assert.deepEqual(result.errors, []);
});

test('rejects invented, missing, invalid, non-GO, or mismatched receipt bindings', () => {
  const mutations = [
    ['INVENTED_RECEIPT_ID', receipt(), { receipt_id: 'invented-receipt' }],
    ['RECEIPT_FILE_MISSING', receipt(), {}, true],
    ['RECEIPT_SCHEMA_INVALID', receipt({ plaintext_password: 'leak' })],
    ['RECEIPT_VERDICT_NOT_GO', receipt({ verdict: 'CONDITIONAL_GO' })],
    ['RECEIPT_FORMAT_MISMATCH', receipt({ format_variant_id: 'office.pptx.ooxml' })],
    ['RECEIPT_CORPUS_MISMATCH', receipt({ corpus_id: 'OTHER-CORPUS' })],
    ['RECEIPT_CHUNK_MISMATCH', receipt({ chunk_manifest_sha256: `sha256:${'d'.repeat(64)}` })],
    ['RECEIPT_CANDIDATE_MISMATCH', receipt({ viewer_id: 'other-viewer' })],
    ['RECEIPT_VERSION_MISMATCH', receipt({ viewer_version: 'other-version' })],
    ['RECEIPT_PLATFORM_MISMATCH', receipt({ platform_id: 'windows-11-x64' })],
    ['RECEIPT_GATE_MISMATCH', receipt({ gate_id: 'GVP-1' })]
  ];
  for (const [code, document, refOverrides = {}, missing = false] of mutations) {
    const bound = binding(document, { gate_id: 'GVP-0', platform_id: 'macos-15-arm64', ...refOverrides });
    const result = audit([record({
      current_state: 'PROVEN_EXISTING',
      required_platforms: ['macos-15-arm64'], required_gates: ['GVP-0'],
      chunk_manifest_sha256: `sha256:${'b'.repeat(64)}`,
      admission_receipt_refs: [bound.ref]
    })], { requireInitialResearch: false, receiptResolver: () => missing ? undefined : bound.text });
    assert.match(result.errors.join('\n'), new RegExp(code), code);
  }
});

test('rejects a receipt whose file hash does not match its binding', () => {
  const document = receipt();
  const bound = binding(document, { receipt_sha256: `sha256:${'f'.repeat(64)}` });
  const result = audit([record({
    current_state: 'PROVEN_POC', required_platforms: ['macos-15-arm64'], required_gates: ['GVP-0'],
    chunk_manifest_sha256: `sha256:${'b'.repeat(64)}`, admission_receipt_refs: [bound.ref]
  })], { requireInitialResearch: false, receiptResolver: () => bound.text });
  assert.match(result.errors.join('\n'), /RECEIPT_FILE_HASH_MISMATCH/);
});
