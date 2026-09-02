import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readStableRegularFileSync } from '../secure-file-read.mjs';
import { inspectImageBytes } from './writer-evidence-trust.mjs';

export const WRITER_STAGE_IDS = Object.freeze([
  'writer.content_ready',
  'writer.requirements',
  'writer.top_outline',
  'writer.chapter_writing',
  'writer.illustrations',
  'writer.wps_composition',
  'writer.rendered_review',
]);
export const WRITER_HUMAN_GATE_IDS = Object.freeze([
  'writer.content_ready',
  'writer.requirements',
  'writer.top_outline',
]);
export const HUMAN_RECEIPT_SCHEMA_ID = 'superwagie.g3-writer-human-receipt.v1';
export const HUMAN_RECEIPT_SCHEMA_ID_V2 = 'superwagie.g3-writer-human-receipt.v2';
export const MAX_HUMAN_RECEIPT_BYTES = 1024 * 1024;
export const MAX_HUMAN_EVIDENCE_BYTES = 50 * 1024 * 1024;

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

export function assertExactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly ${wanted.join(',')}`);
  }
}

export function assertNoDuplicateJsonKeys(text) {
  let index = 0;
  const fail = (message) => { throw new Error(`${message} at byte ${index}`); };
  const whitespace = () => { while (/\s/.test(text[index] || '')) index += 1; };
  function string() {
    whitespace();
    if (text[index] !== '"') fail('expected JSON string');
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index] === '"') { index += 1; return JSON.parse(text.slice(start, index)); }
      index += 1;
    }
    fail('unterminated JSON string');
  }
  function value() {
    whitespace();
    if (text[index] === '{') return object();
    if (text[index] === '[') return array();
    if (text[index] === '"') { string(); return; }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    if (start === index) fail('expected JSON value');
    JSON.parse(text.slice(start, index));
  }
  function object() {
    index += 1; whitespace();
    const keys = new Set();
    if (text[index] === '}') { index += 1; return; }
    while (index < text.length) {
      const key = string();
      if (keys.has(key)) fail(`duplicate JSON key: ${key}`);
      keys.add(key); whitespace();
      if (text[index] !== ':') fail('expected colon');
      index += 1; value(); whitespace();
      if (text[index] === '}') { index += 1; return; }
      if (text[index] !== ',') fail('expected object separator');
      index += 1;
    }
    fail('unterminated JSON object');
  }
  function array() {
    index += 1; whitespace();
    if (text[index] === ']') { index += 1; return; }
    while (index < text.length) {
      value(); whitespace();
      if (text[index] === ']') { index += 1; return; }
      if (text[index] !== ',') fail('expected array separator');
      index += 1;
    }
    fail('unterminated JSON array');
  }
  value(); whitespace();
  if (index !== text.length) fail('unexpected trailing JSON bytes');
}

function validateArtifactRef(entry, receiptRoot, label) {
  assertExactKeys(entry, ['path', 'sha256'], label);
  if (typeof entry.path !== 'string' || entry.path.length === 0 || isAbsolute(entry.path)
    || entry.path === '.' || entry.path === '..' || entry.path.includes('/') || entry.path.includes('\\')) {
    throw new Error(`${label} path must be one contained basename`);
  }
  if (!HASH.test(entry.sha256)) throw new Error(`${label} hash is invalid`);
  const file = resolve(receiptRoot, entry.path);
  const bytes = readStableRegularFileSync(file, MAX_HUMAN_EVIDENCE_BYTES);
  const actualHash = sha256(bytes);
  if (actualHash !== entry.sha256) throw new Error(`${label} hash mismatch`);
  return { name: entry.path, sha256: actualHash, bytes };
}

function validateImageArtifactRef(entry, receiptRoot, label, trusted) {
  if (trusted) assertExactKeys(entry, ['path', 'sha256', 'media_type', 'width', 'height', 'session_id'], label);
  else assertExactKeys(entry, ['path', 'sha256'], label);
  if (typeof entry.path !== 'string' || entry.path.length === 0 || isAbsolute(entry.path)
    || entry.path === '.' || entry.path === '..' || entry.path.includes('/') || entry.path.includes('\\')) {
    throw new Error(`${label} path must be one contained basename`);
  }
  if (!HASH.test(entry.sha256)) throw new Error(`${label} hash is invalid`);
  const bytes = readStableRegularFileSync(resolve(receiptRoot, entry.path), MAX_HUMAN_EVIDENCE_BYTES);
  const actualHash = sha256(bytes);
  if (actualHash !== entry.sha256) throw new Error(`${label} hash mismatch`);
  const media = inspectImageBytes(bytes, label, trusted ? { minWidth: 320, minHeight: 240 } : undefined);
  if (trusted && (entry.media_type !== media.media_type || entry.width !== media.width || entry.height !== media.height)) {
    throw new Error(`${label} declared media format or dimensions mismatch the image bytes`);
  }
  return { name: entry.path, sha256: actualHash, bytes, media };
}

function assertSequence(entries, expected, key, label) {
  if (!Array.isArray(entries) || entries.length > expected.length) throw new Error(`${label} count is invalid`);
  const actual = entries.map((entry) => entry?.[key]);
  if (new Set(actual).size !== actual.length) throw new Error(`${label} contains duplicate IDs`);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) throw new Error(`${label} ID missing or out of order at index ${index}`);
  }
}

function assertIdentity(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
}

export function validateWriterHumanReceiptBytes(receiptBytes, receiptPath, expected) {
  const text = receiptBytes.toString('utf8');
  assertNoDuplicateJsonKeys(text);
  const receipt = JSON.parse(text);
  assertExactKeys(receipt, [
    'schema_id', 'schema_version', 'fixture', 'platform', 'run_id', 'evaluation_id',
    'executed_at', 'operator', 'bindings', 'stages', 'human_gates', 'visual_review', 'wps_lifecycle',
  ], 'human receipt');
  const trusted = receipt.schema_id === HUMAN_RECEIPT_SCHEMA_ID_V2 && receipt.schema_version === 2;
  const legacy = receipt.schema_id === HUMAN_RECEIPT_SCHEMA_ID && receipt.schema_version === 1;
  if (!legacy && !trusted) throw new Error('human receipt schema identity mismatch');
  if (receipt.fixture !== expected.fixture) throw new Error('human receipt fixture mismatch');
  if (receipt.platform !== expected.platform) throw new Error('human receipt platform mismatch');
  if (receipt.run_id !== expected.run_id) throw new Error('human receipt run identity mismatch');
  if (receipt.evaluation_id !== expected.evaluation_id) throw new Error('human receipt evaluation identity mismatch');
  if (!validTime(receipt.executed_at)) throw new Error('human receipt executed_at is invalid');

  assertExactKeys(receipt.operator, ['role', 'actor_id'], 'human receipt operator');
  assertIdentity(receipt.operator.role, 'operator role');
  assertIdentity(receipt.operator.actor_id, 'operator actor_id');
  if (receipt.operator.role !== expected.operator_role) throw new Error('human receipt operator role identity mismatch');

  assertExactKeys(receipt.bindings, [
    'source_md_sha256', 'canonical_docx_sha256', 'restart_docx_sha256', 'pdf_sha256',
    'automation_observation_sha256', 'superwriter_commit', 'wpscomposer_commit',
    ...(trusted ? ['generation_receipt_sha256', 'renderer_identity_sha256', 'wps_session_id'] : []),
  ], 'human receipt bindings');
  const bindingPairs = [
    ['source_md_sha256', expected.source_md_sha256],
    ['canonical_docx_sha256', expected.canonical_docx_sha256],
    ['restart_docx_sha256', expected.restart_docx_sha256],
    ['pdf_sha256', expected.pdf_sha256],
    ['automation_observation_sha256', expected.automation_observation_sha256],
    ['superwriter_commit', expected.superwriter_commit],
    ['wpscomposer_commit', expected.wpscomposer_commit],
    ...(trusted ? [
      ['generation_receipt_sha256', expected.generation_receipt_sha256],
      ['renderer_identity_sha256', expected.renderer_identity_sha256],
      ['wps_session_id', expected.wps_session_id],
    ] : []),
  ];
  for (const [key, wanted] of bindingPairs) {
    const pattern = key === 'wps_session_id' ? IDENTIFIER : key.endsWith('_commit') ? COMMIT : HASH;
    if (!pattern.test(receipt.bindings[key]) || receipt.bindings[key] !== wanted) throw new Error(`human receipt ${key} binding mismatch`);
  }

  const receiptRoot = dirname(receiptPath);
  const evidenceFiles = [];
  assertSequence(receipt.stages, WRITER_STAGE_IDS, 'stage_id', 'stage receipts');
  let priorRevision = -1;
  for (const [index, stage] of receipt.stages.entries()) {
    assertExactKeys(stage, ['stage_id', 'checkpoint_id', 'revision', 'artifact', 'completed_at'], `stage receipt ${index + 1}`);
    assertIdentity(stage.checkpoint_id, `stage ${index + 1} checkpoint_id`);
    if (!Number.isInteger(stage.revision) || stage.revision < 0 || stage.revision <= priorRevision) throw new Error(`stage ${index + 1} revision is invalid or out of order`);
    priorRevision = stage.revision;
    if (!validTime(stage.completed_at)) throw new Error(`stage ${index + 1} completed_at is invalid`);
    evidenceFiles.push(validateArtifactRef(stage.artifact, receiptRoot, `stage ${index + 1} artifact`));
  }

  assertSequence(receipt.human_gates, WRITER_HUMAN_GATE_IDS, 'gate_id', 'human gate receipts');
  priorRevision = -1;
  for (const [index, gate] of receipt.human_gates.entries()) {
    assertExactKeys(gate, ['gate_id', 'interaction_id', 'revision', 'decision', 'executed_at'], `human gate ${index + 1}`);
    assertIdentity(gate.interaction_id, `human gate ${index + 1} interaction_id`);
    if (!Number.isInteger(gate.revision) || gate.revision < 0 || gate.revision <= priorRevision) throw new Error(`human gate ${index + 1} revision is invalid or out of order`);
    priorRevision = gate.revision;
    if (!['approved', 'rejected', 'request_changes'].includes(gate.decision)) throw new Error(`human gate ${index + 1} decision is invalid`);
    if (!validTime(gate.executed_at)) throw new Error(`human gate ${index + 1} executed_at is invalid`);
  }

  assertExactKeys(receipt.visual_review, ['renderer', 'page_count', 'conclusion', 'reviewed_at', 'pages'], 'visual review');
  assertExactKeys(receipt.visual_review.renderer, ['application', 'version', ...(trusted ? ['identity_sha256', 'session_id'] : [])], 'visual review renderer');
  if (receipt.visual_review.renderer.application !== 'WPS Office' || typeof receipt.visual_review.renderer.version !== 'string'
    || receipt.visual_review.renderer.version.length === 0) throw new Error('visual review renderer must be real WPS Office');
  if (receipt.visual_review.renderer.version !== expected.wps_version) throw new Error('visual review renderer version mismatch');
  if (trusted && (receipt.visual_review.renderer.identity_sha256 !== expected.renderer_identity_sha256
    || receipt.visual_review.renderer.session_id !== expected.wps_session_id)) throw new Error('visual review WPS renderer/session binding mismatch');
  if (!Number.isInteger(receipt.visual_review.page_count) || receipt.visual_review.page_count < 1 || receipt.visual_review.page_count > 10000) {
    throw new Error('visual review page_count is invalid');
  }
  if (receipt.visual_review.page_count !== expected.pdf_page_count) throw new Error('visual review page_count document binding mismatch');
  if (!['pending', 'approved', 'rejected'].includes(receipt.visual_review.conclusion)) throw new Error('visual review conclusion is invalid');
  if (receipt.visual_review.reviewed_at !== null && !validTime(receipt.visual_review.reviewed_at)) throw new Error('visual review reviewed_at is invalid');
  if (!Array.isArray(receipt.visual_review.pages) || receipt.visual_review.pages.length > receipt.visual_review.page_count) throw new Error('visual review pages are invalid');
  for (const [index, page] of receipt.visual_review.pages.entries()) {
    assertExactKeys(page, ['page_number', 'conclusion', 'evidence'], `visual page ${index + 1}`);
    if (page.page_number !== index + 1) throw new Error('visual review page numbers must be unique, complete, and ordered');
    if (!['approved', 'rejected'].includes(page.conclusion)) throw new Error(`visual page ${index + 1} conclusion is invalid`);
    const evidence = validateImageArtifactRef(page.evidence, receiptRoot, `visual page ${index + 1} evidence`, trusted);
    if (trusted && page.evidence.session_id !== expected.wps_session_id) throw new Error(`visual page ${index + 1} evidence session binding mismatch`);
    evidenceFiles.push(evidence);
  }
  if (trusted && new Set(receipt.visual_review.pages.map((page) => page.evidence.sha256)).size !== receipt.visual_review.pages.length) {
    throw new Error('visual review pages must use distinct page captures');
  }
  if (receipt.visual_review.conclusion === 'approved'
    && (receipt.visual_review.pages.length !== receipt.visual_review.page_count
      || receipt.visual_review.pages.some((page) => page.conclusion !== 'approved')
      || !validTime(receipt.visual_review.reviewed_at))) {
    throw new Error('visual review approval lacks exact approved page coverage');
  }

  assertExactKeys(receipt.wps_lifecycle, [
    'controlled_copy', 'discard_confirmed', 'close_confirmed', 'reopen_confirmed', 'reopened_sha256', 'confirmed_at',
  ], 'WPS lifecycle');
  const controlled = validateArtifactRef(receipt.wps_lifecycle.controlled_copy, receiptRoot, 'WPS controlled copy');
  evidenceFiles.push(controlled);
  if (controlled.sha256 !== expected.restart_docx_sha256) throw new Error('WPS controlled copy document binding mismatch');
  for (const key of ['discard_confirmed', 'close_confirmed', 'reopen_confirmed']) {
    if (typeof receipt.wps_lifecycle[key] !== 'boolean') throw new Error(`WPS lifecycle ${key} must be boolean`);
  }
  if (!HASH.test(receipt.wps_lifecycle.reopened_sha256)) throw new Error('WPS lifecycle reopened_sha256 is invalid');
  if (receipt.wps_lifecycle.reopen_confirmed && receipt.wps_lifecycle.reopened_sha256 !== controlled.sha256) {
    throw new Error('WPS lifecycle reopened document hash mismatch');
  }
  if (receipt.wps_lifecycle.confirmed_at !== null && !validTime(receipt.wps_lifecycle.confirmed_at)) throw new Error('WPS lifecycle confirmed_at is invalid');

  const facts = {
    seven_stage_receipts_complete: receipt.stages.length === WRITER_STAGE_IDS.length,
    three_human_gates_complete: receipt.human_gates.length === WRITER_HUMAN_GATE_IDS.length
      && receipt.human_gates.every((gate) => gate.decision === 'approved'),
    human_visual_review_approved: receipt.visual_review.conclusion === 'approved'
      && receipt.visual_review.pages.length === receipt.visual_review.page_count
      && receipt.visual_review.pages.every((page) => page.conclusion === 'approved'),
    wps_discard_close_reopen_confirmed: receipt.wps_lifecycle.discard_confirmed
      && receipt.wps_lifecycle.close_confirmed && receipt.wps_lifecycle.reopen_confirmed
      && receipt.wps_lifecycle.reopened_sha256 === controlled.sha256
      && validTime(receipt.wps_lifecycle.confirmed_at),
  };
  const summary = {
    run_id: receipt.run_id,
    evaluation_id: receipt.evaluation_id,
    stage_receipts: receipt.stages.length,
    human_gate_receipts: receipt.human_gates.length,
    visual_pages_reviewed: receipt.visual_review.pages.length,
    lifecycle_confirmations: [receipt.wps_lifecycle.discard_confirmed, receipt.wps_lifecycle.close_confirmed, receipt.wps_lifecycle.reopen_confirmed].filter(Boolean).length,
  };
  return { receipt, receiptBytes, receiptSha256: sha256(receiptBytes), facts, summary, evidenceFiles };
}

export function readAndValidateWriterHumanReceipt(receiptPath, expected) {
  if (!isAbsolute(receiptPath)) throw new Error('human receipt path must be absolute');
  const testRewrite = process.env.SUPERWAGIE_TEST_REWRITE_RECEIPT === receiptPath
    && typeof process.env.SUPERWAGIE_TEST_REWRITE_RECEIPT_BASE64 === 'string'
    ? () => writeFileSync(receiptPath, Buffer.from(process.env.SUPERWAGIE_TEST_REWRITE_RECEIPT_BASE64, 'base64'))
    : undefined;
  const receiptBytes = readStableRegularFileSync(receiptPath, MAX_HUMAN_RECEIPT_BYTES, { afterFirstRead: testRewrite });
  return validateWriterHumanReceiptBytes(receiptBytes, receiptPath, expected);
}
