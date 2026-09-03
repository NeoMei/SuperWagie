import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { verifyAcquiredCandidate } from './acquire-frozen-core.mjs';
import { auditDependencyData } from './dependency-audit.mjs';
import { writeProvenance } from './provenance.mjs';
import { auditSourcePolicy } from './source-policy-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_LOCK_PATH = path.join(HERE, 'source-lock.json');
const PATCH_LEDGER_PATH = path.join(HERE, 'patch-ledger.json');
const CHUNK_PLAN_PATH = path.join(HERE, 'chunk-plan.json');
const SOURCE_POLICY_PATH = path.join(HERE, 'fixtures', 'source-policy-forbidden.json');
const DEPENDENCY_POLICY_PATH = path.join(HERE, 'fixtures', 'dependency-policy.json');
const AUDIT_ROOT = path.join(HERE, 'audit');
const SBOM_ARGS = ['sbom', '--package-lock-only', '--omit=dev', '--omit=optional', '--sbom-format', 'cyclonedx'];
const NPM_IDENTITY = '11.16.0';
const POC_SIGNATURE_SENTINEL = 'poc_unsigned_not_loadable_reserved_sentinel_000';

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

function run(command, args, cwd) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: process.env,
  });
  if (result.error?.code === 'ENOENT') input(`required tool ${command} is missing`);
  const record = {
    command: [command, ...args].join(' '),
    exit_code: result.status ?? 2,
    elapsed_millis: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (record.exit_code !== 0) reject(`${record.command} failed with exit ${record.exit_code}`);
  return record;
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
  return chunk.entry_exports.map((entry) => {
    if (!Array.isArray(entry.exports) || entry.exports.length === 0) input(`${chunk.chunk_id} has an empty export selection`);
    const compiled = path.join(candidateRoot, 'dist', entry.source.replace(/^src\//, '').replace(/\.ts$/, '.js'));
    return `export { ${entry.exports.join(', ')} } from ${JSON.stringify(compiled)};`;
  }).join('\n');
}

function normalizeModuleId(id, candidateRoot, entryPath) {
  if (id === entryPath) return '<generated-entry>';
  const relative = path.relative(candidateRoot, id).split(path.sep).join('/');
  return relative.startsWith('../') ? `<outside-candidate>/${path.basename(id)}` : relative;
}

async function bundleChunk({ chunk, candidateRoot, outputRoot }) {
  const chunkRoot = path.join(outputRoot, chunk.chunk_id);
  mkdirSync(chunkRoot, { recursive: true });
  const entryPath = path.join(outputRoot, `.entry-${chunk.chunk_id}.mjs`);
  writeFileSync(entryPath, `${generatedEntry(chunk, candidateRoot)}\n`);
  const rolldownUrl = pathToFileURL(path.join(candidateRoot, 'node_modules', 'rolldown', 'dist', 'index.mjs')).href;
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

function writeChunkEvidence({ chunk, bundlePath, moduleGraph, buildTool, candidateRoot, outputRoot, sourceLock, provenance }) {
  const chunkRoot = path.join(outputRoot, chunk.chunk_id);
  const bundleName = path.basename(bundlePath);
  const licenseName = `licenses/${chunk.chunk_id}-omni-viewer-core-MIT.txt`;
  const noticeName = `notices/${chunk.chunk_id}-third-party-notices.txt`;
  mkdirSync(path.join(chunkRoot, 'licenses'), { recursive: true });
  mkdirSync(path.join(chunkRoot, 'notices'), { recursive: true });
  copyFileSync(path.join(candidateRoot, 'LICENSE'), path.join(chunkRoot, licenseName));
  copyFileSync(path.join(candidateRoot, 'THIRD_PARTY_NOTICES.md'), path.join(chunkRoot, noticeName));
  const files = [bundleName, licenseName, noticeName].sort();
  const fileBytes = files.map((name) => ({ name, bytes: readFileSync(path.join(chunkRoot, name)) }));
  const installedBytes = fileBytes.reduce((sum, item) => sum + item.bytes.length, 0);
  const compressionInput = Buffer.concat(fileBytes.flatMap((item) => [Buffer.from(`${item.name}\0`), item.bytes]));
  const compressedBytes = gzipSync(compressionInput, { level: 9 }).length;
  const fileHashes = fileBytes.map((item) => ({ logical_name: item.name, sha256: `sha256:${sha256(item.bytes)}` }));
  const manifest = {
    chunk_id: chunk.chunk_id,
    chunk_version: sourceLock.version,
    platform_id: 'macos-15-arm64',
    arch: 'arm64',
    compressed_bytes: compressedBytes,
    installed_bytes: installedBytes,
    code: [bundleName],
    assets: [],
    fonts: [],
    descriptor_ids: chunk.descriptor_ids,
    direct_dependencies: [],
    transitive_dependencies: [],
    license_refs: [licenseName],
    notice_refs: [noticeName],
    source_provenance: {
      identity: `omni-viewer-core@${sourceLock.version}#${sourceLock.commit}`,
      sha256: `sha256:${sourceLock.source_tree_sha256}`,
    },
    build_provenance: {
      identity: `node@${process.version.slice(1)}+npm@${provenance.toolchain.npm}+${buildTool}`,
      sha256: `sha256:${sha256(readFileSync(bundlePath))}`,
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
  writeFileSync(path.join(chunkRoot, 'chunk-manifest.poc.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return { ...manifest, signature_state: evidence.signature_state, production_loadable: evidence.production_loadable };
}

export async function buildCandidate({ candidateRoot, outputRoot } = {}) {
  const sourceRoot = requireAbsoluteDirectory(candidateRoot, 'candidate root');
  const distRoot = requireAbsoluteDirectory(outputRoot, 'output root', true);
  if (distRoot === sourceRoot || distRoot.startsWith(`${sourceRoot}${path.sep}`)) reject('output root must be outside the pristine candidate source');
  const sourceLockBytes = readFileSync(SOURCE_LOCK_PATH);
  const sourceLock = JSON.parse(sourceLockBytes.toString('utf8'));
  const receipt = verifyAcquiredCandidate({ candidateRoot: sourceRoot, sourceLock, lockBytes: sourceLockBytes });
  const ledger = readJson(PATCH_LEDGER_PATH, 'patch ledger');
  const plan = readJson(CHUNK_PLAN_PATH, 'chunk plan');
  verifyLedger(ledger, sourceLock, receipt);
  const chunks = builtChunks(plan);
  const sourcePolicy = auditSourcePolicy({ candidateRoot: sourceRoot });
  if (sourcePolicy.decision !== 'GO') reject(`source policy found ${sourcePolicy.forbidden_runtime_edges} forbidden edges`);

  mkdirSync(AUDIT_ROOT, { recursive: true });
  rmSync(distRoot, { recursive: true, force: true });
  mkdirSync(distRoot, { recursive: true });
  const developerRoot = prepareDeveloperCache(sourceRoot, distRoot);
  const commands = [
    run('npm', ['ci'], developerRoot),
    run('npm', ['run', 'typecheck'], developerRoot),
    run('npm', ['test'], developerRoot),
    run('npm', ['run', 'build'], developerRoot),
  ];
  const provenance = writeProvenance({
    candidateRoot: sourceRoot,
    outputPath: path.join(AUDIT_ROOT, 'source-provenance.json'),
    sourceLock,
    lockBytes: sourceLockBytes,
  });
  if (provenance.toolchain.npm !== NPM_IDENTITY) reject(`provenance npm ${provenance.toolchain.npm} is not admitted npm ${NPM_IDENTITY}`);
  if (provenance.toolchain.npm_sbom_command !== `npm ${SBOM_ARGS.join(' ')}`) reject('provenance SBOM command differs from the admitted command');

  const sbom = run('npm', SBOM_ARGS, developerRoot);
  JSON.parse(sbom.stdout);
  writeFileSync(path.join(AUDIT_ROOT, 'source-sbom.cdx.json'), sbom.stdout.endsWith('\n') ? sbom.stdout : `${sbom.stdout}\n`);
  const npmAudit = run('npm', ['audit', '--omit=dev', '--json'], developerRoot);
  const rawAudit = JSON.parse(npmAudit.stdout);
  writeFileSync(path.join(AUDIT_ROOT, 'npm-audit.raw.json'), npmAudit.stdout.endsWith('\n') ? npmAudit.stdout : `${npmAudit.stdout}\n`);
  const dependencyPolicy = readJson(DEPENDENCY_POLICY_PATH, 'dependency policy');
  const dependencyResult = auditDependencyData({
    lock: readJson(path.join(developerRoot, 'package-lock.json'), 'candidate package lock'),
    audit: rawAudit,
    policy: dependencyPolicy,
  });
  if (dependencyResult.decision !== 'GO' || dependencyResult.moderate_or_higher !== 0) reject('production dependency audit did not pass');

  const moduleGraphs = [];
  const manifests = [];
  for (const chunk of chunks) {
    const built = await bundleChunk({ chunk, candidateRoot: developerRoot, outputRoot: distRoot });
    moduleGraphs.push(built.moduleGraph);
    if (built.moduleGraph.external_imports.length || built.moduleGraph.third_party_modules.length) {
      reject(`${chunk.chunk_id} contains non-Core runtime dependencies`);
    }
    manifests.push(writeChunkEvidence({
      chunk,
      ...built,
      candidateRoot: developerRoot,
      outputRoot: distRoot,
      sourceLock,
      provenance,
    }));
  }
  const flatModules = moduleGraphs.flatMap((graph) => graph.modules);
  const builtSourceModules = [...new Set(flatModules.flatMap((id) => {
    if (!id.startsWith('dist/') || !id.endsWith('.js')) return [];
    return [`src/${id.slice('dist/'.length, -'.js'.length)}.ts`];
  }))].sort();
  const builtSourcePolicy = auditSourcePolicy({ candidateRoot: sourceRoot, selectedSources: builtSourceModules });
  if (builtSourcePolicy.decision !== 'GO') {
    reject(`built source closure contains ${builtSourcePolicy.forbidden_runtime_edges} forbidden runtime edges`);
  }
  writeFileSync(path.join(AUDIT_ROOT, 'built-source-policy.json'), `${JSON.stringify(builtSourcePolicy, null, 2)}\n`);
  const forbiddenNames = ['obsidian', 'electron', 'child_process', 'dompurify', 'mermaid', 'libreoffice', 'soffice'];
  const forbiddenModules = flatModules.filter((id) => forbiddenNames.some((name) => id.toLowerCase().includes(name)));
  const moduleGraphEvidence = {
    schema_id: 'superwagie.viewer-module-graph.v1',
    candidate_commit: sourceLock.commit,
    chunks: moduleGraphs,
    forbidden_modules: forbiddenModules,
    forbidden_runtime_edges: forbiddenModules.length,
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
  if (forbiddenModules.length || moduleGraphEvidence.excluded_host_closure.packages.some((item) => item.reachable)) {
    reject('built module graph reaches a forbidden host or vulnerable excluded package');
  }
  writeFileSync(path.join(AUDIT_ROOT, 'module-graph.json'), `${JSON.stringify(moduleGraphEvidence, null, 2)}\n`);
  writeFileSync(path.join(AUDIT_ROOT, 'upstream-build.json'), `${JSON.stringify({
    schema_id: 'superwagie.viewer-upstream-build.v1',
    candidate_commit: sourceLock.commit,
    commands,
  }, null, 2)}\n`);
  rmSync(developerRoot, { recursive: true, force: true });
  verifyAcquiredCandidate({ candidateRoot: sourceRoot, sourceLock, lockBytes: sourceLockBytes });
  return {
    schema_id: 'superwagie.viewer-candidate-build.v1',
    decision: 'GO',
    candidate_commit: sourceLock.commit,
    patches: ledger.patches.length,
    upstream_commands: commands.map((item) => ({ command: item.command, exit_code: item.exit_code, elapsed_millis: item.elapsed_millis })),
    module_graph: moduleGraphEvidence,
    manifests: manifests.map((manifest) => ({
      chunk_id: manifest.chunk_id,
      compressed_bytes: manifest.compressed_bytes,
      installed_bytes: manifest.installed_bytes,
      signature_state: manifest.signature_state,
      production_loadable: manifest.production_loadable,
    })),
    future_chunks: plan.chunks.filter((chunk) => chunk.status === 'planned_not_built').map((chunk) => chunk.chunk_id),
    sbom: { command: `npm ${SBOM_ARGS.join(' ')}`, bom_format: 'CycloneDX' },
    npm_audit: { moderate_or_higher: dependencyResult.moderate_or_higher },
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof InputError ? 2 : 1;
  }
}
