import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEX64 = /^[0-9a-f]{64}$/;
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function decodePng(bytes) {
  if (bytes.length < 8 || !PNG_SIGNATURE.equals(bytes.subarray(0, 8))) {
    return { error: 'PAGE_IMAGE_MAGIC_INVALID' };
  }
  let offset = 8;
  let header = null;
  const idatChunks = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return { error: 'PAGE_IMAGE_STRUCTURE_INVALID' };
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (length !== 13) return { error: 'PAGE_IMAGE_STRUCTURE_INVALID' };
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!header || idatChunks.length === 0) return { error: 'PAGE_IMAGE_STRUCTURE_INVALID' };
  if (header.bitDepth !== 8 || ![2, 6].includes(header.colorType) || header.interlace !== 0) {
    return { error: 'PAGE_IMAGE_STRUCTURE_INVALID' };
  }
  if (!Number.isSafeInteger(header.width) || !Number.isSafeInteger(header.height)
    || header.width <= 0 || header.height <= 0 || header.width > 30000 || header.height > 30000) {
    return { error: 'PAGE_IMAGE_DIMENSION_INVALID' };
  }
  const bytesPerPixel = header.colorType === 6 ? 4 : 3;
  const stride = header.width * bytesPerPixel;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idatChunks));
  } catch {
    return { error: 'PAGE_IMAGE_STRUCTURE_INVALID' };
  }
  if (raw.length !== header.height * (stride + 1)) return { error: 'PAGE_IMAGE_STRUCTURE_INVALID' };
  const pixels = Buffer.alloc(header.width * header.height * 3);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const priorStart = (y - 1) * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + x];
      const left = x >= bytesPerPixel ? raw[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? raw[priorStart + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? raw[priorStart + x - bytesPerPixel] : 0;
      let reconstructed;
      if (filter === 0) reconstructed = value;
      else if (filter === 1) reconstructed = value + left;
      else if (filter === 2) reconstructed = value + up;
      else if (filter === 3) reconstructed = value + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        reconstructed = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else return { error: 'PAGE_IMAGE_STRUCTURE_INVALID' };
      raw[rowStart + x] = reconstructed & 0xff;
    }
    for (let x = 0; x < header.width; x += 1) {
      const source = rowStart + x * bytesPerPixel;
      const target = (y * header.width + x) * 3;
      pixels[target] = raw[source];
      pixels[target + 1] = raw[source + 1];
      pixels[target + 2] = raw[source + 2];
    }
  }
  return { width: header.width, height: header.height, pixels };
}

export function validatePageImage({ bytes, declared_sha256 }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return { ok: false, code: 'PAGE_IMAGE_MAGIC_INVALID' };
  }
  const decoded = decodePng(bytes);
  if (decoded.error) return { ok: false, code: decoded.error };
  const actual = sha256Hex(bytes);
  if (declared_sha256 !== undefined) {
    if (typeof declared_sha256 !== 'string' || !HEX64.test(declared_sha256)
      || declared_sha256 !== actual) {
      return { ok: false, code: 'PAGE_IMAGE_HASH_MISMATCH' };
    }
  }
  const { pixels } = decoded;
  const first = pixels.subarray(0, 3).toString('hex');
  let blank = true;
  for (let index = 3; index < pixels.length; index += 3) {
    if (pixels.subarray(index, index + 3).toString('hex') !== first) {
      blank = false;
      break;
    }
  }
  if (blank) return { ok: false, code: 'PAGE_IMAGE_BLANK' };
  return { ok: true, sha256: actual, width: decoded.width, height: decoded.height };
}

function validIdentity(identity) {
  if (!identity || typeof identity !== 'object') return false;
  const keys = ['target_kind', 'executable_sha256', 'bundle_manifest_sha256', 'bridge_sha256'];
  if (Object.keys(identity).sort().join('\0') !== [...keys].sort().join('\0')) return false;
  if (!['macos-app-bundle', 'windows-executable'].includes(identity.target_kind)) return false;
  return ['executable_sha256', 'bundle_manifest_sha256', 'bridge_sha256']
    .every((key) => typeof identity[key] === 'string' && HEX64.test(identity[key]));
}

export function validateWpsTruthRecord(record, { expected_identity } = {}) {
  if (!record || record.schema !== 'superwagie.wps-truth.v1' || !record.wps) {
    return { ok: false, code: 'WPS_TRUTH_SCHEMA_INVALID' };
  }
  if (!validIdentity(record.wps.identity)) return { ok: false, code: 'WPS_IDENTITY_INVALID' };
  if (expected_identity !== undefined) {
    if (canonicalJson(record.wps.identity) !== canonicalJson(expected_identity)) {
      return { ok: false, code: 'WPS_IDENTITY_MISMATCH' };
    }
  }
  const session = record.wps.session;
  if (!session || !Number.isSafeInteger(session.pid) || session.pid <= 0
    || typeof session.started_at !== 'string' || Number.isNaN(Date.parse(session.started_at))
    || typeof session.receipt_sha256 !== 'string' || !HEX64.test(session.receipt_sha256)) {
    return { ok: false, code: 'WPS_SESSION_UNBOUND' };
  }
  if (typeof record.wps.version !== 'string' || record.wps.version.length === 0) {
    return { ok: false, code: 'WPS_VERSION_UNBOUND' };
  }
  if (!record.source || typeof record.source.name !== 'string'
    || typeof record.source.artifact_sha256 !== 'string' || !HEX64.test(record.source.artifact_sha256)) {
    return { ok: false, code: 'WPS_SOURCE_UNBOUND' };
  }
  const output = record.output;
  if (!output || output.kind !== 'pdf' || typeof output.pdf_sha256 !== 'string'
    || !HEX64.test(output.pdf_sha256) || !Number.isSafeInteger(output.page_count)
    || output.page_count <= 0) {
    return { ok: false, code: 'WPS_OUTPUT_UNBOUND' };
  }
  if (!Array.isArray(record.pages) || record.pages.length !== output.page_count) {
    return { ok: false, code: 'PAGE_TRUTH_INVALID' };
  }
  for (let index = 0; index < record.pages.length; index += 1) {
    const page = record.pages[index];
    if (!page || page.index !== index + 1) return { ok: false, code: 'PAGE_TRUTH_INVALID' };
    const image = validatePageImage({ bytes: page.bytes, declared_sha256: page.sha256 });
    if (!image.ok) return { ok: false, code: 'PAGE_TRUTH_INVALID' };
    if (page.width !== image.width || page.height !== image.height) {
      return { ok: false, code: 'PAGE_TRUTH_INVALID' };
    }
  }
  return { ok: true, page_count: record.pages.length };
}

export class ReviewPageCache {
  constructor() {
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.corruptRejected = 0;
    this.rerendered = 0;
  }

  put(key, { bytes }) {
    this.entries.set(key, { bytes, sha256: sha256Hex(bytes), quarantined: false });
    return { ok: true };
  }

  putAfterRerender(key, { bytes }) {
    const entry = this.entries.get(key);
    if (!entry || !entry.quarantined) return { ok: false, code: 'CACHE_RERENDER_NOT_ALLOWED' };
    this.entries.set(key, { bytes, sha256: sha256Hex(bytes), quarantined: false });
    this.rerendered += 1;
    return { ok: true };
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return { ok: false, code: 'CACHE_ENTRY_MISSING' };
    }
    if (sha256Hex(entry.bytes) !== entry.sha256) {
      entry.quarantined = true;
      this.corruptRejected += 1;
      return { ok: false, code: 'CACHE_ENTRY_CORRUPT' };
    }
    const image = validatePageImage({ bytes: entry.bytes, declared_sha256: entry.sha256 });
    if (!image.ok) {
      entry.quarantined = true;
      this.corruptRejected += 1;
      return { ok: false, code: 'CACHE_ENTRY_CORRUPT' };
    }
    this.hits += 1;
    return { ok: true, sha256: entry.sha256, width: image.width, height: image.height };
  }

  corruptForTest(key) {
    const entry = this.entries.get(key);
    if (!entry) throw new Error('CACHE_ENTRY_MISSING');
    entry.bytes[entry.bytes.length - 1] ^= 0x01;
  }

  replaceBytesForTest(key, bytes) {
    const entry = this.entries.get(key);
    if (!entry) throw new Error('CACHE_ENTRY_MISSING');
    entry.bytes = bytes;
  }

  stats() {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      corrupt_rejected: this.corruptRejected,
      rerendered: this.rerendered,
    };
  }
}

export class ReviewStateStore {
  constructor({ journalPath, key }) {
    if (typeof journalPath !== 'string' || journalPath.length === 0) throw new Error('journal path is required');
    if (typeof key !== 'string' || !HEX64.test(key)) throw new Error('journal key must be 64 lowercase hex');
    this.journalPath = journalPath;
    this.key = key;
  }

  macFor(value) {
    return createHmac('sha256', this.key).update(canonicalJson(value)).digest('hex');
  }

  readJournal() {
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.journalPath, 'utf8'));
    } catch {
      return null;
    }
    if (!raw || raw.schema !== 'superwagie.review-state.v1'
      || !Number.isSafeInteger(raw.sequence) || raw.sequence <= 0
      || !raw.state || typeof raw.state !== 'object'
      || typeof raw.state_sha256 !== 'string' || typeof raw.mac !== 'string') {
      return null;
    }
    if (sha256Hex(Buffer.from(canonicalJson(raw.state))) !== raw.state_sha256) return null;
    const unsigned = { sequence: raw.sequence, state: raw.state, state_sha256: raw.state_sha256 };
    const expected = Buffer.from(this.macFor(unsigned), 'hex');
    const supplied = Buffer.from(raw.mac, 'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    return raw;
  }

  checkpoint(state) {
    const previous = this.readJournal();
    const sequence = (previous?.sequence ?? 0) + 1;
    const state_sha256 = sha256Hex(Buffer.from(canonicalJson(state)));
    const unsigned = { sequence, state, state_sha256 };
    const journal = { ...unsigned, schema: 'superwagie.review-state.v1', mac: this.macFor(unsigned) };
    const temporary = this.journalPath + '.tmp';
    writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.journalPath);
    return { sequence, state_sha256 };
  }

  load() {
    const journal = this.readJournal();
    if (!journal) return { ok: false, code: 'CHECKPOINT_ROOT_MISMATCH' };
    return { ok: true, sequence: journal.sequence, state: journal.state };
  }

  recordEffect(state, effectId) {
    if (typeof effectId !== 'string' || effectId.length === 0) throw new Error('effect id is required');
    if (!state.effects || typeof state.effects !== 'object') state.effects = {};
    if (!Array.isArray(state.effects.applied)) state.effects.applied = [];
    if (state.effects.applied.includes(effectId)) {
      return { applied: false, duplicate: true };
    }
    state.effects.applied.push(effectId);
    if (effectId.startsWith('accept:')) {
      state.effects.accepted = (state.effects.accepted ?? 0) + 1;
    }
    return { applied: true, duplicate: false };
  }
}

export function reanchorAnnotations({ annotations, old_manifest: oldManifest, new_manifest: newManifest }) {
  const resolved = [];
  const unresolved = [];
  let silentMisplaced = 0;
  for (const annotation of annotations ?? []) {
    const oldPage = (oldManifest?.pages ?? []).find(
      (page) => page.pageId === annotation.pageId && page.contextDigests?.includes(annotation.contextDigest),
    );
    if (!oldPage) {
      silentMisplaced += 1;
      continue;
    }
    const newPage = (newManifest?.pages ?? []).find(
      (page) => page.contextDigests?.includes(annotation.contextDigest),
    );
    if (!newPage) {
      unresolved.push({
        annotationId: annotation.annotationId,
        reason: 'CONTEXT_NOT_FOUND',
        previous_page_id: annotation.pageId,
      });
      continue;
    }
    resolved.push({ ...annotation, pageId: newPage.pageId, status: 'active' });
  }
  return { resolved, unresolved, silent_misplaced: silentMisplaced };
}

const PREVIEW_TRANSITIONS = Object.freeze({
  queued: ['loading_fast', 'rendering_authoritative', 'unsupported', 'dependency_missing'],
  loading_fast: ['fast_ready', 'rendering_authoritative', 'failed_recoverable'],
  fast_ready: ['rendering_authoritative', 'failed_recoverable'],
  rendering_authoritative: ['authoritative_ready', 'dependency_missing', 'failed_recoverable', 'failed_terminal'],
  authoritative_ready: ['accepted', 'rendering_authoritative'],
  dependency_missing: ['rendering_authoritative'],
  unsupported: [],
  failed_recoverable: ['loading_fast', 'rendering_authoritative'],
  failed_terminal: [],
  accepted: [],
});

export function assertPreviewTransition(from, to) {
  if (!PREVIEW_TRANSITIONS[from]?.includes(to)) {
    throw new Error('invalid preview transition: ' + from + ' -> ' + to);
  }
}

export function searchTextLayer(pages, term) {
  if (typeof term !== 'string' || term.length === 0) throw new Error('search term is required');
  const needle = term.toLowerCase();
  const hits = [];
  for (const page of pages ?? []) {
    for (const item of page.items ?? []) {
      if (item.text.toLowerCase().includes(needle)) {
        hits.push({ page: page.page, text: item.text, bbox: item.bbox });
      }
    }
  }
  return { term, total_hits: hits.length, hits: hits.slice(0, 64) };
}

export function buildContextDigest(items) {
  const text = (items ?? []).map((item) => item.text).join(' ');
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

export function classifyArtifact({ name, bytes, maxBytes = 64 * 1024 * 1024 }) {
  const lower = (name ?? '').toLowerCase();
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { kind: 'invalid', code: 'ARTIFACT_EMPTY' };
  if (bytes.length > maxBytes) return { kind: 'invalid', code: 'ARTIFACT_OVERSIZE' };
  const isPdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (lower.endsWith('.pdf') || isPdf) {
    const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString('latin1');
    if (!tail.includes('%%EOF')) return { kind: 'pdf', code: 'ARTIFACT_PDF_TRUNCATED', malicious_suspect: true };
    return { kind: 'pdf', code: 'ARTIFACT_PDF_OK' };
  }
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip && lower.endsWith('.docx')) return { kind: 'docx', code: 'ARTIFACT_DOCX_OK' };
  if (isZip && lower.endsWith('.pptx')) return { kind: 'pptx', code: 'ARTIFACT_PPTX_OK' };
  if (lower.endsWith('.docx') || lower.endsWith('.pptx')) {
    return { kind: 'invalid', code: isZip ? 'ARTIFACT_OOXML_INVALID' : 'ARTIFACT_OOXML_TRUNCATED', malicious_suspect: true };
  }
  return { kind: 'unsupported', code: 'ARTIFACT_TYPE_UNSUPPORTED' };
}

export function comparePageImages({ baseline, candidate }) {
  const a = decodePng(baseline);
  const b = decodePng(candidate);
  if (a.error) return { ok: false, code: 'BASELINE_' + a.error };
  if (b.error) return { ok: false, code: 'CANDIDATE_' + b.error };
  if (a.width !== b.width || a.height !== b.height) {
    return {
      ok: true,
      geometry_match: false,
      baseline: { width: a.width, height: a.height },
      candidate: { width: b.width, height: b.height },
      visual_diff_ratio: 1,
    };
  }
  const pa = a.pixels;
  const pb = b.pixels;
  let totalDelta = 0;
  let identical = true;
  for (let index = 0; index < pa.length; index += 3) {
    const la = 0.299 * pa[index] + 0.587 * pa[index + 1] + 0.114 * pa[index + 2];
    const lb = 0.299 * pb[index] + 0.587 * pb[index + 1] + 0.114 * pb[index + 2];
    const delta = Math.abs(la - lb);
    totalDelta += delta;
    if (delta > 2) identical = false;
  }
  const pixels = a.width * a.height;
  return {
    ok: true,
    geometry_match: true,
    identical,
    visual_diff_ratio: Number((totalDelta / (pixels * 255)).toFixed(6)),
  };
}
