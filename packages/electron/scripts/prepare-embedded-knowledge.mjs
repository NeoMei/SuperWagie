import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitBashExecutable } from '../../../scripts/lib/git-bash-executable.mjs';
import { applyWindowsKnowledgePatch, knowledgeBuildEnvForTarget, matchesWindowsKnowledgePatch } from './embedded-knowledge-windows.mjs';
import { resolveTargetArchitecture } from './target-architecture.mjs';
import { createRequire } from 'node:module';
import { assertCleanKnowledgeSource, assertNoKnowledgeSymlinks, assertSafeKnowledgeStaging, hasLocalKnowledgeGitDirectory } from './embedded-knowledge-source.mjs';
import { knowledgeGitEnv } from './embedded-knowledge-git-env.mjs';
import { anyDocSourceIdentity, prepareVerifiedAnyDocSource, verifyAnyDocSource } from './embedded-knowledge-anydoc.mjs';
import integrityPolicy from './embedded-knowledge-policy.cjs';

const { verifyEmbeddedKnowledge } = createRequire(import.meta.url)('./embedded-knowledge-package.cjs');
const { knowledgeSourcePin } = createRequire(import.meta.url)('./embedded-knowledge-pin.cjs');
const { matchesAnyDocSourcePolicy } = integrityPolicy;
import { applyMemoryIndexOverlay, matchesMemoryIndexOverlay } from './embedded-knowledge-memory/apply.mjs';
import { stageJiebaDictionary, matchesJiebaDictionary } from './embedded-knowledge-jieba.mjs';

/**
 * Stages the bundled knowledge backend: SuperWagie's fork of the upstream project (upstream
 * v0.8.3 plus the reference-ingest patch) built as the Lite server.
 *
 * The source is the public fork, not a developer checkout:
 * https://github.com/NeoMei/embedded-knowledge, pinned by commit. The staged directory
 * holds the binary, its `config/` and `migrations/sqlite/`, the licences and the
 * patch description. The server spawns the binary with that directory as its
 * working directory, so `config/` and `migrations/` resolve next to it.
 *
 * Requires a Go toolchain with cgo (the SQLite driver is not pure Go).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = fs.realpathSync(path.resolve(__dirname, '..'));
const outputDir = path.join(electronRoot, 'resources', 'embedded-knowledge');
const cacheRoot = path.join(electronRoot, '.cache', 'embedded-knowledge');
const sourceDir = path.join(cacheRoot, 'src');
const buildDir = path.join(cacheRoot, 'build');

// Fetch by ref and compare its full commit; a moved ref never silently changes
// the backend. Overrides are explicit and shared with the afterPack check.
const { repository: REPO, ref: REF, commit: PINNED_COMMIT } = knowledgeSourcePin();
const TAGS = process.env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_TAGS || 'sqlite_fts5,anydoc';
const usesAnyDoc = TAGS.split(',').map((tag) => tag.trim()).includes('anydoc');
const BINARY_NAME = process.platform === 'win32' ? 'embedded-knowledge-server.exe' : 'embedded-knowledge-server';
const FORCE = process.argv.includes('--force');
const targetArchitecture = resolveTargetArchitecture().node;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    const stdout = result.stdout ? `\n${result.stdout.trim()}` : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr}${stdout}`);
  }
  return result;
};

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const readManifest = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
};

const gitEnv = knowledgeGitEnv();

const checkoutSource = () => {
  assertNoKnowledgeSymlinks(sourceDir, electronRoot);
  fs.mkdirSync(sourceDir, { recursive: true });
  if (!hasLocalKnowledgeGitDirectory(sourceDir)) {
    if (fs.readdirSync(sourceDir).length) throw new Error('Embedded knowledge source directory is not an empty checkout; preserve it and review before building');
    run('git', ['init', '--quiet'], { cwd: sourceDir, env: gitEnv });
  }
  hasLocalKnowledgeGitDirectory(sourceDir);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8', env: gitEnv });
  const headCommit = head.status === 0 ? head.stdout.trim() : '';
  const matchesPin = headCommit === PINNED_COMMIT;
  assertCleanKnowledgeSource(sourceDir, matchesPin ? process.platform : null);
  if (matchesPin) return headCommit;

  spawnSync('git', ['remote', 'remove', 'origin'], { cwd: sourceDir, env: gitEnv, stdio: 'ignore' });
  run('git', ['remote', 'add', 'origin', REPO], { cwd: sourceDir, env: gitEnv });

  console.log(`[embedded-knowledge] fetching ${REPO} @ ${REF}`);
  run('git', ['fetch', '--depth', '1', 'origin', REF], { cwd: sourceDir, env: gitEnv });

  const commit = run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: sourceDir, encoding: 'utf8', env: gitEnv }).stdout.trim();
  if (commit !== PINNED_COMMIT) {
    throw new Error(
      `${REF} moved to ${commit}, expected ${PINNED_COMMIT}. Review the change, then set OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT to the new commit.`,
    );
  }
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: sourceDir, env: gitEnv });
  assertCleanKnowledgeSource(sourceDir, process.platform);
  return commit;
};

export function prepareMemoryIndexBuildSource({ sourceDirectory, buildRoot, commit }) {
  assertNoKnowledgeSymlinks(sourceDirectory, path.dirname(sourceDirectory));
  assertNoKnowledgeSymlinks(buildRoot, path.dirname(buildRoot));
  assertCleanKnowledgeSource(sourceDirectory, null);
  fs.mkdirSync(buildRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(buildRoot, 'memory-source-'));
  run('git', ['clone', '--no-hardlinks', '--no-checkout', sourceDirectory, directory], { env: gitEnv });
  run('git', ['checkout', '--detach', commit], { cwd: directory, env: gitEnv });
  assertCleanKnowledgeSource(directory, null);
  return directory;
}

const build = (commit, workingSource) => {
  const toolchain = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (toolchain.status !== 0) {
    throw new Error('A Go toolchain with cgo is required to build the bundled knowledge backend');
  }

  const target = path.join(buildDir, BINARY_NAME);
  assertNoKnowledgeSymlinks(buildDir, electronRoot);
  fs.mkdirSync(buildDir, { recursive: true });

  const env = knowledgeBuildEnvForTarget(process.platform, process.env, targetArchitecture);

  // The anydoc engine is a Rust static archive linked by a build tag. Without
  // it PDF/Office documents cannot be parsed at all in the lite binary: the
  // only other engine, docreader, is an external service this app never runs.
  let anydocSource;
  if (usesAnyDoc) {
    anydocSource = prepareVerifiedAnyDocSource(workingSource);
    console.log('[embedded-knowledge] building the anydoc static library (cargo)');
    try {
      run(resolveGitBashExecutable(), ['scripts/build-anydoc-lib.sh'], { cwd: workingSource, env });
    } finally {
      verifyAnyDocSource(workingSource);
    }
  }

  console.log(`[embedded-knowledge] building ${commit} (tags: ${TAGS})`);
  try {
    run('go', ['build', '-tags', TAGS, '-o', target, './cmd/server'], { cwd: workingSource, env });
  } finally {
    if (usesAnyDoc) verifyAnyDocSource(workingSource);
  }

  const stat = fs.statSync(target);
  if (stat.size < 10 * 1024 * 1024) {
    throw new Error(`Built binary looks wrong (${stat.size} bytes): ${target}`);
  }
  return { binaryPath: target, anydocSource };
};

const writeManifest = (manifest) => {
  const file = path.join(outputDir, 'manifest.json');
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
};

const stage = ({ commit, binaryPath, windowsPatch, anydocSource, memoryIndexOverlay, workingSource }) => {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(outputDir)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }

  fs.copyFileSync(binaryPath, path.join(outputDir, BINARY_NAME));
  if (process.platform !== 'win32') fs.chmodSync(path.join(outputDir, BINARY_NAME), 0o755);

  fs.cpSync(path.join(workingSource, 'config'), path.join(outputDir, 'config'), { recursive: true });
  fs.cpSync(path.join(workingSource, 'migrations', 'sqlite'), path.join(outputDir, 'migrations', 'sqlite'), {
    recursive: true,
  });

  for (const extra of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'REFERENCE_INGEST.md']) {
    const source = path.join(workingSource, extra);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outputDir, extra));
  }

  const manifest = {
    repository: REPO,
    ref: REF,
    commit,
    tags: TAGS,
    binary: BINARY_NAME,
    binarySha256: sha256(path.join(outputDir, BINARY_NAME)),
    stagedAt: new Date().toISOString(),
  };
  if (windowsPatch) manifest.windowsPatch = windowsPatch;
  if (anydocSource) manifest.anydocSource = anydocSource;
  manifest.memoryIndexOverlay = memoryIndexOverlay;
  manifest.jiebaDictionary = stageJiebaDictionary(workingSource, outputDir);
  writeManifest(manifest);
  return manifest;
};

export function canReuseStagedKnowledgeBinary({ manifest, directory, binaryName, repository, ref, pinnedCommit, tags, platform = process.platform }) {
  const stagedBinary = path.join(directory, binaryName);
  return manifest?.repository === repository &&
    manifest?.ref === ref &&
    (pinnedCommit ? manifest?.commit?.startsWith(pinnedCommit) : Boolean(manifest?.commit)) &&
    manifest?.tags === tags &&
    matchesWindowsKnowledgePatch(manifest, platform) &&
    matchesMemoryIndexOverlay(manifest) &&
    fs.existsSync(stagedBinary) &&
    manifest.binarySha256 === sha256(stagedBinary) &&
    fs.existsSync(path.join(directory, 'config')) &&
    fs.existsSync(path.join(directory, 'migrations', 'sqlite'));
}

export function canReuseStagedKnowledge(options) {
  return canReuseStagedKnowledgeBinary(options) && matchesJiebaDictionary(options.manifest, options.directory);
}

const main = () => {
  assertNoKnowledgeSymlinks(outputDir, electronRoot);
  const existing = readManifest();
  if (usesAnyDoc) anyDocSourceIdentity();
  const stagedBinary = path.join(outputDir, BINARY_NAME);
  if (
    !FORCE &&
    existing?.repository === REPO &&
    existing?.ref === REF &&
    existing?.commit === PINNED_COMMIT &&
    existing?.tags === TAGS &&
    matchesMemoryIndexOverlay(existing) &&
    (!usesAnyDoc || matchesAnyDocSourcePolicy(existing?.anydocSource)) &&
    matchesWindowsKnowledgePatch(existing) &&
    fs.existsSync(stagedBinary) &&
    fs.existsSync(path.join(outputDir, 'config')) &&
    fs.existsSync(path.join(outputDir, 'migrations', 'sqlite'))
  ) {
    try { verifyEmbeddedKnowledge(path.dirname(outputDir), process.platform, targetArchitecture); }
    catch (error) { throw new Error(`Existing embedded-knowledge staging is invalid for ${process.platform}/${targetArchitecture}; preserve it and rerun with --force after review: ${error.message}`); }
    if (!matchesJiebaDictionary(existing, outputDir)) {
      // The verified executable already supports JIEBA_DICT_DIR. Upgrade only
      // its data resources after preserving the source and binary safeguards.
      checkoutSource();
      const manifest = { ...existing, jiebaDictionary: stageJiebaDictionary(sourceDir, outputDir), stagedAt: new Date().toISOString() };
      writeManifest(manifest);
      console.log(`[embedded-knowledge] upgraded portable Jieba resources: ${stagedBinary}`);
      return;
    }
    console.log(`[embedded-knowledge] already staged: ${stagedBinary} (${existing.commit})`);
    return;
  }

  assertSafeKnowledgeStaging(outputDir, electronRoot);
  const commit = checkoutSource();
  const workingSource = prepareMemoryIndexBuildSource({ sourceDirectory: sourceDir, buildRoot: cacheRoot, commit });
  const windowsPatch = applyWindowsKnowledgePatch(workingSource, commit);
  const memoryIndexOverlay = applyMemoryIndexOverlay(workingSource);
  const { binaryPath, anydocSource } = build(commit, workingSource);
  const manifest = stage({ commit, binaryPath, windowsPatch, anydocSource, memoryIndexOverlay, workingSource });
  verifyEmbeddedKnowledge(path.dirname(outputDir), process.platform, targetArchitecture);
  console.log(`[embedded-knowledge] staged ${manifest.commit} -> ${path.join(outputDir, BINARY_NAME)}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
