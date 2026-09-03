import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { verifyAcquiredCandidate } from './acquire-frozen-core.mjs';
import { auditChunkData } from './chunk-audit.mjs';
import { auditDependencyData } from './dependency-audit.mjs';
import {
  createBuildProvenance,
  createEvidenceIndex,
  provenanceBytes,
  sha256 as evidenceSha256,
  verifyBuildProvenance,
  verifyEvidenceIndex,
} from './evidence-bundle.mjs';
import { runOfficeClosureSmoke } from './office-closure-smoke.mjs';
import { auditSourcePolicy } from './source-policy-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_LOCK_PATH = path.join(HERE, 'source-lock.json');
const PATCH_LEDGER_PATH = path.join(HERE, 'patch-ledger.json');
const CHUNK_PLAN_PATH = path.join(HERE, 'chunk-plan.json');
const SOURCE_POLICY_PATH = path.join(HERE, 'fixtures', 'source-policy-forbidden.json');
const DEPENDENCY_POLICY_PATH = path.join(HERE, 'fixtures', 'dependency-policy.json');
const AUDIT_ROOT = path.join(HERE, 'audit');
const BASELINE_ROOT = path.join(HERE, 'baseline-evidence');
const RUNTIME_LOCK_PATH = path.join(HERE, 'package-lock.json');
const SBOM_ARGS = ['sbom', '--package-lock-only', '--omit=dev', '--omit=optional', '--sbom-format', 'cyclonedx'];
const NPM_IDENTITY = '11.16.0';
const POC_SIGNATURE_SENTINEL = 'poc_unsigned_not_loadable_reserved_sentinel_000';
const OWNERSHIP_MARKER = '.superwagie-viewer-poc-owned';
const BASELINE_README = `# Universal Viewer Task 3 baseline evidence

This tracked bundle is deterministic review evidence, not a production admission.
\`admission-decision.json\` is authoritative for this run. The CycloneDX document
comes from the exact admitted npm command; only its random serial number and wall-clock
timestamp are removed in the tracked copy. The untouched raw live SBOM remains under
the ignored \`audit/\` directory. \`index.json\` binds every review artifact by SHA-256.
`;

class InputError extends Error {}
class PolicyError extends Error {}

function input(message) {
  throw new InputError(`Candidate build input unavailable: ${message}`);
}

function reject(message) {
  throw new PolicyError(`Candidate build rejected: ${message}`);
}

function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { input(`${label} is missing or invalid JSON: ${error.message}`); }
}

function requireAbsoluteDirectory(value, label, mayNotExist = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) input(`${label} must be an explicit absolute path`);
  const resolved = path.resolve(value);
  if (!mayNotExist) {
    try { if (!statSync(resolved).isDirectory()) input(`${label} is not a directory`); }
    catch { input(`${label} does not exist`); }
  }
  return resolved;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args, cwd, { allowNonzero = false } = {}) {
  const started = Date.now();
  const childEnv = { ...process.env };
  delete childEnv.npm_config_allow_scripts;
  delete childEnv.NPM_CONFIG_ALLOW_SCRIPTS;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: childEnv,
  });
  if (result.error?.code === 'ENOENT') input(`required tool ${command} is missing`);
  const record = {
    command: [command, ...args].join(' '),
    exit_code: result.status ?? 2,
    elapsed_millis: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (record.exit_code !== 0 && !allowNonzero) {
    const detail = record.stderr.trim().split('\n').slice(-4).join(' | ');
    reject(`${record.command} failed with exit ${record.exit_code}${detail ? `: ${detail}` : ''}`);
  }
  return record;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function prepareOwnedRoot(root, label) {
  if (existsSync(root)) {
    const entries = readdirSync(root);
    if (entries.length > 0 && !entries.includes(OWNERSHIP_MARKER)) input(`${label} is not marker-owned by this PoC`);
    if (entries.includes(OWNERSHIP_MARKER)) rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, OWNERSHIP_MARKER), 'superwagie-viewer-poc-owned-v1\n');
}

function prepareDeveloperCache(sourceRoot, outputRoot) {
  const developerRoot = path.join(outputRoot, '.developer-cache');
  const archivePath = path.join(outputRoot, '.developer-cache.tar');
  mkdirSync(developerRoot, { recursive: true });
  run('git', ['archive', '--format=tar', '--output', archivePath, 'HEAD'], sourceRoot);
  run('tar', ['-xf', archivePath, '-C', developerRoot], outputRoot);
  rmSync(archivePath, { force: true });
  return developerRoot;
}

function verifyLedger(ledger, sourceLock, receipt) {
  if (ledger.schema_id !== 'superwagie.viewer-patch-ledger.v1') input('patch ledger schema is invalid');
  if (ledger.candidate_commit !== sourceLock.commit || receipt.commit !== sourceLock.commit) reject('patch ledger commit differs from acquired source');
  if (!Array.isArray(ledger.patches) || ledger.patches.length !== 0) reject('Frozen Core admission requires a zero-patch ledger');
  if (ledger.source_tree_sha256 !== sourceLock.source_tree_sha256 || ledger.post_patch_tree_sha256 !== sourceLock.source_tree_sha256) {
    reject('pristine post-patch tree identity differs from locked source tree identity');
  }
  const findings = new Map((ledger.excluded_host_findings ?? []).map((item) => [item.package, item]));
  const dompurify = findings.get('dompurify');
  const mermaid = findings.get('mermaid');
  if (
    dompurify?.audited_commit !== '1db3137806dc4047513f6abd2ec010030e5029a2'
    || dompurify?.reason !== 'host_not_imported'
    || !dompurify.advisories?.includes('GHSA-55q2-fjhq-7xh7')
  ) input('DOMPurify excluded-host finding is incomplete');
  const requiredMermaid = [
    'GHSA-c4c3-pg64-4m4v',
    'GHSA-6x64-9x62-f2gx',
    'GHSA-3rrr-jr9j-h3q3',
    'GHSA-2v8p-3f2j-5mp7',
    'GHSA-rhh3-jpg6-66xh',
  ];
  if (
    mermaid?.audited_commit !== '1db3137806dc4047513f6abd2ec010030e5029a2'
    || mermaid?.reason !== 'host_not_imported'
    || requiredMermaid.some((advisory) => !mermaid.advisories?.includes(advisory))
  ) input('Mermaid excluded-host finding is incomplete');
}

function builtChunks(plan) {
  const ids = plan.chunks?.map((chunk) => chunk.chunk_id);
  const expected = ['viewer-base', 'viewer-office', 'viewer-media', 'viewer-data', 'viewer-specialized'];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) input('chunk plan must declare all five chunks in canonical order');
  const built = plan.chunks.filter((chunk) => chunk.status === 'poc_built');
  if (built.some((chunk) => !['viewer-base', 'viewer-office'].includes(chunk.chunk_id))) reject('only base and office chunks may be built in this PoC');
  if (built.length !== 2 || plan.chunks.slice(2).some((chunk) => chunk.status !== 'planned_not_built')) {
    input('future chunks must remain planned_not_built and unselected');
  }
  return built;
}

function generatedEntry(chunk, candidateRoot) {
  const exports = chunk.entry_exports.map((entry) => {
    if (!Array.isArray(entry.exports) || entry.exports.length === 0) input(`${chunk.chunk_id} has an empty export selection`);
    const compiled = path.join(candidateRoot, 'dist', entry.source.replace(/^src\//, '').replace(/\.ts$/, '.js'));
    return `export { ${entry.exports.join(', ')} } from ${JSON.stringify(compiled)};`;
  });
  if (chunk.chunk_id === 'viewer-office') {
    const wordModule = path.join(candidateRoot, 'dist', 'viewers', 'word', 'index.js');
    exports.push(
      `import { mountWordViewer as coreMountWordViewer } from ${JSON.stringify(wordModule)};`,
      "import * as bundledDocxPreview from 'docx-preview';",
      "import bundledJSZip from 'jszip';",
      'export function mountBundledWordViewer(input, container, ctx, options = {}) {',
      '  return coreMountWordViewer(input, container, ctx, {',
      '    loadDocxPreview: async () => bundledDocxPreview,',
      '    loadZip: async () => bundledJSZip,',
      '  }, options);',
      '}',
    );
  }
  return exports.join('\n');
}

function normalizeModuleId(id, candidateRoot, entryPath) {
  if (id === entryPath) return '<generated-entry>';
  const nodeModules = id.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  if (nodeModules !== -1) return `node_modules/${id.slice(nodeModules + `${path.sep}node_modules${path.sep}`.length).split(path.sep).join('/')}`;
  const relative = path.relative(candidateRoot, id).split(path.sep).join('/');
  return relative.startsWith('../') ? `<outside-candidate>/${path.basename(id)}` : relative;
}

async function bundleChunk({ chunk, candidateRoot, outputRoot }) {
  const chunkRoot = path.join(outputRoot, chunk.chunk_id);
  mkdirSync(chunkRoot, { recursive: true });
  const entryPath = path.join(outputRoot, `.entry-${chunk.chunk_id}.mjs`);
  writeFileSync(entryPath, `${generatedEntry(chunk, candidateRoot)}\n`);
  const rolldownUrl = pathToFileURL(path.join(HERE, 'node_modules', 'rolldown', 'dist', 'index.mjs')).href;
  let rolldownModule;
  try { rolldownModule = await import(rolldownUrl); }
  catch (error) { input(`locked upstream build tool rolldown is unavailable: ${error.message}`); }
  const bundlePath = path.join(chunkRoot, `${chunk.chunk_id}.mjs`);
  let bundle;
  try {
    bundle = await rolldownModule.rolldown({ input: entryPath, treeshake: true });
    const result = await bundle.write({ file: bundlePath, format: 'esm', minify: true, comments: false });
    const outputChunk = result.output.find((item) => item.type === 'chunk');
    if (!outputChunk) reject(`${chunk.chunk_id} emitted no JavaScript chunk`);
    const moduleIds = Object.keys(outputChunk.modules ?? {}).map((id) => normalizeModuleId(id, candidateRoot, entryPath)).sort();
    const externalImports = [...(outputChunk.imports ?? []), ...(outputChunk.dynamicImports ?? [])].sort();
    const thirdPartyModules = moduleIds.filter((id) => id.includes('node_modules/'));
    return {
      bundlePath,
      moduleGraph: {
        chunk_id: chunk.chunk_id,
        entry_exports: chunk.entry_exports,
        modules: moduleIds,
        external_imports: externalImports,
        third_party_modules: thirdPartyModules,
      },
      buildTool: `rolldown@${rolldownModule.VERSION}`,
    };
  } finally {
    await bundle?.close();
    rmSync(entryPath, { force: true });
  }
}

function packageIdentity(name, version) {
  return `npm:${name.replaceAll('@', '').replaceAll('/', ':')}:${version}`;
}

function productionRuntimePackages(lock) {
  return Object.entries(lock.packages).flatMap(([lockPath, metadata]) => {
    if (!lockPath || metadata.dev === true || metadata.optional === true) return [];
    const marker = 'node_modules/';
    const name = lockPath.slice(lockPath.lastIndexOf(marker) + marker.length);
    return [{ lockPath, name, ...metadata }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function copyRuntimeLicenses(chunkRoot, runtimePackages) {
  const refs = [];
  for (const runtime of runtimePackages) {
    const packageRoot = path.join(HERE, runtime.lockPath);
    const licenseFile = readdirSync(packageRoot).find((name) => /^(?:license|copying)(?:\.|$)/i.test(name));
    if (!licenseFile) continue;
    const logical = `licenses/npm-${runtime.name.replaceAll('@', '').replaceAll('/', '-')}-${runtime.version}.txt`;
    copyFileSync(path.join(packageRoot, licenseFile), path.join(chunkRoot, logical));
    refs.push(logical);
  }
  return refs.sort();
}

function prepareChunkFiles({ chunk, bundlePath, candidateRoot, outputRoot, runtimeLock }) {
  const chunkRoot = path.join(outputRoot, chunk.chunk_id);
  const bundleName = path.basename(bundlePath);
  const coreLicense = `licenses/${chunk.chunk_id}-omni-viewer-core-MIT.txt`;
  const coreNotice = `notices/${chunk.chunk_id}-core-third-party-notices.txt`;
  mkdirSync(path.join(chunkRoot, 'licenses'), { recursive: true });
  mkdirSync(path.join(chunkRoot, 'notices'), { recursive: true });
  copyFileSync(path.join(candidateRoot, 'LICENSE'), path.join(chunkRoot, coreLicense));
  copyFileSync(path.join(candidateRoot, 'THIRD_PARTY_NOTICES.md'), path.join(chunkRoot, coreNotice));
  const runtimePackages = chunk.chunk_id === 'viewer-office' ? productionRuntimePackages(runtimeLock) : [];
  const runtimeLicenses = copyRuntimeLicenses(chunkRoot, runtimePackages);
  const licenseInventory = runtimePackages.length ? `licenses/${chunk.chunk_id}-runtime-license-inventory.json` : undefined;
  if (licenseInventory) {
    writeFileSync(path.join(chunkRoot, licenseInventory), jsonBytes({
      schema_id: 'superwagie.viewer-runtime-license-inventory.v1',
      packages: runtimePackages.map((item) => ({ identity: packageIdentity(item.name, item.version), license: item.license })),
    }));
  }
  const runtimeNotice = runtimePackages.length ? `notices/${chunk.chunk_id}-runtime-dependencies.json` : undefined;
  if (runtimeNotice) {
    writeFileSync(path.join(chunkRoot, runtimeNotice), jsonBytes({
      schema_id: 'superwagie.viewer-runtime-dependencies.v1',
      packages: runtimePackages.map((item) => ({
        identity: packageIdentity(item.name, item.version),
        license: item.license,
        resolved: item.resolved,
        integrity: item.integrity,
      })),
    }));
  }
  const licenseRefs = [coreLicense, ...runtimeLicenses, ...(licenseInventory ? [licenseInventory] : [])].sort();
  const noticeRefs = [coreNotice, ...(runtimeNotice ? [runtimeNotice] : [])].sort();
  const files = [bundleName, ...licenseRefs, ...noticeRefs].sort();
  const fileBytes = files.map((name) => ({ name, bytes: readFileSync(path.join(chunkRoot, name)) }));
  const installedBytes = fileBytes.reduce((sum, item) => sum + item.bytes.length, 0);
  const compressionInput = Buffer.concat(fileBytes.flatMap((item) => [Buffer.from(`${item.name}\0`), item.bytes]));
  const compressedBytes = gzipSync(compressionInput, { level: 9 }).length;
  return { bundleName, files, fileBytes, installedBytes, compressedBytes, licenseRefs, noticeRefs };
}

function writeChunkManifest({ chunk, prepared, outputRoot, sourceLock, buildProvenanceHash }) {
  const fileHashes = prepared.fileBytes.map((item) => ({ logical_name: item.name, sha256: `sha256:${sha256(item.bytes)}` }));
  const manifest = {
    chunk_id: chunk.chunk_id,
    chunk_version: sourceLock.version,
    platform_id: 'macos-15-arm64',
    arch: 'arm64',
    compressed_bytes: prepared.compressedBytes,
    installed_bytes: prepared.installedBytes,
    code: [prepared.bundleName],
    assets: [],
    fonts: [],
    descriptor_ids: chunk.descriptor_ids,
    direct_dependencies: chunk.direct_dependencies ?? [],
    transitive_dependencies: chunk.transitive_dependencies ?? [],
    license_refs: prepared.licenseRefs,
    notice_refs: prepared.noticeRefs,
    source_provenance: {
      identity: `omni-viewer-core@${sourceLock.version}#${sourceLock.commit}`,
      sha256: `sha256:${sourceLock.source_tree_sha256}`,
    },
    build_provenance: {
      identity: 'superwagie-viewer-build-provenance:v1',
      sha256: buildProvenanceHash,
    },
    file_hashes: fileHashes,
    signature: POC_SIGNATURE_SENTINEL,
  };
  const evidence = {
    schema_id: 'superwagie.viewer-chunk-manifest-poc-evidence.v1',
    signature_state: 'poc_unsigned_not_loadable',
    production_loadable: false,
    manifest_candidate: manifest,
  };
  writeFileSync(path.join(outputRoot, chunk.chunk_id, 'chunk-manifest.poc.json'), jsonBytes(evidence));
  return { ...manifest, signature_state: evidence.signature_state, production_loadable: evidence.production_loadable };
}

function sanitizeSbom(raw) {
  const value = structuredClone(raw);
  delete value.serialNumber;
  if (value.metadata) delete value.metadata.timestamp;
  return value;
}

function writeBaseline(artifacts) {
  prepareOwnedRoot(BASELINE_ROOT, 'baseline evidence root');
  for (const [name, bytes] of Object.entries(artifacts)) {
    const target = path.join(BASELINE_ROOT, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const index = createEvidenceIndex(artifacts);
  writeFileSync(path.join(BASELINE_ROOT, 'index.json'), jsonBytes(index));
  verifyEvidenceIndex({ index, artifacts });
  return index;
}

export async function buildCandidate({ candidateRoot, outputRoot, writeBaseline: persistBaseline = true } = {}) {
  const sourceRoot = requireAbsoluteDirectory(candidateRoot, 'candidate root');
  const distRoot = requireAbsoluteDirectory(outputRoot, 'output root', true);
  if (distRoot === sourceRoot || distRoot.startsWith(`${sourceRoot}${path.sep}`)) reject('output root must be outside the pristine candidate source');
  const sourceLockBytes = readFileSync(SOURCE_LOCK_PATH);
  const ledgerBytes = readFileSync(PATCH_LEDGER_PATH);
  const runtimeLockBytes = readFileSync(RUNTIME_LOCK_PATH);
  const sourceLock = JSON.parse(sourceLockBytes.toString('utf8'));
  const runtimeLock = JSON.parse(runtimeLockBytes.toString('utf8'));
  const receipt = verifyAcquiredCandidate({ candidateRoot: sourceRoot, sourceLock, lockBytes: sourceLockBytes });
  const ledger = JSON.parse(ledgerBytes.toString('utf8'));
  const plan = readJson(CHUNK_PLAN_PATH, 'chunk plan');
  verifyLedger(ledger, sourceLock, receipt);
  const chunks = builtChunks(plan);
  const sourcePolicy = auditSourcePolicy({ candidateRoot: sourceRoot });
  if (sourcePolicy.decision !== 'GO') reject(`source policy found ${sourcePolicy.forbidden_runtime_edges} forbidden edges`);

  mkdirSync(AUDIT_ROOT, { recursive: true });
  prepareOwnedRoot(distRoot, 'output root');
  const developerRoot = prepareDeveloperCache(sourceRoot, distRoot);
  const commands = [
    run('npm', ['ci'], developerRoot),
    run('npm', ['run', 'typecheck'], developerRoot),
    run('npm', ['test'], developerRoot),
    run('npm', ['run', 'build'], developerRoot),
  ];
  const npmVersion = run('npm', ['--version'], HERE).stdout.trim();
  if (npmVersion !== NPM_IDENTITY) reject(`npm ${npmVersion} is not admitted npm ${NPM_IDENTITY}`);
  const sbomRun = run('npm', SBOM_ARGS, HERE);
  const rawSbomBytes = Buffer.from(sbomRun.stdout.endsWith('\n') ? sbomRun.stdout : `${sbomRun.stdout}\n`);
  writeFileSync(path.join(AUDIT_ROOT, 'source-sbom.raw.cdx.json'), rawSbomBytes);
  const sanitizedSbom = sanitizeSbom(JSON.parse(sbomRun.stdout));
  const sbomBytes = jsonBytes(sanitizedSbom);
  writeFileSync(path.join(AUDIT_ROOT, 'source-sbom.cdx.json'), sbomBytes);

  const npmAudit = run('npm', ['audit', '--omit=dev', '--json'], HERE, { allowNonzero: true });
  const rawAuditBytes = Buffer.from(npmAudit.stdout.endsWith('\n') ? npmAudit.stdout : `${npmAudit.stdout}\n`);
  writeFileSync(path.join(AUDIT_ROOT, 'npm-audit.raw.json'), rawAuditBytes);
  const rawAudit = JSON.parse(npmAudit.stdout);
  const candidateAudit = run('npm', ['audit', '--omit=dev', '--json'], developerRoot, { allowNonzero: true });
  const candidateAuditBytes = Buffer.from(candidateAudit.stdout.endsWith('\n') ? candidateAudit.stdout : `${candidateAudit.stdout}\n`);
  writeFileSync(path.join(AUDIT_ROOT, 'candidate-npm-audit.raw.json'), candidateAuditBytes);
  const rawCandidateAudit = JSON.parse(candidateAudit.stdout);
  const dependencyPolicy = readJson(DEPENDENCY_POLICY_PATH, 'dependency policy');
  const dependencyResult = auditDependencyData({
    lock: runtimeLock,
    audit: rawAudit,
    policy: dependencyPolicy,
  });
  dependencyResult.package_lock_sha256 = sha256(runtimeLockBytes);
  const candidateDependencyResult = auditDependencyData({
    lock: readJson(path.join(developerRoot, 'package-lock.json'), 'candidate package lock'),
    audit: rawCandidateAudit,
    policy: dependencyPolicy,
  });
  writeFileSync(path.join(AUDIT_ROOT, 'dependencies.json'), jsonBytes(dependencyResult));

  const moduleGraphs = [];
  const preparedChunks = [];
  let buildTool;
  for (const chunk of chunks) {
    const built = await bundleChunk({ chunk, candidateRoot: developerRoot, outputRoot: distRoot });
    buildTool ??= built.buildTool;
    moduleGraphs.push(built.moduleGraph);
    const admittedPackages = new Set([...(chunk.direct_dependencies ?? []), ...(chunk.transitive_dependencies ?? [])]
      .map((identity) => identity.replace(/^npm:/, '').replace(/:[^:]+$/, '')));
    const reachedPackages = new Set(built.moduleGraph.third_party_modules.map((id) => {
      const relative = id.slice('node_modules/'.length);
      return relative.startsWith('@') ? relative.split('/').slice(0, 2).join('/') : relative.split('/')[0];
    }));
    if (built.moduleGraph.external_imports.length) reject(`${chunk.chunk_id} contains unresolved runtime imports`);
    const undeclaredPackages = [...reachedPackages].filter((name) => !admittedPackages.has(name)).sort();
    if (undeclaredPackages.length) {
      reject(`${chunk.chunk_id} reaches undeclared runtime dependencies: ${undeclaredPackages.join(', ')}`);
    }
    preparedChunks.push({
      chunk,
      built,
      prepared: prepareChunkFiles({
        chunk,
        bundlePath: built.bundlePath,
        candidateRoot: developerRoot,
        outputRoot: distRoot,
        runtimeLock,
      }),
    });
  }
  const flatModules = moduleGraphs.flatMap((graph) => graph.modules);
  const builtSourceModules = [...new Set(flatModules.flatMap((id) => {
    if (!id.startsWith('dist/') || !id.endsWith('.js')) return [];
    return [`src/${id.slice('dist/'.length, -'.js'.length)}.ts`];
  }))].sort();
  const builtSourcePolicy = auditSourcePolicy({ candidateRoot: sourceRoot, selectedSources: builtSourceModules });
  writeFileSync(path.join(AUDIT_ROOT, 'source-policy.json'), jsonBytes(sourcePolicy));
  writeFileSync(path.join(AUDIT_ROOT, 'built-source-policy.json'), jsonBytes(builtSourcePolicy));
  const forbiddenNames = ['obsidian', 'electron', 'child_process', 'dompurify', 'mermaid', 'libreoffice', 'soffice'];
  const forbiddenModules = flatModules.filter((id) => forbiddenNames.some((name) => id.toLowerCase().includes(name)));
  const moduleGraphEvidence = {
    schema_id: 'superwagie.viewer-module-graph.v1',
    candidate_commit: sourceLock.commit,
    chunks: moduleGraphs,
    forbidden_modules: forbiddenModules,
    forbidden_runtime_edges: builtSourcePolicy.forbidden_runtime_edges + forbiddenModules.length,
    forbidden_source_findings: builtSourcePolicy.violations,
    audited_source_modules: builtSourceModules,
    excluded_host_closure: {
      audited_commit: '1db3137806dc4047513f6abd2ec010030e5029a2',
      reason: 'host_not_imported',
      packages: [
        { package: 'dompurify', reachable: flatModules.some((id) => id.toLowerCase().includes('dompurify')) },
        { package: 'mermaid', reachable: flatModules.some((id) => id.toLowerCase().includes('mermaid')) },
      ],
    },
  };
  const moduleGraphBytes = jsonBytes(moduleGraphEvidence);
  writeFileSync(path.join(AUDIT_ROOT, 'module-graph.json'), moduleGraphBytes);

  const smoke = await runOfficeClosureSmoke({
    bundlePath: path.join(distRoot, 'viewer-office', 'viewer-office.mjs'),
  });
  const smokeBytes = jsonBytes(smoke);
  writeFileSync(path.join(AUDIT_ROOT, 'office-smoke.json'), smokeBytes);

  const toolchain = {
    node: process.version.slice(1),
    npm: npmVersion,
    git: run('git', ['--version'], sourceRoot).stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    bundler: buildTool,
    sbom_command: `npm ${SBOM_ARGS.join(' ')}`,
  };
  const outputs = Object.fromEntries(preparedChunks.flatMap(({ chunk, prepared }) => prepared.fileBytes.map((file) => [
    `${chunk.chunk_id}/${file.name}`,
    file.bytes,
  ])));
  const provenanceInputs = {
    'source-lock.json': sourceLockBytes,
    'patch-ledger.json': ledgerBytes,
    'package-lock.json': runtimeLockBytes,
    'source-sbom.cdx.json': sbomBytes,
    'npm-audit.raw.json': rawAuditBytes,
    'module-graph.json': moduleGraphBytes,
    'office-smoke.json': smokeBytes,
  };
  const buildProvenance = createBuildProvenance({
    sourceIdentity: { commit: sourceLock.commit, archive_sha256: sourceLock.source_tree_sha256 },
    toolchain,
    inputs: provenanceInputs,
    outputs,
  });
  verifyBuildProvenance({
    provenance: buildProvenance,
    sourceIdentity: buildProvenance.source_identity,
    toolchain,
    inputs: provenanceInputs,
    outputs,
  });
  const buildProvenanceBytes = provenanceBytes(buildProvenance);
  const buildProvenanceHash = evidenceSha256(buildProvenanceBytes);
  writeFileSync(path.join(AUDIT_ROOT, 'build-provenance.json'), buildProvenanceBytes);

  rmSync(developerRoot, { recursive: true, force: true });
  const manifests = preparedChunks.map(({ chunk, prepared }) => writeChunkManifest({
    chunk,
    prepared,
    outputRoot: distRoot,
    sourceLock,
    buildProvenanceHash,
  }));
  const chunkResult = auditChunkData({ distRoot });
  writeFileSync(path.join(AUDIT_ROOT, 'chunks.json'), jsonBytes(chunkResult));
  const hostExcluded = moduleGraphEvidence.excluded_host_closure.packages.every((item) => !item.reachable);
  const decision = sourcePolicy.decision === 'GO'
    && builtSourcePolicy.decision === 'GO'
    && dependencyResult.decision === 'GO'
    && candidateDependencyResult.decision === 'GO'
    && dependencyResult.moderate_or_higher === 0
    && candidateDependencyResult.moderate_or_higher === 0
    && forbiddenModules.length === 0
    && hostExcluded
    && smoke.placeholder_content === false
    && chunkResult.decision === 'GO'
    ? 'GO'
    : 'NO_GO';
  const admissionDecision = {
    schema_id: 'superwagie.viewer-candidate-admission-decision.v1',
    decision,
    candidate_commit: sourceLock.commit,
    patches: ledger.patches.length,
    forbidden_runtime_edges: moduleGraphEvidence.forbidden_runtime_edges,
    moderate_or_higher: dependencyResult.moderate_or_higher,
    office_smoke_non_placeholder: smoke.placeholder_content === false,
    chunks: chunkResult.decision,
  };
  const baselineArtifacts = {
    'README.md': Buffer.from(BASELINE_README, 'utf8'),
    'admission-decision.json': jsonBytes(admissionDecision),
    'build-provenance.json': buildProvenanceBytes,
    'built-source-policy.json': jsonBytes(builtSourcePolicy),
    'candidate-npm-audit.raw.json': candidateAuditBytes,
    'chunks.json': jsonBytes(chunkResult),
    'dependencies.json': jsonBytes(dependencyResult),
    'module-graph.json': moduleGraphBytes,
    'npm-audit.raw.json': rawAuditBytes,
    'office-smoke.json': smokeBytes,
    'source-policy.json': jsonBytes(sourcePolicy),
    'source-sbom.cdx.json': sbomBytes,
    ...Object.fromEntries(chunks.map((chunk) => [
      `manifests/${chunk.chunk_id}.chunk-manifest.poc.json`,
      readFileSync(path.join(distRoot, chunk.chunk_id, 'chunk-manifest.poc.json')),
    ])),
  };
  const baselineIndex = persistBaseline ? writeBaseline(baselineArtifacts) : createEvidenceIndex(baselineArtifacts);
  verifyEvidenceIndex({ index: baselineIndex, artifacts: baselineArtifacts });

  writeFileSync(path.join(AUDIT_ROOT, 'upstream-build.json'), jsonBytes({
    schema_id: 'superwagie.viewer-upstream-build.v1',
    candidate_commit: sourceLock.commit,
    commands,
  }));
  rmSync(developerRoot, { recursive: true, force: true });
  verifyAcquiredCandidate({ candidateRoot: sourceRoot, sourceLock, lockBytes: sourceLockBytes });
  return {
    schema_id: 'superwagie.viewer-candidate-build.v1',
    decision,
    candidate_commit: sourceLock.commit,
    patches: ledger.patches.length,
    upstream_commands: commands.map((item) => ({ command: item.command, exit_code: item.exit_code, elapsed_millis: item.elapsed_millis })),
    module_graph: moduleGraphEvidence,
    office_smoke: smoke,
    manifests: manifests.map((manifest) => ({
      chunk_id: manifest.chunk_id,
      compressed_bytes: manifest.compressed_bytes,
      installed_bytes: manifest.installed_bytes,
      signature_state: manifest.signature_state,
      production_loadable: manifest.production_loadable,
    })),
    future_chunks: plan.chunks.filter((chunk) => chunk.status === 'planned_not_built').map((chunk) => chunk.chunk_id),
    sbom: { command: `npm ${SBOM_ARGS.join(' ')}`, bom_format: sanitizedSbom.bomFormat, component_count: sanitizedSbom.components?.length ?? 0 },
    npm_audit: { moderate_or_higher: dependencyResult.moderate_or_higher },
    build_provenance_sha256: buildProvenanceHash,
    baseline_artifact_count: baselineIndex.artifacts.length,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || !['--candidate-root', '--output-root'].includes(name)) input(`${name ?? '<argument>'} is unsupported or missing a value`);
    if (name === '--candidate-root') options.candidateRoot = value;
    else options.outputRoot = value;
  }
  if (!options.candidateRoot || !options.outputRoot) input('--candidate-root and --output-root are required');
  return options;
}

async function main() {
  const result = await buildCandidate(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision !== 'GO') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof InputError ? 2 : 1;
  }
}
