import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');

export const definitions = [
  { path: 'fixtures/reviewer-torture-30p.docx', format: 'docx', expected_pages: 30 },
  { path: 'fixtures/reviewer-torture-20s.pptx', format: 'pptx', expected_pages: 20 },
  { path: 'fixtures/reviewer-torture-100p.pdf', format: 'pdf', expected_pages: 100 },
  { path: 'fixtures/corrupt-tail.pdf', format: 'pdf-corrupt', expected_outcome: 'failed_terminal' },
  { path: 'fixtures/oversize-placeholder.bin', format: 'oversize', expected_outcome: 'unsupported' }
];

export const buildSourceDefinitions = [
  { path: 'builders/build_docx.py', role: 'docx-builder' },
  { path: 'builders/patch_docx_ooxml.py', role: 'docx-ooxml-patcher' },
  { path: 'builders/build_pptx.mjs', role: 'pptx-builder' },
  { path: 'builders/build_pdf.py', role: 'pdf-builder' },
  { path: 'builders/structural_audit.py', role: 'structural-validator' },
  { path: 'builders/runtime-lock.json', role: 'runtime-lock' },
  { path: 'builders/reproduce.sh', role: 'reproduction-recipe', executable: true },
  { path: 'builders/README.md', role: 'reproduction-guide' },
];

export const expectedProvenance =
  'SuperWagie project-owned torture documents generated for technical validation';

const SHA256_RE = /^[a-f0-9]{64}$/;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function countMatches(text, expression) {
  return [...text.matchAll(expression)].length;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertSupportedFixtureId(fixtureId) {
  if (fixtureId !== 'G3-REVIEW-001') throw new Error(`unsupported fixture: ${fixtureId}`);
}

export function validateRelativePath(relativePath, fixtureRoot, io = fs) {
  const violations = [];
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    return ['path is empty or not a string'];
  }
  if (relativePath !== relativePath.trim()) violations.push(`path has surrounding whitespace: ${relativePath}`);
  if (relativePath.includes('\0')) violations.push('path contains a null byte');
  const portablePath = relativePath.replaceAll('\\', '/');
  if (
    path.isAbsolute(relativePath) ||
    path.posix.isAbsolute(portablePath) ||
    /^[a-z]:/i.test(portablePath)
  ) {
    violations.push(`absolute path: ${relativePath}`);
  }
  if (relativePath.includes('\\')) violations.push(`non-portable path separator: ${relativePath}`);
  const segments = portablePath.split('/');
  if (segments.includes('')) violations.push(`empty path segment: ${relativePath}`);
  if (segments.includes('.')) violations.push(`dot path alias: ${relativePath}`);
  if (segments.includes('..')) violations.push(`path escapes fixture root: ${relativePath}`);
  if (relativePath.toLowerCase().includes('codex.app')) violations.push(`Codex.app path: ${relativePath}`);
  if (violations.length > 0) return [...new Set(violations)];

  const resolved = path.resolve(fixtureRoot, relativePath);
  if (!isInside(fixtureRoot, resolved)) return [`path escapes fixture root: ${relativePath}`];

  const realRoot = io.realpathSync(fixtureRoot);
  const parent = path.dirname(resolved);
  if (io.existsSync(parent)) {
    const realParent = io.realpathSync(parent);
    if (!isInside(realRoot, realParent)) violations.push(`parent symlink escapes fixture root: ${relativePath}`);
  }
  if (violations.length === 0 && io.existsSync(resolved)) {
    const realCandidate = io.realpathSync(resolved);
    if (!isInside(realRoot, realCandidate)) violations.push(`symlink escapes fixture root: ${relativePath}`);
  }
  return violations;
}

function unzip(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error('ZIP local-file signature missing');
  }
  const searchStart = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record missing');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > eocd) throw new Error('ZIP central directory is out of bounds');

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP central-directory signature missing at entry ${index}`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const expectedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'utf8');
    if (entries.has(name)) throw new Error(`duplicate ZIP entry: ${name}`);
    if (path.posix.isAbsolute(name) || name.split('/').includes('..')) {
      throw new Error(`unsafe ZIP entry path: ${name}`);
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`ZIP local-file header missing for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported ZIP compression method ${method} for ${name}`);
    if (data.length !== expectedSize) throw new Error(`ZIP size mismatch for ${name}`);
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP CRC mismatch for ${name}`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('ZIP central-directory length mismatch');
  return entries;
}

function xmlText(entries, name) {
  const value = entries.get(name);
  if (!value) throw new Error(`missing package part: ${name}`);
  return value.toString('utf8');
}

function auditDocx(buffer) {
  const entries = unzip(buffer);
  const names = [...entries.keys()];
  const document = xmlText(entries, 'word/document.xml');
  const styles = xmlText(entries, 'word/styles.xml');
  const numbering = xmlText(entries, 'word/numbering.xml');
  const allXml = names
    .filter((name) => name.endsWith('.xml') || name.endsWith('.rels'))
    .map((name) => entries.get(name).toString('utf8'))
    .join('\n');
  const pageBreaks = countMatches(document, /<w:br\b[^>]*w:type="page"/g);
  const sectionCount = countMatches(document, /<w:sectPr\b/g);
  const headerCount = names.filter((name) => /^word\/header\d+\.xml$/.test(name)).length;
  const footerCount = names.filter((name) => /^word\/footer\d+\.xml$/.test(name)).length;
  const computedPageCount = 1 + pageBreaks + sectionCount - 1;
  const checks = {
    zipIntegrity: true,
    computedPageCount: computedPageCount === 30,
    tocField: /<w:instrText[^>]*>\s*TOC \\o/.test(document),
    linkedNumbering: numbering.includes('<w:abstractNum') && styles.includes('<w:numPr>') && styles.includes('Heading1'),
    sectionCount: sectionCount === 3,
    landscapeSection: document.includes('w:orient="landscape"'),
    portraitSections: countMatches(document, /<w:pgSz\b(?![^>]*w:orient="landscape")[^>]*>/g) >= 2,
    headersAndFooters: headerCount >= 3 && footerCount >= 3 && allXml.includes(' PAGE '),
    footnote: entries.has('word/footnotes.xml') && document.includes('<w:footnoteReference') && xmlText(entries, 'word/footnotes.xml').includes('True footnote: reviewer annotation anchors'),
    table: document.includes('<w:tbl>'),
    floatingImage: document.includes('<wp:anchor'),
    mixedScript: /[\u4e00-\u9fff]/u.test(document) && document.includes('Office Reviewer'),
    missingFont: allXml.includes('SuperWagieMissingFont-927'),
    repaginationEdit: document.includes('<w:del') && document.includes('<w:ins') && document.includes('REPAGINATION_BASELINE') && document.includes('REPAGINATION EDIT INSERTION')
  };
  return { checks, observedCount: computedPageCount };
}

function auditPptx(buffer) {
  const entries = unzip(buffer);
  const names = [...entries.keys()];
  const xmlNames = names.filter((name) => name.endsWith('.xml') || name.endsWith('.rels'));
  const allXml = xmlNames.map((name) => entries.get(name).toString('utf8')).join('\n');
  const slideNames = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const mediaNames = names.filter((name) => name.startsWith('ppt/media/'));
  const imageFirstSlides = [2, 3, 15, 18].every((number) => {
    const slide = xmlText(entries, `ppt/slides/slide${number}.xml`);
    return slide.includes('<p:pic>') && slide.includes('<a:t>');
  });
  const checks = {
    zipIntegrity: true,
    slideCount: slideNames.length === 20,
    imageFirstSlides,
    editableText: countMatches(allXml, /<a:t>/g) >= 40,
    nativeChart: names.some((name) => name.includes('/charts/chart') && name.endsWith('.xml')) && allXml.includes('<c:chart'),
    nativeTable: allXml.includes('<a:tbl>'),
    svgImage: mediaNames.some((name) => name.toLowerCase().endsWith('.svg')),
    rasterImage: mediaNames.some((name) => /\.(png|jpe?g)$/i.test(name)),
    transparency: allXml.includes('<a:alpha'),
    gradient: allXml.includes('<a:gradFill'),
    nativeGroup: /<p:grpSp\b/.test(allXml),
    rebuiltObject: allXml.includes('REBUILT_OBJECT') && allXml.includes('REBUILD_SOURCE_GHOST'),
    posterFrame: allXml.includes('<a:videoFile') && mediaNames.some((name) => name.toLowerCase().endsWith('.mp4')),
    missingFont: allXml.includes('SuperWagieMissingFont-927'),
    speakerNotes: names.some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
  };
  return { checks, observedCount: slideNames.length };
}

function auditPdf(buffer) {
  const text = buffer.toString('latin1');
  const mediaBoxes = [...text.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((match) => match[1].trim().replace(/\s+/g, ' '));
  const pageCount = countMatches(text, /\/Type\s*\/Page\b/g);
  const imageCount = countMatches(text, /\/Subtype\s*\/Image\b/g);
  const imagePageCount = countMatches(text, /\/XObject\s*<</g);
  const checks = {
    terminalEof: buffer.subarray(Math.max(0, buffer.length - 2048)).includes(Buffer.from('%%EOF')),
    pageCount: pageCount === 100,
    mixedPageSizes: new Set(mediaBoxes).size === 3,
    textPages: pageCount - imagePageCount === 80,
    scannedPages: imageCount === 20 && imagePageCount === 20,
    bookmarks: text.includes('/Type /Outlines') && countMatches(text, /\/Title \(Chapter/g) === 11,
    uriLinks: countMatches(text, /\/S\s*\/URI\b/g) === 100,
    internalLinks: countMatches(text, /\/Contents \(Jump to final page\) \/Dest/g) === 99,
    textAnnotations: countMatches(text, /\/Subtype\s*\/Text\b/g) === 4,
    fixtureMetadata: text.includes('SuperWagie Reviewer Torture Fixture - 100 Pages') && text.includes('SuperWagie project-owned fixture builder')
  };
  return { checks, observedCount: pageCount };
}

function auditCorruptPdf(buffer) {
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048));
  const checks = {
    corruptMarker: buffer.includes(Buffer.from('%CORRUPT-TAIL')),
    terminalFailure: !tail.includes(Buffer.from('%%EOF')) && !tail.includes(Buffer.from('startxref'))
  };
  return { checks, observedCount: null };
}

function auditOversize(buffer, entryPath) {
  const knownSignature =
    buffer.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'binary')) ||
    buffer.subarray(0, 5).equals(Buffer.from('%PDF-'));
  const checks = {
    exceeds16MiB: buffer.length > 16 * 1024 * 1024,
    unsupportedClass: path.extname(entryPath).toLowerCase() === '.bin' && !knownSignature
  };
  return { checks, observedCount: null };
}

function validateFixtureBytes(entry, buffer) {
  const signatureOk =
    entry.format === 'docx' || entry.format === 'pptx'
      ? buffer.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'binary'))
      : entry.format === 'pdf' || entry.format === 'pdf-corrupt'
        ? buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))
        : true;
  if (!signatureOk) throw new Error(`invalid ${entry.format} file signature`);
  if (entry.format === 'docx') return auditDocx(buffer);
  if (entry.format === 'pptx') return auditPptx(buffer);
  if (entry.format === 'pdf') return auditPdf(buffer);
  if (entry.format === 'pdf-corrupt') return auditCorruptPdf(buffer);
  return auditOversize(buffer, entry.path);
}

function compareDefinitions(manifestFiles) {
  if (!Array.isArray(manifestFiles) || manifestFiles.length !== definitions.length) return false;
  return definitions.every((definition, index) => {
    const actual = manifestFiles[index];
    const keys = Object.keys(definition);
    return actual && keys.every((key) => actual[key] === definition[key]);
  });
}

function compareBuildSourceDefinitions(manifestSources) {
  if (!Array.isArray(manifestSources) || manifestSources.length !== buildSourceDefinitions.length) return false;
  return buildSourceDefinitions.every((definition, index) => {
    const actual = manifestSources[index];
    return actual && Object.entries(definition).every(([key, value]) => actual[key] === value);
  });
}

function collectBuildSources(fixtureRoot, io = fs) {
  return buildSourceDefinitions.map((entry) => {
    const violations = validateRelativePath(entry.path, fixtureRoot, io);
    if (violations.length > 0) throw new Error(violations.join('; '));
    const absolute = path.resolve(fixtureRoot, entry.path);
    if (!io.existsSync(absolute)) throw new Error(`missing build source: ${entry.path}`);
    return { ...entry, sha256: sha256(io.readFileSync(absolute)) };
  });
}

export async function writeFixtureManifest(fixtureId = 'G3-REVIEW-001') {
  assertSupportedFixtureId(fixtureId);
  const fixtureRoot = path.join(repoRoot, 'fixtures', 'gate-3', fixtureId);
  const manifestPath = path.join(fixtureRoot, 'fixture-manifest.json');
  const files = definitions.map((entry) => {
    const violations = validateRelativePath(entry.path, fixtureRoot);
    if (violations.length > 0) throw new Error(violations.join('; '));
    const absolute = path.resolve(fixtureRoot, entry.path);
    if (!fs.existsSync(absolute)) throw new Error(`missing fixture file: ${entry.path}`);
    const bytes = fs.readFileSync(absolute);
    const detail = validateFixtureBytes(entry, bytes);
    const failed = Object.entries(detail.checks).filter(([, value]) => value !== true);
    if (failed.length > 0) throw new Error(`fixture validation failed for ${entry.path}: ${failed.map(([key]) => key).join(', ')}`);
    if (entry.expected_pages !== undefined && detail.observedCount !== entry.expected_pages) {
      throw new Error(`fixture count mismatch for ${entry.path}: ${detail.observedCount}`);
    }
    return { ...entry, sha256: sha256(bytes) };
  });
  const manifest = {
    fixture: 'G3-REVIEW-001',
    provenance: expectedProvenance,
    redistributable: true,
    files,
    build_sources: collectBuildSources(fixtureRoot),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export async function auditFixtureSet(fixtureId = 'G3-REVIEW-001', options = {}) {
  assertSupportedFixtureId(fixtureId);
  const io = options.fs ?? fs;
  const fixtureRoot = path.join(repoRoot, 'fixtures', 'gate-3', fixtureId);
  const manifestPath = path.join(fixtureRoot, 'fixture-manifest.json');
  const result = {
    fixture: fixtureId,
    primaryFormats: [],
    hashMismatches: [],
    provenanceViolations: [],
    missingFiles: [],
    signatureViolations: [],
    countViolations: [],
    featureViolations: [],
    builderViolations: [],
    files: []
  };
  const manifest = options.manifest ?? JSON.parse(io.readFileSync(manifestPath, 'utf8'));
  if (manifest.fixture !== fixtureId) result.provenanceViolations.push(`fixture identity: ${manifest.fixture}`);
  if (manifest.provenance !== expectedProvenance) result.provenanceViolations.push('provenance text mismatch');
  if (manifest.redistributable !== true) result.provenanceViolations.push('redistributable must be true');
  if (!compareDefinitions(manifest.files)) result.provenanceViolations.push('manifest definitions do not match the authoritative ordered set');
  if (!compareBuildSourceDefinitions(manifest.build_sources)) {
    result.builderViolations.push('build source definitions do not match the authoritative ordered set');
  }

  for (const entry of manifest.files ?? []) {
    const pathViolations = validateRelativePath(entry?.path, fixtureRoot, io);
    result.provenanceViolations.push(...pathViolations);
    if (pathViolations.length > 0) continue;
    if (!SHA256_RE.test(entry.sha256 ?? '')) {
      result.hashMismatches.push(`${entry.path}: invalid sha256`);
      continue;
    }
    const absolute = path.resolve(fixtureRoot, entry.path);
    if (!io.existsSync(absolute)) {
      result.missingFiles.push(entry.path);
      continue;
    }
    const bytes = io.readFileSync(absolute);
    const actualHash = sha256(bytes);
    if (actualHash !== entry.sha256) result.hashMismatches.push(`${entry.path}: ${actualHash}`);
    let detail;
    try {
      detail = validateFixtureBytes(entry, bytes);
    } catch (error) {
      result.signatureViolations.push(`${entry.path}: ${error.message}`);
      continue;
    }
    if (entry.expected_pages !== undefined && detail.observedCount !== entry.expected_pages) {
      result.countViolations.push(`${entry.path}: expected ${entry.expected_pages}, observed ${detail.observedCount}`);
    }
    for (const [feature, passed] of Object.entries(detail.checks)) {
      if (passed !== true) result.featureViolations.push(`${entry.path}: ${feature}`);
    }
    result.files.push({ path: entry.path, format: entry.format, bytes: bytes.length, sha256: actualHash, observedCount: detail.observedCount, checks: detail.checks });
  }
  for (const entry of manifest.build_sources ?? []) {
    const pathViolations = validateRelativePath(entry?.path, fixtureRoot, io);
    if (pathViolations.length > 0) {
      result.builderViolations.push(...pathViolations);
      continue;
    }
    if (!SHA256_RE.test(entry.sha256 ?? '')) {
      result.builderViolations.push(`${entry.path}: invalid sha256`);
      continue;
    }
    const absolute = path.resolve(fixtureRoot, entry.path);
    if (!io.existsSync(absolute)) {
      result.builderViolations.push(`${entry.path}: missing build source`);
      continue;
    }
    const bytes = io.readFileSync(absolute);
    const actualHash = sha256(bytes);
    if (actualHash !== entry.sha256) result.builderViolations.push(`${entry.path}: ${actualHash}`);
    const text = bytes.toString('utf8');
    if (text.includes('/private/tmp/superwagie-task2-bundled') || text.includes('/Users/')) {
      result.builderViolations.push(`${entry.path}: non-portable absolute path literal`);
    }
  }
  const runtimeLockEntry = (manifest.build_sources ?? []).find((entry) => entry.role === 'runtime-lock');
  if (runtimeLockEntry && !result.builderViolations.some((item) => item.startsWith(runtimeLockEntry.path))) {
    const lock = JSON.parse(io.readFileSync(path.resolve(fixtureRoot, runtimeLockEntry.path), 'utf8'));
    if (lock?.rebuild_contract?.byte_identical_guaranteed !== false) {
      result.builderViolations.push('runtime lock must not claim byte-identical rebuilds');
    }
  }
  result.primaryFormats = [...new Set((manifest.files ?? []).map((entry) => entry.format).filter((format) => ['docx', 'pptx', 'pdf'].includes(format)))];
  result.ok = [result.hashMismatches, result.provenanceViolations, result.missingFiles, result.signatureViolations, result.countViolations, result.featureViolations, result.builderViolations].every((items) => items.length === 0);
  return result;
}

function parseArgs(argv) {
  const parsed = { fixture: 'G3-REVIEW-001', writeManifest: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--fixture') parsed.fixture = argv[++index];
    else if (argv[index] === '--write-manifest') parsed.writeManifest = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.writeManifest) {
      const manifestPath = await writeFixtureManifest(args.fixture);
      process.stdout.write(`WROTE ${path.relative(repoRoot, manifestPath)}\n`);
    }
    const result = await auditFixtureSet(args.fixture);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
