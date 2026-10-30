import test from 'node:test';
import assert from 'node:assert/strict';
import { readMachOSlices, assertIntelCompatibility } from './verify-intel-compat.mjs';

const x64 = 0x01000007, arm64 = 0x0100000c;
function thin({ cpu = x64, version = 12 << 16, legacy = false, big = false } = {}) {
  const bytes = Buffer.alloc(legacy ? 48 : 56);
  const write = (value, offset) => big ? bytes.writeUInt32BE(value, offset) : bytes.writeUInt32LE(value, offset);
  write(0xfeedfacf, 0); write(cpu, 4); write(2, 12); write(1, 16); write(bytes.length - 32, 20);
  write(legacy ? 0x24 : 0x32, 32); write(bytes.length - 32, 36);
  if (legacy) write(version, 40); else { write(1, 40); write(version, 44); }
  return bytes;
}
function fat(slices, wide = false) {
  const entrySize = wide ? 32 : 20, start = 8 + slices.length * entrySize;
  const bytes = Buffer.alloc(start + slices.reduce((sum, slice) => sum + slice.length, 0));
  bytes.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0); bytes.writeUInt32BE(slices.length, 4);
  let offset = start;
  slices.forEach((slice, index) => {
    const base = 8 + index * entrySize;
    bytes.writeUInt32BE(readMachOSlices(slice)[0].cpu, base);
    if (wide) { bytes.writeBigUInt64BE(BigInt(offset), base + 8); bytes.writeBigUInt64BE(BigInt(slice.length), base + 16); }
    else { bytes.writeUInt32BE(offset, base + 8); bytes.writeUInt32BE(slice.length, base + 12); }
    slice.copy(bytes, offset); offset += slice.length;
  });
  return bytes;
}

test('accepts declared Intel deployment targets from modern and legacy commands in either byte order', () => {
  for (const legacy of [false, true]) for (const big of [false, true]) {
    assert.equal(assertIntelCompatibility(thin({ legacy, big })).minimumMacOS, '12.0.0');
    assert.equal(assertIntelCompatibility(thin({ legacy, big, version: (10 << 16) | (15 << 8) })).minimumMacOS, '10.15.0');
  }
});
test('rejects an ARM-only payload or an Intel deployment target newer than Monterey', () => {
  assert.throws(() => assertIntelCompatibility(thin({ cpu: arm64 })), /No Intel/);
  for (const version of [(12 << 16) | 1, 13 << 16, 27 << 16]) assert.throws(() => assertIntelCompatibility(thin({ version })), /exceeds 12/);
});
test('checks the Intel slice of universal 32-bit and 64-bit tables', () => {
  for (const wide of [false, true]) {
    assert.equal(assertIntelCompatibility(fat([thin({ cpu: arm64, version: 13 << 16 }), thin()], wide)).minimumMacOS, '12.0.0');
    assert.throws(() => assertIntelCompatibility(fat([thin({ cpu: arm64 }), thin({ version: 13 << 16 })], wide)), /exceeds 12/);
  }
});
test('rejects truncated or absent deployment metadata', () => {
  const bytes = thin();
  for (const length of [0, 3, 4, 20, 31, 40, 55]) assert.throws(() => readMachOSlices(bytes.subarray(0, length)), /Truncated|Invalid/);
  bytes.writeUInt32LE(0x19, 32);
  assert.throws(() => readMachOSlices(bytes), /no declared minimum/);
});
test('rejects invalid load-command counts, sizes, platform and build tools', () => {
  for (const [offset, value] of [[16, 4097], [16, 2], [20, 0], [36, 4], [36, 60], [40, 2], [52, 1]]) {
    const bytes = thin(); bytes.writeUInt32LE(value, offset);
    assert.throws(() => readMachOSlices(bytes), /Invalid|Truncated|platform|sizes/);
  }
});
test('rejects universal table slices outside the file, overlapping or with mismatched CPU identities', () => {
  let bytes = fat([thin(), thin({ cpu: arm64 })]); bytes.writeUInt32BE(bytes.length, 16);
  assert.throws(() => readMachOSlices(bytes), /slice bounds/);
  bytes = fat([thin(), thin({ cpu: arm64 })]); bytes.writeUInt32BE(bytes.readUInt32BE(16), 36);
  assert.throws(() => readMachOSlices(bytes), /Overlapping/);
  bytes = fat([thin(), thin({ cpu: arm64 })]); bytes.writeUInt32BE(7, 8);
  assert.throws(() => readMachOSlices(bytes), /CPU differs/);
  bytes = fat([thin(), thin({ cpu: arm64 })]); bytes.writeUInt32BE(x64, 28);
  assert.throws(() => readMachOSlices(bytes), /Duplicate/);
});
