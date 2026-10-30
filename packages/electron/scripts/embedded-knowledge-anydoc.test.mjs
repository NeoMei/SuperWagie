import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveGitBashExecutable } from '../../../scripts/lib/git-bash-executable.mjs';

const helper = new URL('./embedded-knowledge-anydoc.mjs', import.meta.url);
const originalCrate = new URL('./vendor/anydoc-0.2.4.crate', import.meta.url);
const pinnedScript = new URL('./test-fixtures/embedded-knowledge/scripts/build-anydoc-lib.sh', import.meta.url);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge anydoc integrity '));
  const crate = path.join(root, 'third_party/anydoc-go');
  fs.mkdirSync(crate, { recursive: true });
  fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[dependencies]\nanydoc = "=0.2.4"\n[patch.crates-io]\nanydoc = { path = "patched-anydoc" }\n');
  fs.writeFileSync(path.join(crate, 'version.go'), 'package anydoc\nconst Version = "0.2.4"\n');
  return { root, crate, patched: path.join(crate, 'patched-anydoc') };
}

async function implementation() {
  assert.ok(fs.existsSync(helper), 'AnyDoc source integrity guard must exist');
  return import(helper.href);
}

test('stages the official crate with only the required re-export and marker, and verifies every file', async () => {
  const { prepareVerifiedAnyDocSource, verifyAnyDocSource } = await implementation();
  const { root, patched } = fixture();
  const identity = prepareVerifiedAnyDocSource(root);
  assert.equal(identity.version, '0.2.4');
  assert.equal(identity.sourceSha256, 'cf0d78e4cfe3654eb3ea04422ec5a94352000ee56e97902125e68e51f7527062');
  assert.match(identity.patchedTreeSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(patched, '.weknora-patched'), 'utf8'), '0.2.4\n');
  const lib = fs.readFileSync(path.join(patched, 'src/lib.rs'), 'utf8');
  assert.match(lib, /^pub use render::markdown::document_to_markdown;$/m);
  assert.doesNotMatch(lib, /^use render::markdown::document_to_markdown;$/m);
  assert.deepEqual(verifyAnyDocSource(root), identity);
  assert.deepEqual(prepareVerifiedAnyDocSource(root), identity);
});

test('rejects an archive whose bytes do not match the official checksum before writing source', async () => {
  const { prepareVerifiedAnyDocSource } = await implementation();
  const { root, patched } = fixture();
  const archivePath = path.join(root, 'modified.crate');
  const bytes = fs.readFileSync(originalCrate); bytes[100] ^= 1;
  fs.writeFileSync(archivePath, bytes);
  assert.throws(() => prepareVerifiedAnyDocSource(root, { archivePath }), /checksum/i);
  assert.equal(fs.existsSync(patched), false);
  assert.deepEqual(fs.readFileSync(archivePath), bytes);
});

test('refuses a version outside the reviewed policy without creating a patched cache', async () => {
  const { prepareVerifiedAnyDocSource } = await implementation();
  const { root, crate, patched } = fixture();
  fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[dependencies]\nanydoc = "=0.2.5"\n');
  assert.throws(() => prepareVerifiedAnyDocSource(root), /version|pin/i);
  assert.equal(fs.existsSync(patched), false);
});

test('preserves and refuses a partial cache even when its marker claims the current version', async () => {
  const { prepareVerifiedAnyDocSource } = await implementation();
  const { root, patched } = fixture();
  fs.mkdirSync(patched); fs.writeFileSync(path.join(patched, '.weknora-patched'), '0.2.4\n');
  fs.writeFileSync(path.join(patched, 'Cargo.toml'), 'untrusted cached source');
  assert.throws(() => prepareVerifiedAnyDocSource(root), /preserv|integrity/i);
  assert.equal(fs.readFileSync(path.join(patched, 'Cargo.toml'), 'utf8'), 'untrusted cached source');
});

test('detects a modified file or extra file before reuse and after a compiler runs', async () => {
  const { prepareVerifiedAnyDocSource, verifyAnyDocSource } = await implementation();
  for (const mutation of ['content', 'extra']) {
    const { root, patched } = fixture(); prepareVerifiedAnyDocSource(root);
    const file = path.join(patched, mutation === 'extra' ? 'unknown.rs' : 'src/lib.rs');
    fs.appendFileSync(file, '\nuntrusted change\n');
    assert.throws(() => verifyAnyDocSource(root), /integrity/i);
    assert.throws(() => prepareVerifiedAnyDocSource(root), /preserv|integrity/i);
    assert.match(fs.readFileSync(file, 'utf8'), /untrusted change/);
  }
});

test('detects changed file and directory modes on POSIX', { skip: process.platform === 'win32' }, async () => {
  const { prepareVerifiedAnyDocSource, verifyAnyDocSource } = await implementation();
  for (const entry of ['src/lib.rs', 'src']) {
    const { root, patched } = fixture(); prepareVerifiedAnyDocSource(root);
    fs.chmodSync(path.join(patched, entry), 0o777);
    assert.throws(() => verifyAnyDocSource(root), /integrity|mode/i);
    assert.equal(fs.statSync(path.join(patched, entry)).mode & 0o777, 0o777);
  }
});

test('rejects links within source and at the patched directory without following them', { skip: process.platform === 'win32' }, async () => {
  const { prepareVerifiedAnyDocSource, verifyAnyDocSource } = await implementation();
  const { root, patched } = fixture(); prepareVerifiedAnyDocSource(root);
  const file = path.join(patched, 'src/lib.rs'); const outside = path.join(root, 'saved-lib.rs');
  fs.renameSync(file, outside); fs.symlinkSync(outside, file);
  assert.throws(() => verifyAnyDocSource(root), /integrity|link/i);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  const second = fixture(); fs.symlinkSync(patched, second.patched, 'dir');
  assert.throws(() => prepareVerifiedAnyDocSource(second.root), /integrity|link/i);
  assert.ok(fs.lstatSync(second.patched).isSymbolicLink());
});

test('refuses hard-linked source files and preserves both links', async () => {
  const { prepareVerifiedAnyDocSource, verifyAnyDocSource } = await implementation();
  const { root, patched } = fixture(); prepareVerifiedAnyDocSource(root);
  const file = path.join(patched, 'src/lib.rs'); const link = path.join(root, 'hard-linked-lib.rs');
  fs.linkSync(file, link);
  assert.throws(() => verifyAnyDocSource(root), /integrity|link/i);
  assert.equal(fs.statSync(file).nlink, 2);
  assert.deepEqual(fs.readFileSync(link), fs.readFileSync(file));
});

test('the actual pinned Bash marker branch skips its registry search, download and extraction', async () => {
  const { prepareVerifiedAnyDocSource, verifyAnyDocSource } = await implementation();
  const { root, crate } = fixture(); const identity = prepareVerifiedAnyDocSource(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = fs.readFileSync(pinnedScript, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha1').update(`blob ${Buffer.byteLength(script)}\0`).update(script).digest('hex'), 'd59aeeb48ab44dda37b2d9348286685192822df4');
  fs.writeFileSync(path.join(root, 'scripts/build-anydoc-lib.sh'), script);
  const bin = path.join(root, 'fake-tools'); fs.mkdirSync(bin);
  for (const tool of ['curl', 'find', 'tar', 'rm']) {
    fs.writeFileSync(path.join(bin, tool), '#!/usr/bin/env bash\necho "unverified source branch executed" >&2\nexit 91\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'cargo'), `#!/usr/bin/env bash
set -eu
test "$1 $2 $3 $4" = "build --release --locked --manifest-path"
crate_dir=$(dirname "$5")
test "$6 $7" = "--target aarch64-apple-darwin"
mkdir -p "$crate_dir/target/$7/release"
printf 'compiler output fixture' > "$crate_dir/target/$7/release/libanydoc_go.a"
`, { mode: 0o755 });
  const shellCommand = process.platform === 'win32'
    ? 'export PATH="$(cygpath -u "$1"):$PATH"; exec bash scripts/build-anydoc-lib.sh'
    : 'export PATH="$1:$PATH"; exec bash scripts/build-anydoc-lib.sh';
  const result = spawnSync(resolveGitBashExecutable(), ['-c', shellCommand, 'fixture', bin], {
    cwd: root, env: { ...process.env, TARGET: 'aarch64-apple-darwin' }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(crate, 'lib/darwin_arm64/libanydoc_go.a'), 'utf8'), 'compiler output fixture');
  assert.deepEqual(verifyAnyDocSource(root), identity);
});
