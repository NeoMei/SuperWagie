const fs = require('node:fs');

function knowledgeMacOSDeploymentTarget(platform, architecture) {
  return platform === 'darwin' && architecture === 'arm64' ? '13.0' : undefined;
}

function verifyKnowledgeMacOSDeployment(executable, manifest, platform, architecture) {
  const target = knowledgeMacOSDeploymentTarget(platform, architecture);
  if (!target) return;
  if (manifest?.macosDeploymentTarget !== target) {
    throw new Error(`Embedded-knowledge macOS deployment target must be ${target}; move existing staging to a preserved backup, then rebuild with --force after review`);
  }
  // Build tools use Node 24. Reuse the existing load-command parser without
  // reading the worker's several-hundred-megabyte payload into memory.
  const { readMachOSlices } = require('../../../scripts/verify-intel-compat.mjs');
  const descriptor = fs.openSync(executable, 'r');
  try {
    const header = Buffer.alloc(32);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length
      || header.readUInt32LE(0) !== 0xfeedfacf
      || header.readUInt32LE(4) !== 0x0100000c
      || header.readUInt32LE(8) !== 0) {
      throw new Error('Embedded-knowledge requires a generic arm64 Mach-O executable');
    }
    const commandBytes = header.readUInt32LE(20);
    if (commandBytes > 1024 * 1024) throw new Error('Invalid embedded-knowledge Mach-O load-command size');
    const bytes = Buffer.alloc(header.length + commandBytes);
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) {
      throw new Error('Truncated embedded-knowledge Mach-O load commands');
    }
    const [slice] = readMachOSlices(bytes);
    if (slice.minimumVersion > (13 << 16)) {
      const minimum = `${slice.minimumVersion >>> 16}.${(slice.minimumVersion >>> 8) & 255}.${slice.minimumVersion & 255}`;
      throw new Error(`Embedded-knowledge minimum macOS ${minimum} exceeds ${target}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { knowledgeMacOSDeploymentTarget, verifyKnowledgeMacOSDeployment };
