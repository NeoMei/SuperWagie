import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_OFFICE_BUDGET = 20 * 1024 * 1024;
const TOTAL_BUDGET = 50 * 1024 * 1024;
const CONTRACT_FIELDS = [
  'arch', 'assets', 'build_provenance', 'chunk_id', 'chunk_version', 'code', 'compressed_bytes',
  'descriptor_ids', 'direct_dependencies', 'file_hashes', 'fonts', 'installed_bytes', 'license_refs',
  'notice_refs', 'platform_id', 'signature', 'source_provenance', 'transitive_dependencies',
];
class InputError extends Error {}

function input(message) {
  throw new InputError(`Chunk audit input unavailable: ${message}`);
}

function allFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...allFiles(root, full));
    else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    else input(`special filesystem entry is forbidden: ${full}`);
  }
  return files.sort();
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeEvidence(raw) {
  if (!raw?.manifest_candidate) {
    return { manifest: raw, files: raw?.files, envelope: raw, schemaEnvelope: false };
  }
  const manifest = raw.manifest_candidate;
  const files = [
    ...(manifest.code ?? []),
    ...(manifest.assets ?? []),
    ...(manifest.fonts ?? []),
    ...(manifest.license_refs ?? []),
    ...(manifest.notice_refs ?? []),
  ].filter((value, index, all) => all.indexOf(value) === index).sort();
  return { manifest, files, envelope: raw, schemaEnvelope: true };
}

export function auditChunkData({ distRoot } = {}) {
  if (typeof distRoot !== 'string' || !path.isAbsolute(distRoot)) input('dist root must be an explicit absolute path');
  try {
    if (!statSync(distRoot).isDirectory()) input('dist root is not a directory');
  } catch {
    input('dist root does not exist');
  }
  const manifestPaths = allFiles(distRoot).filter((file) => file.endsWith('/chunk-manifest.poc.json'));
  if (manifestPaths.length === 0) input('no PoC chunk manifests were found');
  const manifests = manifestPaths.map((file) => {
    try {
      const raw = JSON.parse(readFileSync(path.join(distRoot, file), 'utf8'));
      return { file, ...normalizeEvidence(raw) };
    }
    catch (error) { input(`invalid chunk manifest ${file}: ${error.message}`); }
  }).sort((a, b) => String(a.manifest?.chunk_id).localeCompare(String(b.manifest?.chunk_id)));

  const violations = [];
  const owners = new Map();
  let baseOffice = 0;
  let total = 0;
  for (const { manifest, files, envelope, schemaEnvelope } of manifests) {
    if (envelope.signature_state !== 'poc_unsigned_not_loadable' || envelope.production_loadable !== false) {
      violations.push({ rule: 'signature_state', chunk_id: manifest.chunk_id });
    }
    if (!Array.isArray(files)) input(`manifest ${manifest.chunk_id} has no files array`);
    for (const file of files) {
      const existing = owners.get(file);
      if (existing) violations.push({ rule: 'overlapping_file', file, chunks: [existing, manifest.chunk_id].sort() });
      else owners.set(file, manifest.chunk_id);
      const physical = path.join(distRoot, manifest.chunk_id, file);
      try {
        const bytes = readFileSync(physical);
        const expected = (manifest.file_hashes ?? []).find((item) => item.logical_name === file)?.sha256;
        if (expected && expected !== sha256(bytes)) violations.push({ rule: 'file_hash_mismatch', chunk_id: manifest.chunk_id, file });
      } catch {
        violations.push({ rule: 'missing_owned_file', chunk_id: manifest.chunk_id, file });
      }
    }
    if (schemaEnvelope) {
      const actualFields = Object.keys(manifest).sort();
      if (CONTRACT_FIELDS.some((field) => manifest[field] === undefined) || JSON.stringify(actualFields) !== JSON.stringify(CONTRACT_FIELDS)) {
        violations.push({ rule: 'manifest_contract_shape', chunk_id: manifest.chunk_id });
      }
      const measured = files.map((file) => ({ file, bytes: readFileSync(path.join(distRoot, manifest.chunk_id, file)) }));
      const installed = measured.reduce((sum, item) => sum + item.bytes.length, 0);
      const compressionInput = Buffer.concat(measured.flatMap((item) => [Buffer.from(`${item.file}\0`), item.bytes]));
      const compressed = gzipSync(compressionInput, { level: 9 }).length;
      if (installed !== manifest.installed_bytes) violations.push({ rule: 'installed_measurement_mismatch', chunk_id: manifest.chunk_id });
      if (compressed !== manifest.compressed_bytes) violations.push({ rule: 'compressed_measurement_mismatch', chunk_id: manifest.chunk_id });
    }
    if (schemaEnvelope || manifest.status === 'poc_built') {
      if (!Number.isInteger(manifest.compressed_bytes) || manifest.compressed_bytes < 1) input(`manifest ${manifest.chunk_id} has invalid compressed bytes`);
      total += manifest.compressed_bytes;
      if (['viewer-base', 'viewer-office'].includes(manifest.chunk_id)) baseOffice += manifest.compressed_bytes;
    }
  }

  for (const file of allFiles(distRoot)) {
    if (file.endsWith('/chunk-manifest.poc.json')) continue;
    const [chunkId, ...rest] = file.split('/');
    const logical = rest.join('/');
    if (!owners.has(logical) || owners.get(logical) !== chunkId) violations.push({ rule: 'unowned_file', file });
  }
  if (baseOffice > BASE_OFFICE_BUDGET) violations.push({ rule: 'base_office_budget', actual: baseOffice, limit: BASE_OFFICE_BUDGET });
  if (total > TOTAL_BUDGET) violations.push({ rule: 'total_budget', actual: total, limit: TOTAL_BUDGET });
  violations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    schema_id: 'superwagie.viewer-chunk-audit.v1',
    decision: violations.length === 0 ? 'GO' : 'NO_GO',
    built_chunks: manifests.filter(({ manifest, schemaEnvelope }) => schemaEnvelope || manifest.status === 'poc_built').map(({ manifest }) => manifest.chunk_id),
    base_office_compressed_bytes: baseOffice,
    total_compressed_bytes: total,
    poc_manifests_non_loadable: manifests.every(({ envelope }) => envelope.signature_state === 'poc_unsigned_not_loadable' && envelope.production_loadable === false),
    violations,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || !['--dist-root', '--output'].includes(name)) input(`${name ?? '<argument>'} is unsupported or missing a value`);
    if (name === '--dist-root') options.distRoot = value;
    else options.outputPath = value;
  }
  if (!options.distRoot || !options.outputPath) input('--dist-root and --output are required');
  const result = auditChunkData({ distRoot: options.distRoot });
  const output = path.resolve(options.outputPath);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision !== 'GO') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof InputError ? 2 : 1;
  }
}
