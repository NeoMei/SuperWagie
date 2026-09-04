#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv2020 from './contract-foundation/node_modules/ajv/dist/2020.js';
import addFormats from './contract-foundation/node_modules/ajv-formats/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const gates = Object.freeze(['GVP-0', 'GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5']);
const platforms = Object.freeze(['macos-15-arm64', 'windows-11-x64']);
const excluded = new Set(['rar', '7z', 'dmg']);
const shaPattern = /^sha256:[a-f0-9]{64}$/u;
const allowedAliasSets = new Set(['jpeg,jpg', 'db3,sqlite', 'h5,hdf5', 'yaml,yml', 'mermaid,mmd', 'plantuml,puml', 'step,stp']);

const groupExtensions = Object.freeze({
  'DOCX': ['docx'], 'PPTX': ['pptx'], 'DOC、PPT': ['doc', 'ppt'], 'XLSX、XLS': ['xlsx', 'xls'],
  'CSV、TSV': ['csv', 'tsv'], 'PDF': ['pdf'], 'HWP、HWPX': ['hwp', 'hwpx'], 'LaTeX': ['tex'],
  'TXT、LOG、MD、JSON、JSONL、YAML、TOML、XML、常见代码': ['txt', 'log', 'md', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'sql', 'html', 'css'],
  'JPG、JPEG、PNG、GIF、BMP、WebP、SVG': ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'],
  'PSD': ['psd'], 'MP3、WAV、OGG、FLAC、AAC、M4A、MP4、WebM、MOV 等': ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'mp4', 'webm', 'mov'],
  'Parquet、Avro、SQLite/DB3、HDF5、MAT、NPY/NPZ': ['parquet', 'avro', 'sqlite', 'db3', 'hdf5', 'h5', 'mat', 'npy', 'npz'],
  'Mermaid、PlantUML、Shapefile': ['mermaid', 'mmd', 'plantuml', 'puml', 'shp'],
  'DBC、ARXML、A2L、ASC、BLF、MF4、PCAP/PCAPNG、ROS bag、STEP、ReqIF': ['dbc', 'arxml', 'a2l', 'asc', 'blf', 'mf4', 'pcap', 'pcapng', 'bag', 'step', 'stp', 'reqif'],
  'Safetensors、GGUF、ONNX、TFLite、Keras': ['safetensors', 'gguf', 'onnx', 'tflite', 'keras'],
  'ZIP、JAR、APK': ['zip', 'jar', 'apk'], 'TAR、TGZ、GZ、BZ2、XZ': ['tar', 'tgz', 'gz', 'bz2', 'xz']
});

export function parseDesignExtensions(text) {
  const section = text.split('## 5. 格式矩阵与支持语义')[1]?.split('### 5.1')[0] ?? '';
  const result = new Set();
  for (const line of section.split(/\r?\n/u)) {
    const firstCell = line.match(/^\|\s*([^|]+?)\s*\|/u)?.[1]?.trim();
    if (!firstCell || firstCell === '格式组' || /^-+$/.test(firstCell)) continue;
    groupExtensions[firstCell]?.forEach(extension => result.add(extension));
  }
  return result;
}

export function parseMatrixGateMap(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const id = line.match(/^\|\s*(VIEW-[0-9]{2})\s*\|/u)?.[1];
    if (id) map.set(id, [...new Set(line.match(/GVP-[0-5]/gu) ?? [])]);
  }
  return map;
}

export function parseGateMeanings(text) {
  const meanings = new Map();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim().replace(/^[|`>*\-\s]+/u, '').replace(/^→\s*/u, '');
    const table = line.match(/^(GVP-[0-5])\s*\|\s*([^|]+?)\s*\|/u);
    const plain = line.match(/^(GVP-[0-5])\s+(Contract \+ Provenance|Office Fidelity|Per-format Corpus|Isolation \+ Malicious Files|Package \+ Performance|Product Integration \+ Recovery)\s*$/u);
    const match = table ?? plain;
    if (match) meanings.set(match[1], match[2].trim());
  }
  return meanings;
}

const receiptAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(receiptAjv);
const resourceSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/contracts/v1/resource-handle.schema.json'), 'utf8'));
const receiptSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/contracts/v1/viewer-gate-receipt.schema.json'), 'utf8'));
receiptAjv.addSchema(resourceSchema);
receiptAjv.addSchema(receiptSchema);
const validateReceiptShape = receiptAjv.getSchema(`${receiptSchema.$id}#/$defs/ViewerGateReceipt`);

export function verifyViewerReceiptBinding(record, ref, receiptResolver) {
  const errors = [];
  const label = `${record.format_variant_id} ${ref?.receipt_id ?? '<unknown>'}`;
  if (!(record.required_gates ?? []).includes(ref?.gate_id)) errors.push(`RECEIPT_GATE_NOT_REQUIRED ${label}`);
  if (!(record.required_platforms ?? []).includes(ref?.platform_id)) errors.push(`RECEIPT_PLATFORM_NOT_REQUIRED ${label}`);
  const text = typeof receiptResolver === 'function' ? receiptResolver(ref?.receipt_path) : undefined;
  if (typeof text !== 'string') return { valid: false, errors: [`RECEIPT_FILE_MISSING ${label}`], receipt: null };
  const actualHash = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  if (actualHash !== ref?.receipt_sha256) errors.push(`RECEIPT_FILE_HASH_MISMATCH ${label}`);
  let receipt;
  try { receipt = JSON.parse(text); } catch { return { valid: false, errors: [...errors, `RECEIPT_SCHEMA_INVALID ${label}`], receipt: null }; }
  if (!validateReceiptShape(receipt)) return { valid: false, errors: [...errors, `RECEIPT_SCHEMA_INVALID ${label}`], receipt: null };
  if (ref.receipt_id !== receipt.receipt_id) errors.push(`INVENTED_RECEIPT_ID ${label}`);
  if (ref.gate_id !== receipt.gate_id) errors.push(`RECEIPT_GATE_MISMATCH ${label}`);
  if (ref.platform_id !== receipt.platform_id) errors.push(`RECEIPT_PLATFORM_MISMATCH ${label}`);
  if (receipt.verdict !== 'GO') errors.push(`RECEIPT_VERDICT_NOT_GO ${label}`);
  if (receipt.format_variant_id !== record.format_variant_id) errors.push(`RECEIPT_FORMAT_MISMATCH ${label}`);
  if (receipt.corpus_id !== record.corpus_id) errors.push(`RECEIPT_CORPUS_MISMATCH ${label}`);
  if (!record.chunk_manifest_sha256 || receipt.chunk_manifest_sha256 !== record.chunk_manifest_sha256) errors.push(`RECEIPT_CHUNK_MISMATCH ${label}`);
  if (receipt.viewer_id !== record.candidate_id) errors.push(`RECEIPT_CANDIDATE_MISMATCH ${label}`);
  if (receipt.viewer_version !== record.candidate_version) errors.push(`RECEIPT_VERSION_MISMATCH ${label}`);
  return { receipt, valid: errors.length === 0, errors };
}

export function auditViewerReceiptBindings(record, receiptResolver) {
  const errors = [];
  const validPairs = new Set();
  let invalidRefs = 0;
  for (const ref of record.admission_receipt_refs ?? []) {
    const result = verifyViewerReceiptBinding(record, ref, receiptResolver);
    errors.push(...result.errors);
    if (result.valid) validPairs.add(`${ref.platform_id}:${ref.gate_id}`);
    else invalidRefs += 1;
  }
  return { errors, validPairs, invalid_refs: invalidRefs };
}

export function auditViewerLedgerData({ ledger, designExtensions, matrixGateMap, requireInitialResearch = true, receiptResolver, designGateMeanings, gateMeaningDocuments = [] }) {
  const errors = [];
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const ids = records.map(record => record.format_variant_id);
  ids.filter((id, index) => ids.indexOf(id) !== index).forEach(id => errors.push(`DUPLICATE_FORMAT_VARIANT_ID ${id}`));
  const covered = new Set(records.flatMap(record => record.extensions ?? []).map(value => value.toLowerCase()));
  for (const extension of designExtensions) if (!covered.has(extension)) errors.push(`DESIGN_EXTENSION_MISSING_FROM_LEDGER ${extension}`);
  for (const extension of excluded) if (covered.has(extension)) errors.push(`EXCLUDED_EXTENSION_PRESENT ${extension}`);
  const matrixGates = new Set([...matrixGateMap.values()].flatMap(value => Array.isArray(value) ? value : [value]));
  for (const { path: documentPath, meanings } of gateMeaningDocuments) for (const gate of gates) {
    if (meanings?.get(gate) !== designGateMeanings?.get(gate)) errors.push(`GVP_GATE_MEANING_MISMATCH ${documentPath} ${gate}`);
  }
  for (const record of records) {
    const aliasKey = [...(record.extensions ?? [])].sort().join(',');
    if ((record.extensions ?? []).length > 1 && !allowedAliasSets.has(aliasKey)) errors.push(`HETEROGENEOUS_VARIANTS_CONSOLIDATED ${record.format_variant_id} ${aliasKey}`);
    if (requireInitialResearch && record.current_state !== 'RESEARCH_REQUIRED') errors.push(`INITIAL_STATE_NOT_RESEARCH_REQUIRED ${record.format_variant_id}`);
    for (const gate of record.required_gates ?? []) if (!matrixGates.has(gate)) errors.push(`MATRIX_GATE_MAPPING_MISSING ${gate} ${record.format_variant_id}`);
    const receiptAudit = auditViewerReceiptBindings(record, receiptResolver);
    errors.push(...receiptAudit.errors);
    const validPairs = receiptAudit.validPairs;
    if (String(record.current_state).startsWith('PROVEN_')) for (const platform of record.required_platforms ?? []) for (const gate of record.required_gates ?? []) {
      if (!validPairs.has(`${platform}:${gate}`)) errors.push(`PROVEN_RECORD_MISSING_BOUND_RECEIPT ${record.format_variant_id} ${platform} ${gate}`);
    }
  }
  return { errors, record_count: records.length, covered_extensions: covered.size };
}

export function createSafeReceiptResolver(root) {
  const absoluteRoot = path.resolve(root);
  let realRoot;
  try { realRoot = fs.realpathSync(absoluteRoot); } catch { return () => undefined; }
  return relativePath => {
    if (typeof relativePath !== 'string' || relativePath.includes('\\') || path.isAbsolute(relativePath)
      || relativePath.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined;
    const absolute = path.resolve(absoluteRoot, relativePath);
    const expectedReal = path.join(realRoot, ...relativePath.split('/'));
    if (!absolute.startsWith(`${absoluteRoot}${path.sep}`)) return undefined;
    try {
      const stat = fs.lstatSync(absolute);
      const real = fs.realpathSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || real !== expectedReal || !real.startsWith(`${realRoot}${path.sep}`)) return undefined;
      return fs.readFileSync(real, 'utf8');
    } catch { return undefined; }
  };
}

export function auditViewerLedger(root = repoRoot) {
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const ledger = JSON.parse(read('docs/contracts/v1/format-admission-ledger.json'));
  const design = read('docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md');
  const matrix = read('docs/技术可行性/技术要求矩阵.md');
  const status = JSON.parse(read('docs/技术可行性/当前技术验证状态.json'));
  const sources = ['docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md', 'docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md', 'docs/技术可行性/技术验证执行计划.md', 'rules/viewer-platform.md'];
  const gateMeaningDocuments = sources.map(documentPath => ({ path: documentPath, meanings: parseGateMeanings(read(documentPath)) }));
  gateMeaningDocuments.push({ path: 'docs/contracts/v1/format-admission-ledger.json', meanings: new Map(Object.entries(ledger.gate_meanings ?? {})) });
  gateMeaningDocuments.push({ path: 'docs/技术可行性/当前技术验证状态.json', meanings: new Map((status.fixtures ?? []).filter(item => gates.includes(item.fixture)).map(item => [item.fixture, item.meaning])) });
  return auditViewerLedgerData({ ledger, designExtensions: parseDesignExtensions(design), matrixGateMap: parseMatrixGateMap(matrix), receiptResolver: createSafeReceiptResolver(root), designGateMeanings: parseGateMeanings(design), gateMeaningDocuments });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditViewerLedger();
  if (result.errors.length) { result.errors.forEach(error => console.error(`FAIL ${error}`)); process.exit(1); }
  console.log(`PASS viewer ledger records=${result.record_count} extensions=${result.covered_extensions}`);
}
