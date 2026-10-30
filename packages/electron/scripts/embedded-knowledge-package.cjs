const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { knowledgeSourcePin } = require('./embedded-knowledge-pin.cjs');
const { matchesAnyDocSourcePolicy, isPinnedWindowsKnowledgePrebuilt } = require('./embedded-knowledge-policy.cjs');

// electron-builder runs afterPack before signing, when the staged digest still
// applies. Verify the binary itself rather than trusting a host-built filename.
function verifyEmbeddedKnowledge(resourcesPath, platform, architecture, expectedSource = knowledgeSourcePin()) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(architecture) || (platform === 'win32' && architecture !== 'x64')) {
    throw new Error(`Unsupported embedded-knowledge package target ${platform}/${architecture}`);
  }
  const directory = path.join(resourcesPath, 'embedded-knowledge');
  const binaryName = platform === 'win32' ? 'embedded-knowledge-server.exe' : 'embedded-knowledge-server';
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')); }
  catch { throw new Error(`Missing or invalid embedded-knowledge manifest: ${directory}`); }
  if (!expectedSource || !/^[a-f0-9]{40}$/.test(expectedSource.commit || '') || manifest.repository !== expectedSource.repository || manifest.ref !== expectedSource.ref || manifest.commit !== expectedSource.commit) {
    throw new Error('Embedded-knowledge manifest does not match the expected source pin');
  }
  if (manifest.binary !== binaryName || !/^[a-f0-9]{64}$/.test(manifest.binarySha256 || '')) {
    throw new Error('Invalid embedded-knowledge binary manifest');
  }
  const tags = new Set(String(manifest.tags || '').split(',').map((tag) => tag.trim()));
  if (!tags.has('sqlite_fts5') || !tags.has('anydoc')) throw new Error('Embedded-knowledge build lacks SQLite or document parsing support');
  for (const required of ['LICENSE', 'config/config.yaml', 'migrations/sqlite']) {
    if (!fs.existsSync(path.join(directory, required))) throw new Error(`Missing embedded-knowledge resource: ${required}`);
  }
  const sqliteMigrations = path.join(directory, 'migrations', 'sqlite');
  if (!fs.statSync(sqliteMigrations).isDirectory() || !fs.readdirSync(sqliteMigrations).some((name) => name.endsWith('.sql'))) throw new Error('Missing embedded-knowledge SQLite migrations');
  const executable = path.join(directory, binaryName);
  let descriptor;
  try {
    descriptor = fs.openSync(executable, 'r');
    const header = Buffer.alloc(128);
    const count = fs.readSync(descriptor, header, 0, header.length, 0);
    let actual;
    if (platform === 'darwin' && count >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
      actual = ({ 0x01000007: 'x64', 0x0100000c: 'arm64' })[header.readUInt32LE(4)];
    } else if (platform === 'linux' && count >= 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && header[4] === 2 && header[5] === 1) {
      actual = ({ 62: 'x64', 183: 'arm64' })[header.readUInt16LE(18)];
    } else if (platform === 'win32' && count >= 64 && header.subarray(0, 2).toString('latin1') === 'MZ') {
      const pe = Buffer.alloc(6);
      if (fs.readSync(descriptor, pe, 0, pe.length, header.readUInt32LE(0x3c)) === pe.length && pe.subarray(0, 4).toString('latin1') === 'PE\0\0') {
        actual = ({ 0x8664: 'x64', 0xaa64: 'arm64' })[pe.readUInt16LE(4)];
      }
    }
    if (actual !== architecture) throw new Error(`Embedded-knowledge architecture mismatch: expected ${platform}/${architecture}, got ${actual || 'invalid executable'}`);
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024); let offset = 0; let bytes;
    while ((bytes = fs.readSync(descriptor, chunk, 0, chunk.length, offset)) > 0) { hash.update(chunk.subarray(0, bytes)); offset += bytes; }
    const actualBinarySha256 = hash.digest('hex');
    if (actualBinarySha256 !== manifest.binarySha256) throw new Error('Embedded-knowledge binary hash mismatch');
    if (!matchesAnyDocSourcePolicy(manifest.anydocSource)
      && !isPinnedWindowsKnowledgePrebuilt(manifest, platform, architecture, actualBinarySha256)) {
      throw new Error('Embedded-knowledge AnyDoc source policy is missing or does not match the reviewed inputs');
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing embedded-knowledge binary: ${executable}`);
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

module.exports = { verifyEmbeddedKnowledge };
