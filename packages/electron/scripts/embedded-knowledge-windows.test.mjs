import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import knowledgePins from './embedded-knowledge-pin.cjs';
import { resolveGitBashExecutable } from '../../../scripts/lib/git-bash-executable.mjs';

const helperUrl = new URL('./embedded-knowledge-windows.mjs', import.meta.url);
const upstreamFixture = new URL('./test-fixtures/embedded-knowledge/', import.meta.url);
const pinnedCommit = 'cd90b9a57abe85ad498e59b9be74e2748110c353';
const files = ['scripts/build-anydoc-lib.sh', 'third_party/anydoc-go/anydoc.go'];

test('patch regression runs from an offline checkout without an upstream cache', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge offline checkout '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'packages/electron/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of ['embedded-knowledge-windows.test.mjs', 'embedded-knowledge-windows.mjs', 'embedded-knowledge-windows-gnu.patch', 'embedded-knowledge-git-env.mjs', 'embedded-knowledge-pin.cjs']) {
    fs.copyFileSync(new URL(file, import.meta.url), path.join(scripts, file));
  }
  fs.cpSync(upstreamFixture, path.join(scripts, 'test-fixtures/embedded-knowledge'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(new URL('../../../scripts/lib/git-bash-executable.mjs', import.meta.url), path.join(root, 'scripts/lib/git-bash-executable.mjs'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', '--test-name-pattern=^patch applies twice', path.join(scripts, 'embedded-knowledge-windows.test.mjs'),
  ], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 1\b/);
});

async function implementation() {
  assert.ok(fs.existsSync(helperUrl), 'Windows adaptation must exist');
  return import(helperUrl.href);
}

// Vendored originals keep this regression independent of the build cache.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge patch & spaces '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    const original = fs.readFileSync(new URL(file, upstreamFixture), 'utf8').replace(/\r\n/g, '\n');
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), original);
  }
  // Keep git apply scoped to this fixture, even if the temporary root is in a repo.
  const init = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

test('Windows selects GNU even when the inherited TARGET is MSVC', async () => {
  const { knowledgeBuildEnv } = await implementation();
  const inherited = { TARGET: 'x86_64-pc-windows-msvc', CC: 'gcc', RUSTFLAGS: '-C debuginfo=0' };
  assert.deepEqual(knowledgeBuildEnv('win32', inherited), {
    ...inherited, TARGET: 'x86_64-pc-windows-gnu', EDITION: 'lite', CGO_ENABLED: '1',
  });
  assert.equal(inherited.TARGET, 'x86_64-pc-windows-msvc');
});

test('macOS keeps existing default and custom compiler flags and target', async () => {
  const { knowledgeBuildEnv, windowsPatchIdentity, applyWindowsKnowledgePatch } = await implementation();
  assert.deepEqual(knowledgeBuildEnv('darwin', {}), {
    EDITION: 'lite', CGO_ENABLED: '1', CGO_CFLAGS: '-Wno-deprecated-declarations',
    CGO_LDFLAGS: '-Wl,-no_warn_duplicate_libraries',
  });
  assert.deepEqual(knowledgeBuildEnv('darwin', { TARGET: 'aarch64-apple-darwin', CGO_CFLAGS: '-O2', CGO_LDFLAGS: '-lm' }), {
    TARGET: 'aarch64-apple-darwin', CGO_CFLAGS: '-O2', CGO_LDFLAGS: '-lm', EDITION: 'lite', CGO_ENABLED: '1',
  });
  assert.equal(windowsPatchIdentity('darwin'), null);
  assert.equal(applyWindowsKnowledgePatch('/unused', 'different-pin', 'darwin'), null);
});

test('patch applies twice without changing unrelated generated files', async (t) => {
  const { applyWindowsKnowledgePatch, windowsPatchIdentity } = await implementation();
  const root = fixture(t);
  const header = path.join(root, 'third_party/anydoc-go/include/anydoc.h');
  fs.mkdirSync(path.dirname(header), { recursive: true });
  fs.writeFileSync(header, 'generated header retained');
  const identity = applyWindowsKnowledgePatch(root, pinnedCommit, 'win32');
  assert.deepEqual(identity, windowsPatchIdentity('win32'));
  const once = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  assert.deepEqual(applyWindowsKnowledgePatch(root, pinnedCommit, 'win32'), identity);
  assert.deepEqual(files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')), once);
  assert.equal(fs.readFileSync(header, 'utf8'), 'generated header retained');
  const reverse = spawnSync('git', ['apply', '--reverse', '--check', fileURLToPath(new URL('./embedded-knowledge-windows-gnu.patch', import.meta.url))], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(reverse.status, 0, reverse.stderr);
});

test('unknown source edits are refused without partially applying the patch', async (t) => {
  const { applyWindowsKnowledgePatch } = await implementation();
  const root = fixture(t);
  const script = fs.readFileSync(path.join(root, files[0]), 'utf8');
  fs.appendFileSync(path.join(root, files[1]), '\n// user edit outside patch hunk\n');
  const edited = fs.readFileSync(path.join(root, files[1]), 'utf8');
  assert.throws(() => applyWindowsKnowledgePatch(root, pinnedCommit, 'win32'), /source mismatch/);
  assert.equal(fs.readFileSync(path.join(root, files[0]), 'utf8'), script);
  assert.equal(fs.readFileSync(path.join(root, files[1]), 'utf8'), edited);
});

test('unknown commits and edits after applying are refused', async (t) => {
  const { applyWindowsKnowledgePatch } = await implementation();
  const root = fixture(t);
  assert.throws(() => applyWindowsKnowledgePatch(root, '0'.repeat(40), 'win32'), /requires.*cd90b9a/);
  assert.throws(() => applyWindowsKnowledgePatch(root, 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f', 'win32'), /requires.*cd90b9a/);
  applyWindowsKnowledgePatch(root, pinnedCommit, 'win32');
  fs.appendFileSync(path.join(root, files[0]), '\n# user edit\n');
  assert.throws(() => applyWindowsKnowledgePatch(root, pinnedCommit, 'win32'), /source mismatch/);
});

test('CRLF checkouts apply idempotently', async (t) => {
  const { applyWindowsKnowledgePatch } = await implementation();
  const root = fixture(t);
  for (const file of files) {
    const filename = path.join(root, file);
    fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  const identity = applyWindowsKnowledgePatch(root, pinnedCommit, 'win32');
  assert.deepEqual(applyWindowsKnowledgePatch(root, pinnedCommit, 'win32'), identity);
});

test('partially applied patches are refused without repairing user files', async (t) => {
  const { applyWindowsKnowledgePatch } = await implementation();
  const root = fixture(t);
  const original = fs.readFileSync(path.join(root, files[0]));
  applyWindowsKnowledgePatch(root, pinnedCommit, 'win32');
  fs.writeFileSync(path.join(root, files[0]), original);
  const partial = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  assert.throws(() => applyWindowsKnowledgePatch(root, pinnedCommit, 'win32'), /partially patched/);
  assert.deepEqual(files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')), partial);
});

test('patched shell stages the GNU archive beside a stale MSVC archive', async (t) => {
  const { applyWindowsKnowledgePatch, knowledgeBuildEnv } = await implementation();
  const root = fixture(t);
  applyWindowsKnowledgePatch(root, pinnedCommit, 'win32');
  const crate = path.join(root, 'third_party/anydoc-go');
  fs.mkdirSync(path.join(crate, 'patched-anydoc'));
  fs.writeFileSync(path.join(crate, 'patched-anydoc/.weknora-patched'), '0.2.4\n');
  fs.writeFileSync(path.join(crate, 'patched-anydoc/Cargo.toml'), '# fixture\n');
  fs.writeFileSync(path.join(crate, 'Cargo.toml'), 'anydoc = "=0.2.4"\n');
  fs.writeFileSync(path.join(crate, 'version.go'), 'const Version = "0.2.4"\n');
  fs.mkdirSync(path.join(crate, 'lib/windows_amd64'), { recursive: true });
  fs.writeFileSync(path.join(crate, 'lib/windows_amd64/anydoc_go.lib'), 'stale MSVC archive');
  const bin = path.join(root, 'fake compiler');
  fs.mkdirSync(bin);
  // Only the compiler is replaced. The real upstream shell selects the target,
  // validates the version, and copies its build output into the cgo library dir.
  fs.writeFileSync(path.join(bin, 'cargo'), `#!/usr/bin/env bash
set -eu
test "$1 $2 $3 $4" = "build --release --locked --manifest-path"
crate_dir=$(dirname "$5")
test "$6" = "--target"
mkdir -p "$crate_dir/target/$7/release"
printf 'GNU archive fixture' > "$crate_dir/target/$7/release/libanydoc_go.a"
printf 'MSVC archive fixture' > "$crate_dir/target/$7/release/anydoc_go.lib"
`, { mode: 0o755 });
  const shellCommand = process.platform === 'win32'
    ? 'export PATH="$(cygpath -u "$1"):$PATH"; exec bash scripts/build-anydoc-lib.sh'
    : 'export PATH="$1:$PATH"; exec bash scripts/build-anydoc-lib.sh';
  const result = spawnSync(resolveGitBashExecutable(), ['-c', shellCommand, 'fixture', bin], {
    cwd: root, env: knowledgeBuildEnv('win32'), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(crate, 'lib/windows_amd64/libanydoc_go.a'), 'utf8'), 'GNU archive fixture');
  assert.equal(fs.readFileSync(path.join(crate, 'lib/windows_amd64/anydoc_go.lib'), 'utf8'), 'stale MSVC archive');
});

test('Windows cache rejects missing, stale patch hashes and wrong targets; macOS accepts legacy manifests', async () => {
  const { windowsPatchIdentity, matchesWindowsKnowledgePatch } = await implementation();
  const identity = windowsPatchIdentity('win32');
  assert.equal(matchesWindowsKnowledgePatch({}, 'win32'), false);
  assert.equal(matchesWindowsKnowledgePatch({ windowsPatch: identity }, 'win32'), true);
  assert.equal(matchesWindowsKnowledgePatch({ windowsPatch: { ...identity, sha256: 'old' } }, 'win32'), false);
  assert.equal(matchesWindowsKnowledgePatch({ windowsPatch: { ...identity, target: 'x86_64-pc-windows-msvc' } }, 'win32'), false);
  assert.equal(matchesWindowsKnowledgePatch({}, 'darwin'), true);
});

test('Darwin cross-build configures the requested Go, Clang and Rust targets', async () => {
  const { knowledgeBuildEnvForTarget } = await implementation();
  assert.deepEqual(knowledgeBuildEnvForTarget('darwin', {}, 'x64'), {
    EDITION: 'lite', CGO_ENABLED: '1', CGO_CFLAGS: '-Wno-deprecated-declarations',
    CGO_LDFLAGS: '-Wl,-no_warn_duplicate_libraries', GOOS: 'darwin', GOARCH: 'amd64',
    TARGET: 'x86_64-apple-darwin', CC: 'clang -arch x86_64',
  });
  assert.deepEqual(knowledgeBuildEnvForTarget('linux', {}, 'arm64'), {
    EDITION: 'lite', CGO_ENABLED: '1', GOOS: 'linux', GOARCH: 'arm64', TARGET: 'aarch64-unknown-linux-gnu',
  });
  assert.throws(() => knowledgeBuildEnvForTarget('darwin', { GOARCH: 'arm64' }, 'x64'), /GOARCH/);
});

test('the default worker source is the exact reviewed managed-key and text parser commit', () => {
  assert.deepEqual(knowledgePins.knowledgeSourcePin({}), {
    repository: 'https://github.com/NeoMei/embedded-knowledge', ref: pinnedCommit, commit: pinnedCommit,
  });
  const explicit = { repository: 'https://example.invalid/worker', ref: 'reviewed-ref', commit: 'b'.repeat(40) };
  assert.deepEqual(knowledgePins.knowledgeSourcePin({ OPENCHAMBER_EMBEDDED_KNOWLEDGE_REPO: explicit.repository,
    OPENCHAMBER_EMBEDDED_KNOWLEDGE_REF: explicit.ref, OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT: explicit.commit }), explicit);
});
