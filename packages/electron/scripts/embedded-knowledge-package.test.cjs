const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { verifyEmbeddedKnowledge } = require('./embedded-knowledge-package.cjs');
const { isPinnedWindowsKnowledgePrebuilt } = require('./embedded-knowledge-policy.cjs');

function binary(platform, arch) {
  const b = Buffer.alloc(128);
  if (platform === 'linux') {
    b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1;
    b.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
  } else if (platform === 'darwin') {
    b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  } else {
    b.write('MZ', 0); b.writeUInt32LE(64, 0x3c); b.write('PE\0\0', 64, 'latin1');
    b.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68);
  }
  return b;
}
function fixture(t, platform, arch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'embedded-knowledge');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'migrations', 'sqlite'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.yaml'), 'fixture');
  fs.writeFileSync(path.join(dir, 'migrations', 'sqlite', '001.sql'), 'fixture');
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'fixture');
  const name = platform === 'win32' ? 'embedded-knowledge-server.exe' : 'embedded-knowledge-server';
  const data = binary(platform, arch); fs.writeFileSync(path.join(dir, name), data);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ binary: name, repository: 'https://github.com/NeoMei/embedded-knowledge', ref: 'cd90b9a57abe85ad498e59b9be74e2748110c353', commit: 'cd90b9a57abe85ad498e59b9be74e2748110c353', tags: 'sqlite_fts5,anydoc', binarySha256: crypto.createHash('sha256').update(data).digest('hex'), anydocSource: { version: '0.2.4', sourceSha256: 'cf0d78e4cfe3654eb3ea04422ec5a94352000ee56e97902125e68e51f7527062', patchedTreeSha256: 'a9641c5da12abbc3f492e75f6140d7e2c57a78edd012110c57ed6836cb221cde' } }));
  return { root, dir, name };
}
for (const platform of ['darwin', 'linux', 'win32']) {
  for (const arch of platform === 'win32' ? ['x64'] : ['x64', 'arm64']) {
    test(`packaged ${platform} ${arch} knowledge payload requires real binary identity and integrity`, (t) => {
      const { root, dir, name } = fixture(t, platform, arch);
      assert.doesNotThrow(() => verifyEmbeddedKnowledge(root, platform, arch));
      fs.writeFileSync(path.join(dir, name), binary(platform, arch === 'x64' ? 'arm64' : 'x64'));
      const wrong = fs.readFileSync(path.join(dir, name));
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, binarySha256: crypto.createHash('sha256').update(wrong).digest('hex') }));
      assert.throws(() => verifyEmbeddedKnowledge(root, platform, arch), /architecture/i);
      fs.writeFileSync(path.join(dir, name), binary(platform, arch));
      assert.throws(() => verifyEmbeddedKnowledge(root, platform, arch), /hash/i);
      fs.rmSync(path.join(dir, 'migrations'), { recursive: true });
      assert.throws(() => verifyEmbeddedKnowledge(root, platform, arch));
    });
  }
}
test('missing bundled worker is rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => verifyEmbeddedKnowledge(root, 'linux', 'x64'), /embedded.knowledge/i);
});

test('packaged source identity must match the explicit complete source pin', (t) => {
  const { root, dir } = fixture(t, 'darwin', 'arm64');
  const manifestPath = path.join(dir, 'manifest.json');
  const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const change of [
    { commit: 'a'.repeat(40) }, { ref: 'different' }, { repository: 'https://example.invalid/repo' }, { commit: original.commit.slice(0, 7) },
  ]) {
    fs.writeFileSync(manifestPath, JSON.stringify({ ...original, ...change }));
    assert.throws(() => verifyEmbeddedKnowledge(root, 'darwin', 'arm64'), /source.*pin/i);
  }
  const override = { repository: 'https://example.invalid/repo', ref: 'reviewed', commit: 'a'.repeat(40) };
  fs.writeFileSync(manifestPath, JSON.stringify({ ...original, ...override }));
  assert.doesNotThrow(() => verifyEmbeddedKnowledge(root, 'darwin', 'arm64', override));
  assert.throws(() => verifyEmbeddedKnowledge(root, 'darwin', 'arm64'));
});

for (const [platform, architecture] of [['darwin', 'arm64'], ['linux', 'x64'], ['win32', 'x64']]) {
  test(`direct packaging rejects missing or altered AnyDoc source policy on ${platform}`, (t) => {
    const { root, dir } = fixture(t, platform, architecture);
    const file = path.join(dir, 'manifest.json');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const anydocSource of [undefined, {}, null, { ...original.anydocSource, version: '0.2.5' },
      { ...original.anydocSource, sourceSha256: 'a'.repeat(64) },
      { ...original.anydocSource, patchedTreeSha256: 'b'.repeat(64) },
      { ...original.anydocSource, skipVerification: true }]) {
      fs.writeFileSync(file, JSON.stringify({ ...original, anydocSource }));
      assert.throws(() => verifyEmbeddedKnowledge(root, platform, architecture), /anydoc.*policy/i);
    }
  });
}

test('Windows legacy self-reported flags and pinned hashes cannot bypass actual binary verification', (t) => {
  const { root, dir } = fixture(t, 'win32', 'x64');
  const file = path.join(dir, 'manifest.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const windowsPatch = { target: 'x86_64-pc-windows-gnu', sha256: 'cd7d7a4a296acfe0ec5766b51682ff076e84f3938208823605f51e1e6f2ece71' };
  for (const flags of [{ provenance: 'audited-prebuilt' }, { legacy: true, skipAnyDocVerification: true },
    { prebuiltSha256: 'bed12a528363cccbab302db63d27f5e60d780faa08623ba94b6bd4560fc4c162' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, anydocSource: undefined, windowsPatch, ...flags }));
    assert.throws(() => verifyEmbeddedKnowledge(root, 'win32', 'x64'), /anydoc.*policy/i);
  }
  fs.writeFileSync(file, JSON.stringify({ ...original, anydocSource: undefined, windowsPatch, binarySha256: 'bed12a528363cccbab302db63d27f5e60d780faa08623ba94b6bd4560fc4c162' }));
  assert.throws(() => verifyEmbeddedKnowledge(root, 'win32', 'x64'), /hash/i);
});

test('the legacy Windows policy predicate is limited to the fixed bytes, source label and patch', () => {
  // This checks selection rules with an explicit hash input; full payload tests
  // above verify that the caller computes that input from the actual file.
  const hash = 'bed12a528363cccbab302db63d27f5e60d780faa08623ba94b6bd4560fc4c162';
  const manifest = {
    repository: 'https://github.com/NeoMei/embedded-knowledge', ref: 'embedded-knowledge',
    commit: 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f', binary: 'embedded-knowledge-server.exe',
    windowsPatch: { target: 'x86_64-pc-windows-gnu', sha256: 'cd7d7a4a296acfe0ec5766b51682ff076e84f3938208823605f51e1e6f2ece71' },
  };
  assert.equal(isPinnedWindowsKnowledgePrebuilt(manifest, 'win32', 'x64', hash), true);
  for (const patch of [{ repository: 'https://example.invalid/override' }, { ref: 'reviewed-override' }, { commit: 'b'.repeat(40) }, { ref: 'cd90b9a57abe85ad498e59b9be74e2748110c353', commit: 'cd90b9a57abe85ad498e59b9be74e2748110c353' },
    { binary: 'other.exe' }, { windowsPatch: { ...manifest.windowsPatch, target: 'x86_64-pc-windows-msvc' } },
    { windowsPatch: { ...manifest.windowsPatch, sha256: 'a'.repeat(64) } }, { anydocSource: { version: '0.2.5' } }]) {
    assert.equal(isPinnedWindowsKnowledgePrebuilt({ ...manifest, ...patch }, 'win32', 'x64', hash), false);
  }
  assert.equal(isPinnedWindowsKnowledgePrebuilt(manifest, 'win32', 'x64', 'c'.repeat(64)), false);
  assert.equal(isPinnedWindowsKnowledgePrebuilt(manifest, 'win32', 'arm64', hash), false);
  assert.equal(isPinnedWindowsKnowledgePrebuilt(manifest, 'darwin', 'x64', hash), false);
});
