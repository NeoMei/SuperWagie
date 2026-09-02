import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { readStableRegularFileSync } from '../secure-file-read.mjs';

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WPS_BUNDLE_ID = 'com.kingsoft.wpsoffice.mac';
const WPS_TEAM_ID = 'YK4WKE5WAM';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} keys must be exactly ${[...keys].sort().join(',')}`);
  }
}

function rejectDuplicateJsonKeys(text) {
  let index = 0;
  const ws = () => { while (/\s/.test(text[index] || '')) index += 1; };
  const fail = (message) => { throw new Error(`${message} at byte ${index}`); };
  function string() {
    ws(); if (text[index] !== '"') fail('expected JSON string');
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index] === '"') { index += 1; return JSON.parse(text.slice(start, index)); }
      index += 1;
    }
    fail('unterminated JSON string');
  }
  function value() {
    ws();
    if (text[index] === '{') return object();
    if (text[index] === '[') return array();
    if (text[index] === '"') { string(); return; }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    if (start === index) fail('expected JSON value');
    JSON.parse(text.slice(start, index));
  }
  function object() {
    index += 1; ws(); const keys = new Set();
    if (text[index] === '}') { index += 1; return; }
    while (index < text.length) {
      const key = string(); if (keys.has(key)) fail(`duplicate JSON key: ${key}`); keys.add(key); ws();
      if (text[index] !== ':') fail('expected colon'); index += 1; value(); ws();
      if (text[index] === '}') { index += 1; return; }
      if (text[index] !== ',') fail('expected object separator'); index += 1;
    }
    fail('unterminated JSON object');
  }
  function array() {
    index += 1; ws(); if (text[index] === ']') { index += 1; return; }
    while (index < text.length) {
      value(); ws(); if (text[index] === ']') { index += 1; return; }
      if (text[index] !== ',') fail('expected array separator'); index += 1;
    }
    fail('unterminated JSON array');
  }
  value(); ws(); if (index !== text.length) fail('unexpected trailing JSON bytes');
}

function runGit(root, args, label, allowStatus = []) {
  const completed = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (completed.status !== 0 && !allowStatus.includes(completed.status)) {
    throw new Error(`${label} git ${args.join(' ')} failed: ${(completed.stderr || completed.stdout).trim()}`);
  }
  return completed;
}

export function readGitBlobFromSnapshot(root, snapshot, sourcePath, label = 'source artifact') {
  if (!isAbsolute(root)) throw new Error(`${label} repository root must be absolute`);
  validateSource(snapshot, `${label} snapshot`);
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || isAbsolute(sourcePath)
    || sourcePath.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} source path is invalid`);
  }
  const oid = runGit(root, ['rev-parse', `${snapshot.tree}:${sourcePath}`], label).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error(`${label} Git blob identity is invalid`);
  const type = runGit(root, ['cat-file', '-t', oid], label).stdout.trim();
  if (type !== 'blob') throw new Error(`${label} Git object is not a blob`);
  const completed = spawnSync('git', ['-C', root, 'cat-file', 'blob', oid], {
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (completed.status !== 0 || !Buffer.isBuffer(completed.stdout)) {
    throw new Error(`${label} immutable Git blob read failed`);
  }
  return { oid, bytes: completed.stdout, sha256: sha256(completed.stdout) };
}

export function readCleanDetachedGitSnapshot(root, label) {
  if (!isAbsolute(root)) throw new Error(`${label} root must be absolute`);
  const commit = runGit(root, ['rev-parse', 'HEAD'], label).stdout.trim();
  const tree = runGit(root, ['rev-parse', 'HEAD^{tree}'], label).stdout.trim();
  if (!COMMIT.test(commit) || !COMMIT.test(tree)) throw new Error(`${label} source identity is invalid`);
  const status = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'], label).stdout.trim();
  if (status !== '') throw new Error(`${label} source snapshot is not clean (dirty or untracked files present)`);
  const symbolic = runGit(root, ['symbolic-ref', '-q', 'HEAD'], label, [1]);
  if (symbolic.status === 0) throw new Error(`${label} source snapshot is not detached`);
  return { commit, tree, status: 'clean', snapshot: 'detached' };
}

function validateSource(value, label) {
  exact(value, ['commit', 'tree', 'status', 'snapshot'], label);
  if (!COMMIT.test(value.commit) || !COMMIT.test(value.tree)
    || value.status !== 'clean' || value.snapshot !== 'detached') {
    throw new Error(`${label} must identify a clean detached source snapshot`);
  }
}

function assertExpectedObject(actual, expected, label) {
  if (!expected) return;
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`${label} ${key} binding mismatch`);
  }
}

export function validateGenerationReceiptBytes(bytes, expected = {}) {
  const text = bytes.toString('utf8'); rejectDuplicateJsonKeys(text); const receipt = JSON.parse(text);
  exact(receipt, ['schema_id', 'schema_version', 'fixture', 'platform', 'generation_id', 'generated_at', 'sources', 'invocation', 'artifacts'], 'generation receipt');
  const v1 = receipt.schema_id === 'superwagie.g3-writer-generation-receipt.v1' && receipt.schema_version === 1;
  const v2 = receipt.schema_id === 'superwagie.g3-writer-generation-receipt.v2' && receipt.schema_version === 2;
  if (!v1 && !v2) throw new Error('generation receipt schema identity mismatch');
  if (expected.fixture !== undefined && receipt.fixture !== expected.fixture) throw new Error('generation receipt fixture binding mismatch');
  if (expected.platform !== undefined && receipt.platform !== expected.platform) throw new Error('generation receipt platform binding mismatch');
  if (!IDENTIFIER.test(receipt.generation_id) || !validTime(receipt.generated_at)) throw new Error('generation receipt identity or time is invalid');
  exact(receipt.sources, ['superwriter', 'wpscomposer'], 'generation sources');
  validateSource(receipt.sources.superwriter, 'SuperWriter source');
  validateSource(receipt.sources.wpscomposer, 'WPSComposer source');
  assertExpectedObject(receipt.sources.superwriter, expected.superwriter, 'SuperWriter source');
  assertExpectedObject(receipt.sources.wpscomposer, expected.wpscomposer, 'WPSComposer source');
  exact(receipt.invocation, v2
    ? ['capability_id', 'capability_version', 'executables', 'arguments_sha256']
    : ['capability_id', 'capability_version', 'executable_source_path', 'executable_sha256', 'arguments_sha256'], 'generation invocation');
  if (!IDENTIFIER.test(receipt.invocation.capability_id) || typeof receipt.invocation.capability_version !== 'string'
    || receipt.invocation.capability_version.length === 0 || receipt.invocation.capability_version.length > 128) throw new Error('generation capability identity is invalid');
  if (!HASH.test(receipt.invocation.arguments_sha256)) throw new Error('generation invocation hash is invalid');
  if (v1) {
    const sourcePath = receipt.invocation.executable_source_path;
    if (typeof sourcePath !== 'string' || sourcePath.length === 0 || isAbsolute(sourcePath)
      || sourcePath.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')) throw new Error('generation executable source path is invalid');
    if (!HASH.test(receipt.invocation.executable_sha256)) throw new Error('generation invocation hash is invalid');
  } else {
    if (!Array.isArray(receipt.invocation.executables) || receipt.invocation.executables.length !== 2) throw new Error('generation executable closure must contain SuperWriter and WPSComposer');
    const expectedRepositories = ['superwriter', 'wpscomposer'];
    receipt.invocation.executables.forEach((entry, index) => {
      exact(entry, ['repository', 'source_path', 'git_blob_oid', 'sha256'], `generation executable ${index + 1}`);
      if (entry.repository !== expectedRepositories[index]) throw new Error('generation executable closure repository order or identity is invalid');
      if (typeof entry.source_path !== 'string' || entry.source_path.length === 0 || isAbsolute(entry.source_path)
        || entry.source_path.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')) throw new Error('generation executable source path is invalid');
      if (!/^[a-f0-9]{40,64}$/.test(entry.git_blob_oid) || !HASH.test(entry.sha256)) throw new Error('generation executable blob identity or hash is invalid');
    });
  }
  exact(receipt.artifacts, ['source_md_sha256', 'canonical_docx_sha256', 'restart_docx_sha256', 'pdf_sha256'], 'generation artifacts');
  for (const [key, value] of Object.entries(receipt.artifacts)) {
    if (!HASH.test(value)) throw new Error(`generation artifact ${key} hash is invalid`);
  }
  assertExpectedObject(receipt.artifacts, expected.artifacts, 'generation artifact');
  return { receipt, receiptBytes: bytes, receiptSha256: sha256(bytes) };
}

export function verifyGenerationExecutableClosure(receipt, repositories) {
  if (receipt.schema_id !== 'superwagie.g3-writer-generation-receipt.v2' || receipt.schema_version !== 2) {
    throw new Error('trusted generation provenance requires generation receipt v2');
  }
  for (const executable of receipt.invocation.executables) {
    const repository = repositories?.[executable.repository];
    if (!repository?.root || !repository?.snapshot) throw new Error(`${executable.repository} executable repository is unavailable`);
    assertExpectedObject(repository.snapshot, receipt.sources[executable.repository], `${executable.repository} source`);
    const blob = readGitBlobFromSnapshot(repository.root, receipt.sources[executable.repository], executable.source_path,
      `${executable.repository === 'superwriter' ? 'SuperWriter' : 'WPSComposer'} generation executable`);
    if (blob.oid !== executable.git_blob_oid || blob.sha256 !== executable.sha256) {
      throw new Error(`${executable.repository === 'superwriter' ? 'SuperWriter' : 'WPSComposer'} generation executable Git blob/hash mismatch`);
    }
  }
  return true;
}

export function validateWriterCollectorReceiptBytes(bytes, expected = {}, trustedConfig = null) {
  const text = bytes.toString('utf8'); rejectDuplicateJsonKeys(text); const receipt = JSON.parse(text);
  exact(receipt, [
    'schema_id', 'schema_version', 'fixture', 'platform', 'run_identity', 'collected_at',
    'collector_executable_sha256', 'evaluation_sha256', 'automation_observation_sha256',
    'generation_receipt_sha256', 'renderer_identity_sha256', 'wps_session_id',
    'superwriter_commit', 'superwriter_tree', 'wpscomposer_commit', 'wpscomposer_tree',
    'human_receipt_sha256', 'attestation',
  ], 'Writer collector receipt');
  if (receipt.schema_id !== 'superwagie.g3-writer-collector-receipt.v5' || receipt.schema_version !== 5) throw new Error('Writer collector receipt schema identity mismatch');
  if (receipt.fixture !== expected.fixture || receipt.platform !== expected.platform || !validTime(receipt.collected_at)) throw new Error('Writer collector receipt fixture/platform/time binding mismatch');
  exact(receipt.run_identity, ['run_id', 'evaluation_id'], 'Writer collector run identity');
  if (!IDENTIFIER.test(receipt.run_identity.run_id) || !IDENTIFIER.test(receipt.run_identity.evaluation_id)
    || (expected.run_identity && JSON.stringify(receipt.run_identity) !== JSON.stringify(expected.run_identity))) throw new Error('Writer collector receipt run identity binding mismatch');
  for (const key of [
    'collector_executable_sha256', 'evaluation_sha256', 'automation_observation_sha256',
    'generation_receipt_sha256', 'renderer_identity_sha256',
  ]) if (!HASH.test(receipt[key])) throw new Error(`Writer collector receipt ${key} is invalid`);
  for (const key of ['superwriter_commit', 'superwriter_tree', 'wpscomposer_commit', 'wpscomposer_tree']) {
    if (!COMMIT.test(receipt[key])) throw new Error(`Writer collector receipt ${key} is invalid`);
  }
  if (!IDENTIFIER.test(receipt.wps_session_id) || (receipt.human_receipt_sha256 !== null && !HASH.test(receipt.human_receipt_sha256))) throw new Error('Writer collector receipt session or human receipt hash is invalid');
  for (const key of ['collector_executable_sha256', 'evaluation_sha256']) {
    if (expected[key] !== undefined && receipt[key] !== expected[key]) throw new Error(`Writer collector receipt ${key} binding mismatch`);
  }
  if (receipt.attestation === null) {
    return { receipt, receiptBytes: bytes, receiptSha256: sha256(bytes), authenticated: false, signerId: null };
  }
  exact(receipt.attestation, ['signer_id', 'algorithm', 'signature_base64'], 'Writer collector attestation');
  if (!IDENTIFIER.test(receipt.attestation.signer_id) || receipt.attestation.algorithm !== 'ed25519'
    || typeof receipt.attestation.signature_base64 !== 'string' || receipt.attestation.signature_base64.length === 0) {
    throw new Error('Writer collector attestation identity or signature is invalid');
  }
  validateWriterCollectorTrustConfig(trustedConfig);
  const signer = trustedConfig.signers.find((candidate) => candidate.signer_id === receipt.attestation.signer_id);
  if (!signer || signer.status !== 'active' || !signer.platforms.includes(receipt.platform)) {
    throw new Error('Writer collector signer is not authorized by trusted gate configuration');
  }
  let signature;
  try {
    signature = Buffer.from(receipt.attestation.signature_base64, 'base64');
  } catch {
    throw new Error('Writer collector attestation signature is invalid');
  }
  if (signature.length !== 64 || signature.toString('base64') !== receipt.attestation.signature_base64
    || !verify(null, writerCollectorAttestationPayload(receipt), signer.public_key_pem, signature)) {
    throw new Error('Writer collector attestation signature is not authenticated');
  }
  return {
    receipt, receiptBytes: bytes, receiptSha256: sha256(bytes),
    authenticated: true, signerId: signer.signer_id,
  };
}

function validateWriterCollectorTrustConfig(config) {
  exact(config, ['schema_id', 'schema_version', 'fixture', 'authorization', 'signers'], 'Writer collector trust configuration');
  if (config.schema_id !== 'superwagie.g3-writer-collector-trust.v1' || config.schema_version !== 1
    || config.fixture !== 'G3-WRITER-001' || config.authorization !== 'writer-go-collector'
    || !Array.isArray(config.signers)) throw new Error('Writer collector trust configuration identity is invalid');
  const identities = new Set();
  for (const signer of config.signers) {
    exact(signer, ['signer_id', 'algorithm', 'public_key_pem', 'platforms', 'status'], 'Writer collector trusted signer');
    if (!IDENTIFIER.test(signer.signer_id) || identities.has(signer.signer_id) || signer.algorithm !== 'ed25519'
      || typeof signer.public_key_pem !== 'string' || !Array.isArray(signer.platforms)
      || signer.platforms.length === 0 || signer.platforms.some((platform) => !IDENTIFIER.test(platform))
      || !['active', 'revoked'].includes(signer.status)) throw new Error('Writer collector trusted signer authorization is invalid');
    identities.add(signer.signer_id);
    let key;
    try { key = createPublicKey(signer.public_key_pem); } catch { throw new Error('Writer collector trusted signer public key is invalid'); }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Writer collector trusted signer public key must be Ed25519');
  }
  return config;
}

function writerCollectorAttestationPayload(receipt) {
  return Buffer.from(JSON.stringify({
    schema_id: receipt.schema_id,
    schema_version: receipt.schema_version,
    fixture: receipt.fixture,
    platform: receipt.platform,
    run_identity: { run_id: receipt.run_identity.run_id, evaluation_id: receipt.run_identity.evaluation_id },
    collected_at: receipt.collected_at,
    collector_executable_sha256: receipt.collector_executable_sha256,
    evaluation_sha256: receipt.evaluation_sha256,
    automation_observation_sha256: receipt.automation_observation_sha256,
    generation_receipt_sha256: receipt.generation_receipt_sha256,
    renderer_identity_sha256: receipt.renderer_identity_sha256,
    wps_session_id: receipt.wps_session_id,
    superwriter_commit: receipt.superwriter_commit,
    superwriter_tree: receipt.superwriter_tree,
    wpscomposer_commit: receipt.wpscomposer_commit,
    wpscomposer_tree: receipt.wpscomposer_tree,
    human_receipt_sha256: receipt.human_receipt_sha256,
  }));
}

export function loadWriterCollectorTrustConfig() {
  const configPath = fileURLToPath(new URL('../../../fixtures/gate-3/G3-WRITER-001/trusted-collector-signers.json', import.meta.url));
  const bytes = readStableRegularFileSync(configPath, 1024 * 1024);
  const text = bytes.toString('utf8');
  rejectDuplicateJsonKeys(text);
  const config = JSON.parse(text);
  return validateWriterCollectorTrustConfig(config);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return null;
  let offset = 8; let width; let height; let bitDepth; let colorType; let interlace; let ended = false;
  let sawPalette = false; let sawIdat = false; let idatEnded = false;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); offset += 4;
    const typeBytes = bytes.subarray(offset, offset + 4);
    const type = typeBytes.toString('ascii'); offset += 4;
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error(`${label} PNG chunk type is invalid`);
    if (length > bytes.length - offset - 4) throw new Error(`${label} PNG chunk length is invalid`);
    const data = bytes.subarray(offset, offset + length); offset += length;
    const expectedCrc = bytes.readUInt32BE(offset); offset += 4;
    if (crc32(Buffer.concat([typeBytes, data])) !== expectedCrc) throw new Error(`${label} PNG ${type} CRC mismatch`);
    if (type === 'IHDR') {
      if (length !== 13 || width !== undefined || offset !== 33) throw new Error(`${label} PNG IHDR is invalid`);
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      if (data[10] !== 0 || data[11] !== 0) throw new Error(`${label} PNG compression or filter method is invalid`);
    } else if (type === 'PLTE') {
      if (sawIdat || sawPalette || length === 0 || length % 3 !== 0 || length > 768) throw new Error(`${label} PNG palette is invalid`);
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (width === undefined || idatEnded || (colorType === 3 && !sawPalette)) throw new Error(`${label} PNG IDAT ordering is invalid`);
      sawIdat = true; idat.push(data);
    } else if (type === 'IEND') { if (length !== 0) throw new Error(`${label} PNG IEND is invalid`); ended = true; break; }
    else {
      if (sawIdat) idatEnded = true;
      if ((typeBytes[0] & 0x20) === 0) throw new Error(`${label} PNG unknown critical chunk ${type}`);
    }
  }
  if (!ended || offset !== bytes.length || !Number.isInteger(width) || width < 1 || height < 1 || idat.length === 0) throw new Error(`${label} PNG container is incomplete`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!channels || !allowedDepths[colorType]?.includes(bitDepth) || interlace !== 0) throw new Error(`${label} PNG encoding is unsupported`);
  const scanline = Math.ceil((width * channels * bitDepth) / 8);
  let decoded;
  try { decoded = inflateSync(Buffer.concat(idat)); } catch { throw new Error(`${label} PNG image data cannot be decoded`); }
  if (decoded.length !== height * (scanline + 1)) throw new Error(`${label} PNG decoded dimensions do not match IHDR`);
  for (let row = 0; row < height; row += 1) if (decoded[row * (scanline + 1)] > 4) throw new Error(`${label} PNG row filter is invalid`);
  return { media_type: 'image/png', width, height };
}

export function inspectImageBytes(bytes, label = 'image evidence', { minWidth = 1, minHeight = 1 } = {}) {
  const result = inspectPng(bytes, label);
  if (!result && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    throw new Error(`${label} JPEG is not accepted as trusted evidence; a fully validated PNG is required`);
  }
  if (!result) throw new Error(`${label} is not a supported PNG image`);
  if (result.width < minWidth || result.height < minHeight) {
    throw new Error(`${label} dimensions are below the required minimum ${minWidth}x${minHeight}`);
  }
  return result;
}

function validateRendererIdentity(value) {
  exact(value, ['application', 'application_path', 'bundle_id', 'version', 'build', 'executable_path', 'executable_sha256', 'codesign_identifier', 'team_identifier'], 'WPS renderer identity');
  if (value.application !== 'WPS Office' || value.application_path !== '/Applications/wpsoffice.app'
    || value.bundle_id !== WPS_BUNDLE_ID || value.codesign_identifier !== WPS_BUNDLE_ID || value.team_identifier !== WPS_TEAM_ID
    || typeof value.version !== 'string' || value.version.length === 0 || typeof value.build !== 'string' || value.build.length === 0
    || value.executable_path !== `${value.application_path}/Contents/MacOS/wpsoffice` || !HASH.test(value.executable_sha256)) {
    throw new Error('WPS renderer identity is invalid or is not the trusted signed WPS application');
  }
}

export function validateWpsAutomationObservationBytes(bytes, expected) {
  const text = bytes.toString('utf8'); rejectDuplicateJsonKeys(text); const observation = JSON.parse(text);
  exact(observation, ['schema_id', 'schema_version', 'fixture', 'platform', 'executed_at', 'operator_role', 'session', 'renderer_identity', 'document', 'document_sha256_after_automation', 'observations', 'screenshots', 'note'], 'WPS automation observation');
  if (observation.schema_id !== 'superwagie.g3-writer-wps-automation-observation.v2' || observation.schema_version !== 2
    || observation.fixture !== expected.fixture || observation.platform !== expected.platform || !validTime(observation.executed_at)) throw new Error('WPS automation observation identity mismatch');
  if (!IDENTIFIER.test(observation.operator_role)) throw new Error('WPS automation operator role is invalid');
  exact(observation.session, ['session_id', 'run_id', 'started_at', 'finished_at'], 'WPS automation session');
  if (!IDENTIFIER.test(observation.session.session_id) || observation.session.run_id !== expected.run_id
    || !validTime(observation.session.started_at) || !validTime(observation.session.finished_at)
    || Date.parse(observation.session.finished_at) < Date.parse(observation.session.started_at)) throw new Error('WPS automation session/run binding is invalid');
  validateRendererIdentity(observation.renderer_identity);
  if (typeof observation.document !== 'string' || observation.document.length === 0
    || observation.document_sha256_after_automation !== expected.restart_docx_sha256) throw new Error('WPS automation document hash binding mismatch');
  exact(observation.observations, ['wps_opened_real_document', 'wps_edit_entered_dirty_state', 'wps_undo_restored_original_text', 'canonical_hash_unchanged', 'wps_discard_close_reopen_confirmed'], 'WPS automation facts');
  for (const key of Object.keys(observation.observations)) if (typeof observation.observations[key] !== 'boolean') throw new Error(`WPS automation ${key} must be boolean`);
  exact(observation.screenshots, ['opened', 'edited', 'restored', 'discard_prompt'], 'WPS automation screenshots');
  for (const key of Object.keys(observation.screenshots)) {
    const entry = observation.screenshots[key]; const actual = expected.screenshots[key];
    exact(entry, ['sha256', 'media_type', 'width', 'height', 'session_id'], `WPS ${key} screenshot`);
    if (!HASH.test(entry.sha256) || entry.media_type !== 'image/png'
      || !Number.isInteger(entry.width) || entry.width < 1 || !Number.isInteger(entry.height) || entry.height < 1) throw new Error(`WPS ${key} screenshot media facts are invalid`);
    if (entry.session_id !== observation.session.session_id) throw new Error(`WPS ${key} screenshot session binding mismatch`);
    assertExpectedObject(entry, actual, `WPS ${key} screenshot`);
  }
  return {
    observation, observationBytes: bytes, observationSha256: sha256(bytes),
    rendererIdentitySha256: sha256(Buffer.from(JSON.stringify(observation.renderer_identity))),
    sessionId: observation.session.session_id,
  };
}

function command(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  return (result.stdout || result.stderr).trim();
}

export function verifyInstalledWpsRendererIdentity(identity) {
  validateRendererIdentity(identity);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', identity.application_path]);
  const details = command('/usr/bin/codesign', ['-dv', '--verbose=4', identity.application_path]);
  if (!details.includes(`Identifier=${identity.codesign_identifier}`) || !details.includes(`TeamIdentifier=${identity.team_identifier}`)) throw new Error('installed WPS code-sign identity mismatch');
  const plist = resolve(identity.application_path, 'Contents', 'Info.plist');
  const values = {
    bundle_id: command('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist]),
    version: command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]),
    build: command('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', plist]),
    executable: command('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', plist]),
  };
  if (values.bundle_id !== identity.bundle_id || values.version !== identity.version || values.build !== identity.build
    || resolve(identity.application_path, 'Contents', 'MacOS', values.executable) !== identity.executable_path) throw new Error('installed WPS bundle metadata mismatch');
  const executable = readStableRegularFileSync(identity.executable_path, 256 * 1024 * 1024);
  if (sha256(executable) !== identity.executable_sha256) throw new Error('installed WPS executable hash mismatch');
  return true;
}

export function resolveGenerationExecutable(root, sourcePath) {
  const file = resolve(root, ...sourcePath.split(/[\\/]/));
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('generation executable escapes SuperWriter root');
  return file;
}
