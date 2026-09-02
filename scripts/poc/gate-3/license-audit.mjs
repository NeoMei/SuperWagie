#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = Object.freeze({
  'docx-preview': ['Apache-2.0'],
  'pdfjs-dist': ['Apache-2.0'],
  '@tauri-apps/api': ['Apache-2.0', 'MIT']
});
const FORBIDDEN = [
  { code: 'CHATGPT_APP', bytes: Buffer.from('ChatGPT.app') },
  { code: 'CODEX_APP', bytes: Buffer.from('Codex.app') },
  { code: 'CHATGPT_APPLICATION_PATH', bytes: Buffer.from('/Applications/ChatGPT.app') },
  { code: 'CODEX_STATE_PATH', bytes: Buffer.from('/.codex/') },
  { code: 'CODEX_STATE_COMPONENT', bytes: Buffer.from('.codex') },
  { code: 'CODEX_HOME', bytes: Buffer.from('CODEX_HOME') },
  { code: 'CODEX_SOCKET', bytes: Buffer.from('codex.sock') },
  { code: 'CODEX_REVIEWER_ASSET', bytes: Buffer.from('Codex Reviewer') }
];

function parseLicenseExpression(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const normalized = value.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+/i).map((item) => item.trim()).filter(Boolean);
  return [...new Set(normalized)].sort();
}

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function licenseFiles(packageRoot) {
  return (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^(?:license|copying|notice)/i.test(entry.name))
    .map((entry) => entry.name).sort();
}

export async function auditDirectLicenses(nodeModulesRoot = path.join(HERE, 'node_modules')) {
  const packages = [];
  const violations = [];
  for (const name of Object.keys(POLICY).sort()) {
    const packageRoot = path.join(nodeModulesRoot, ...name.split('/'));
    try {
      const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      const licenses = parseLicenseExpression(metadata.license ?? metadata.licenses?.map((entry) => entry.type).join(' OR '));
      const files = await licenseFiles(packageRoot);
      const expected = [...POLICY[name]].sort();
      if (metadata.name !== name || typeof metadata.version !== 'string' || metadata.version.length === 0) violations.push(`${name}:metadata-invalid`);
      if (licenses.join('\0') !== expected.join('\0')) violations.push(`${name}:license-policy-mismatch`);
      if (files.length === 0) violations.push(`${name}:license-file-missing`);
      const fileProvenance = [];
      for (const file of files) fileProvenance.push({ name: file, sha256: await digest(path.join(packageRoot, file)) });
      packages.push({ name, version: metadata.version ?? null, licenses, license_files: fileProvenance });
    } catch {
      violations.push(`${name}:metadata-or-license-missing`);
      packages.push({ name, version: null, licenses: [], license_files: [] });
    }
  }
  return { ok: violations.length === 0, policy: POLICY, packages, violations: violations.sort() };
}

async function filesRecursively(root) {
  const result = [];
  let metadata;
  try { metadata = await stat(root); } catch { return result; }
  if (metadata.isFile()) return [root];
  if (!metadata.isDirectory()) return result;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesRecursively(child));
    else if (entry.isFile()) result.push(child);
  }
  return result.sort();
}

function productionRustBytes(file, bytes) {
  if (path.extname(file) !== '.rs') return bytes;
  const text = bytes.toString('utf8');
  const marker = text.search(/#\[cfg\(test\)\]\s*mod\s+tests\s*\{/);
  return Buffer.from(marker < 0 ? text : text.slice(0, marker));
}

export async function scanForbiddenCoupling(roots) {
  const violations = [];
  for (const root of roots) {
    for (const file of await filesRecursively(root)) {
      let bytes = await readFile(file);
      bytes = productionRustBytes(file, bytes);
      for (const token of FORBIDDEN) {
        if (bytes.includes(token.bytes)) violations.push({ file: path.basename(file), token: token.code });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function cargoInventory(metadata) {
  return metadata.packages.map((entry) => ({
    name: entry.name,
    version: entry.version,
    license: entry.license ?? null,
    source: entry.source ?? 'path',
    checksum: entry.checksum ?? null
  })).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.source.localeCompare(right.source));
}

export function cargoMetadataProjection(metadata) {
  if (!metadata || !Array.isArray(metadata.packages) || !metadata.resolve || !Array.isArray(metadata.resolve.nodes)) throw new Error('Cargo metadata invalid');
  const byRawId = new Map();
  for (const entry of metadata.packages) {
    const sourceKind = entry.source === null ? 'workspace' : String(entry.source).startsWith('registry+') ? 'registry' : String(entry.source).startsWith('git+') ? 'git' : 'external';
    byRawId.set(entry.id, `${entry.name}@${entry.version}#${sourceKind}`);
  }
  const normalizeId = (raw) => {
    const value = byRawId.get(raw);
    if (!value) throw new Error('Cargo resolve references unknown package');
    return value;
  };
  const root = metadata.resolve.root === null ? null : normalizeId(metadata.resolve.root);
  const packages = metadata.packages.map((entry) => ({
    id: normalizeId(entry.id), name: entry.name, version: entry.version,
    source_kind: entry.source === null ? 'workspace' : String(entry.source).startsWith('registry+') ? 'registry' : String(entry.source).startsWith('git+') ? 'git' : 'external',
    source_identity: entry.source === null ? 'workspace' : /^(?:registry|git)\+https?:\/\//.test(String(entry.source)) ? entry.source : `sha256:${createHash('sha256').update(String(entry.source)).digest('hex')}`,
    checksum: entry.checksum ?? null, license: entry.license ?? null
  })).sort((left, right) => left.id.localeCompare(right.id));
  const nodes = metadata.resolve.nodes.map((node) => ({
    package: normalizeId(node.id),
    dependencies: (node.deps ?? []).map((dependency) => ({
      name: dependency.name, package: normalizeId(dependency.pkg),
      kinds: (dependency.dep_kinds ?? []).map((kind) => ({ kind: kind.kind ?? 'normal', target: kind.target ?? null }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    })).sort((left, right) => left.name.localeCompare(right.name) || left.package.localeCompare(right.package)),
    features: [...(node.features ?? [])].sort()
  })).sort((left, right) => (left.package === root ? -1 : right.package === root ? 1 : left.package.localeCompare(right.package)));
  return {
    schema_id: 'superwagie.cargo-locked-projection.v1', schema_version: 1,
    root, workspace_members: (metadata.workspace_members ?? []).map(normalizeId).sort(), packages,
    resolve: { nodes }
  };
}

function parseArgs(argv) {
  const result = {};
  const known = new Map([
    ['--output', 'output'], ['--node-modules', 'nodeModules'], ['--cargo-manifest', 'cargoManifest'],
    ['--ui-dist', 'uiDist'], ['--rust-source', 'rustSource'], ['--executable', 'executable'],
    ['--cargo-projection-output', 'cargoProjectionOutput']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') return { help: true };
    const key = known.get(argv[index]);
    if (!key || index + 1 >= argv.length || result[key] !== undefined) throw new Error(`invalid argument: ${argv[index]}`);
    result[key] = argv[++index];
  }
  return result;
}

function absolute(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(value);
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (args.help) { console.log('license-audit.mjs --output ABS'); return 0; }
  if (!args.output) { console.error('--output is required'); return 2; }
  let output;
  try { output = absolute(args.output, '--output'); } catch (error) { console.error(error.message); return 2; }
  const nodeModules = args.nodeModules ? absolute(args.nodeModules, '--node-modules') : path.join(HERE, 'node_modules');
  const cargoManifest = args.cargoManifest ? absolute(args.cargoManifest, '--cargo-manifest') : path.join(HERE, 'reviewer-shell/Cargo.toml');
  const scanRoots = [
    args.uiDist ? absolute(args.uiDist, '--ui-dist') : path.join(HERE, 'reviewer-ui/dist'),
    args.rustSource ? absolute(args.rustSource, '--rust-source') : path.join(HERE, 'reviewer-shell/src'),
    args.executable ? absolute(args.executable, '--executable') : path.join(HERE, 'reviewer-shell/target/debug/superwagie-reviewer-poc')
  ];
  const direct = await auditDirectLicenses(nodeModules);
  const cargo = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', cargoManifest], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let cargoPackages = [];
  let cargoProjection = null;
  const violations = [...direct.violations];
  if (cargo.status !== 0) violations.push('cargo-metadata-failed');
  else {
    try {
      const raw = JSON.parse(cargo.stdout);
      cargoPackages = cargoInventory(raw);
      cargoProjection = cargoMetadataProjection(raw);
    } catch { violations.push('cargo-metadata-invalid'); }
  }
  if (args.cargoProjectionOutput && cargoProjection) {
    const projectionOutput = absolute(args.cargoProjectionOutput, '--cargo-projection-output');
    await writeFile(projectionOutput, `${JSON.stringify(cargoProjection, null, 2)}\n`, { mode: 0o600 });
  }
  const coupling = await scanForbiddenCoupling(scanRoots);
  if (!coupling.ok) violations.push('forbidden-coupling');
  const inventory = {
    schema_version: 1,
    direct_npm: direct.packages,
    cargo_packages: cargoPackages,
    coupling_scan: coupling,
    policy: POLICY,
    license_provenance_preserved: true,
    commercial_redistribution_approval: false,
    wps_terms_review: 'required-before-GO',
    scan_exclusions: ['Rust #[cfg(test)] modules only; production assets are never excluded'],
    ok: violations.length === 0,
    violations: [...new Set(violations)].sort()
  };
  await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  return inventory.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
export { POLICY as ALLOWED_DIRECT, cargoInventory, main, parseLicenseExpression };
