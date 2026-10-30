import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitBashExecutable } from '../../../scripts/lib/git-bash-executable.mjs';
import { applyWindowsKnowledgePatch, knowledgeBuildEnv, matchesWindowsKnowledgePatch } from './embedded-knowledge-windows.mjs';
import { applyMemoryIndexOverlay, matchesMemoryIndexOverlay } from './embedded-knowledge-memory/apply.mjs';

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
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'embedded-knowledge');
const cacheRoot = path.join(electronRoot, '.cache', 'embedded-knowledge');
const sourceDir = path.join(cacheRoot, 'src');
const buildDir = path.join(cacheRoot, 'build');

const REPO = process.env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_REPO || 'https://github.com/NeoMei/embedded-knowledge';
// Fetch by branch (a short sha is not a fetchable ref), then verify the commit.
// The pinned commit keeps a moved branch from silently changing the backend.
const REF = process.env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_REF || 'embedded-knowledge';
const PINNED_COMMIT = process.env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT ?? 'f5adb9e';
const TAGS = process.env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_TAGS || 'sqlite_fts5,anydoc';
const BINARY_NAME = process.platform === 'win32' ? 'embedded-knowledge-server.exe' : 'embedded-knowledge-server';
const FORCE = process.argv.includes('--force');

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

const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
};

const checkoutSource = () => {
  fs.mkdirSync(sourceDir, { recursive: true });
  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    run('git', ['init', '--quiet'], { cwd: sourceDir, env: gitEnv });
  }
  spawnSync('git', ['remote', 'remove', 'origin'], { cwd: sourceDir, env: gitEnv, stdio: 'ignore' });
  run('git', ['remote', 'add', 'origin', REPO], { cwd: sourceDir, env: gitEnv });

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' });
  const headCommit = head.status === 0 ? head.stdout.trim() : '';
  const matchesPin = PINNED_COMMIT ? headCommit.startsWith(PINNED_COMMIT) : Boolean(headCommit);
  if (matchesPin) return headCommit;

  const changes = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: sourceDir, env: gitEnv }).stdout.trim();
  if (changes) throw new Error('Embedded knowledge source has local changes; refusing to replace its checkout');

  console.log(`[embedded-knowledge] fetching ${REPO} @ ${REF}`);
  run('git', ['fetch', '--depth', '1', 'origin', REF], { cwd: sourceDir, env: gitEnv });

  const commit = run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: sourceDir, encoding: 'utf8' }).stdout.trim();
  if (PINNED_COMMIT && !commit.startsWith(PINNED_COMMIT)) {
    throw new Error(
      `${REF} moved to ${commit}, expected ${PINNED_COMMIT}. Review the change, then set OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT to the new commit.`,
    );
  }
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: sourceDir, env: gitEnv });
  return commit;
};

const build = (commit) => {
  const toolchain = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (toolchain.status !== 0) {
    throw new Error('A Go toolchain with cgo is required to build the bundled knowledge backend');
  }

  const target = path.join(buildDir, BINARY_NAME);
  fs.mkdirSync(buildDir, { recursive: true });

  const env = knowledgeBuildEnv();

  // The anydoc engine is a Rust static archive linked by a build tag. Without
  // it PDF/Office documents cannot be parsed at all in the lite binary: the
  // only other engine, docreader, is an external service this app never runs.
  if (TAGS.split(',').map((tag) => tag.trim()).includes('anydoc')) {
    console.log('[embedded-knowledge] building the anydoc static library (cargo)');
    run(resolveGitBashExecutable(), ['scripts/build-anydoc-lib.sh'], { cwd: sourceDir, env });
  }

  console.log(`[embedded-knowledge] building ${commit} (tags: ${TAGS})`);
  run('go', ['build', '-tags', TAGS, '-o', target, './cmd/server'], { cwd: sourceDir, env });

  const stat = fs.statSync(target);
  if (stat.size < 10 * 1024 * 1024) {
    throw new Error(`Built binary looks wrong (${stat.size} bytes): ${target}`);
  }
  return target;
};

const stage = ({ commit, binaryPath, windowsPatch, memoryIndexOverlay }) => {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(outputDir)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }

  fs.copyFileSync(binaryPath, path.join(outputDir, BINARY_NAME));
  if (process.platform !== 'win32') fs.chmodSync(path.join(outputDir, BINARY_NAME), 0o755);

  fs.cpSync(path.join(sourceDir, 'config'), path.join(outputDir, 'config'), { recursive: true });
  fs.cpSync(path.join(sourceDir, 'migrations', 'sqlite'), path.join(outputDir, 'migrations', 'sqlite'), {
    recursive: true,
  });

  for (const extra of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'REFERENCE_INGEST.md']) {
    const source = path.join(sourceDir, extra);
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
  manifest.memoryIndexOverlay = memoryIndexOverlay;
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

export function canReuseStagedKnowledge({ manifest, directory, binaryName, repository, ref, pinnedCommit, tags, platform = process.platform }) {
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

const main = () => {
  const existing = readManifest();
  const stagedBinary = path.join(outputDir, BINARY_NAME);
  if (!FORCE && canReuseStagedKnowledge({ manifest: existing, directory: outputDir, binaryName: BINARY_NAME,
    repository: REPO, ref: REF, pinnedCommit: PINNED_COMMIT, tags: TAGS })) {
    console.log(`[embedded-knowledge] already staged: ${stagedBinary} (${existing.commit})`);
    return;
  }

  const commit = checkoutSource();
  const windowsPatch = applyWindowsKnowledgePatch(sourceDir, commit);
  const memoryIndexOverlay = applyMemoryIndexOverlay(sourceDir);
  const binaryPath = build(commit);
  const manifest = stage({ commit, binaryPath, windowsPatch, memoryIndexOverlay });
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
