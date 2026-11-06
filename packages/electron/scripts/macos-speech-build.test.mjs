import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSpeechCompatibility, speechCompilerArguments, readReusableSpeechBuild } from './macos-speech-build.mjs';
import { arm64SpeechProfile, shouldPrepareArm64Speech } from './prepare-arm64-speech.mjs';
import { intelSpeechProfile } from './prepare-intel-speech.mjs';

function binary({ cpu = 0x0100000c, subtype = 0, minimum = 13 << 16 } = {}) {
  const bytes = Buffer.alloc(56);
  for (const [offset, value] of [[0, 0xfeedfacf], [4, cpu], [8, subtype], [12, 6], [16, 1], [20, 24], [32, 0x32], [36, 24], [40, 1], [44, minimum]]) bytes.writeUInt32LE(value, offset);
  return bytes;
}

test('accepts baseline arm64 speech binaries declared for macOS 13 or earlier', () => {
  assert.deepEqual(assertSpeechCompatibility(binary(), arm64SpeechProfile), { minimumMacOS: '13.0.0', architectures: ['arm64'], cpuSubtype: 0 });
  assert.equal(assertSpeechCompatibility(binary({ minimum: 11 << 16 }), arm64SpeechProfile).minimumMacOS, '11.0.0');
});

test('rejects newer macOS, another architecture, arm64e, or incomplete speech metadata', () => {
  for (const options of [{ minimum: 14 << 16 }, { minimum: (13 << 16) | 1 }, { cpu: 0x01000007 }, { subtype: 2 }]) {
    assert.throws(() => assertSpeechCompatibility(binary(options), arm64SpeechProfile));
  }
  assert.throws(() => assertSpeechCompatibility(binary().subarray(0, 40), arm64SpeechProfile));
});

test('preserves the Intel speech macOS 12 compatibility boundary', () => {
  const x64 = { cpu: 0x01000007, subtype: 3, minimum: 12 << 16 };
  assert.deepEqual(assertSpeechCompatibility(binary(x64), intelSpeechProfile), { minimumMacOS: '12.0.0', architectures: ['x64'] });
  assert.throws(() => assertSpeechCompatibility(binary({ ...x64, minimum: 13 << 16 }), intelSpeechProfile));
  assert.throws(() => assertSpeechCompatibility(binary(), intelSpeechProfile));
});

const sourcePaths = { source: '/source', nodeHeaders: '/headers', addonHeaders: '/addon-api', sourceFiles: ['/source/first.cc', '/source/second.cc'], libraries: '/libraries', output: '/candidate/sherpa-onnx.node' };
test('compiles the ARM wrapper for generic ARMv8 and macOS 13 with the original native API and libraries', () => {
  const args = speechCompilerArguments(arm64SpeechProfile, sourcePaths);
  assert.equal(args[args.indexOf('-arch') + 1], 'arm64');
  assert(args.includes('-mcpu=generic'));
  assert(args.includes('-mmacosx-version-min=13.0'));
  assert(args.includes('-DNAPI_VERSION=8'));
  assert(args.includes('-Wl,-rpath,@loader_path'));
  assert(args.includes('-lsherpa-onnx-c-api') && args.includes('-lonnxruntime'));
  assert(!args.some((arg) => arg.includes('native') || arg.includes('apple-m')));
  assert.equal(args.at(-1), '/candidate/sherpa-onnx.node');
});

test('keeps the Intel compiler architecture and deployment target unchanged', () => {
  const args = speechCompilerArguments(intelSpeechProfile, sourcePaths);
  assert.equal(args[args.indexOf('-arch') + 1], 'x86_64');
  assert(args.includes('-mmacosx-version-min=12.0'));
  assert(!args.some((arg) => arg.startsWith('-mcpu=')));
  assert.equal(intelSpeechProfile.electronVersion, '43.8.4');
  assert.equal(intelSpeechProfile.appVersion, '2.7.40-intel');
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function reuseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-reuse-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const addonPath = path.join(directory, 'sherpa-onnx.node'), receiptPath = path.join(directory, 'receipt.json');
  const original = Buffer.from('original npm addon fixture'), rebuilt = binary();
  const libraries = Object.keys(arm64SpeechProfile.libraryHashes).map(name => ({ name, sha256: digest(binary({ minimum: 11 << 16 })) }));
  const profile = { ...arm64SpeechProfile, originalAddonSha256: digest(original), libraryHashes: Object.fromEntries(libraries.map(library => [library.name, library.sha256])) };
  for (const library of libraries) fs.writeFileSync(path.join(directory, library.name), binary({ minimum: 11 << 16 }));
  const receipt = {
    schemaVersion: 1, passed: true, staged: true, target: 'darwin-arm64',
    sourceCommit: '11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf', speechVersion: '1.13.8', electronVersion: '44.9.3', nodeAddonApiVersion: '7.1.1', minimumMacOS: '13.0.0',
    originalAddonSha256: digest(original), outputSha256: digest(rebuilt), outputSize: rebuilt.length,
    compatibility: { minimumMacOS: '13.0.0', architectures: ['arm64'], cpuSubtype: 0 }, libraries,
    artifacts: [
      { name: 'sherpa-onnx-11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf.tar.gz', url: 'https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf', sha256: '0a8db6c55dd318f4a688faba85f7760b99a6c92e8ef8864479d418531bee1ac2' },
      { name: 'node-v44.9.3-headers.tar.gz', url: 'https://artifacts.electronjs.org/headers/dist/v44.9.3/node-v44.9.3-headers.tar.gz', sha256: '5f75ae1e70e69442c9d23f7d984e8ca211e49c5bee2298ca2d84d3c75c640710' },
      { name: 'node-addon-api-7.1.1.tgz', url: 'https://registry.npmjs.org/node-addon-api/-/node-addon-api-7.1.1.tgz', sha256: 'b10455d15a977c0cd17a1cb0eb679e03d939f8ef8d4302eb33e1f78dacc71f82' },
    ],
    compileOptions: ['clang++', '-std=c++17', '-O3', '-DNAPI_VERSION=8', '-arch', 'arm64', '-mmacosx-version-min=13.0', '-mcpu=generic', '-dynamiclib', '-Wl,-undefined,dynamic_lookup', '-Wl,-rpath,@loader_path', '-Wl,-install_name,@rpath/sherpa-onnx.node'],
    runtime: { passed: true, electron: '44.9.3', abi: '149', nodeApi: 8, version: '1.13.8', gitSha1: '11afbd00', resampling: { inputSamples: 4096, outputSamples: 1366, bytesMatch: true } },
  };
  const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const read = () => readReusableSpeechBuild(profile, { addonPath, receiptPath, libraryDirectory: directory });
  return { directory, addonPath, receiptPath, original, rebuilt, profile, receipt, save, read };
}

test('first preparation accepts the pinned original without requiring or creating a receipt', t => {
  const f = reuseFixture(t);
  fs.writeFileSync(f.addonPath, f.original);
  assert.equal(f.read(), null);
  assert.equal(fs.existsSync(f.receiptPath), false);
});

test('reuses an intact ARM build and its successful receipt without rewriting either', t => {
  const f = reuseFixture(t);
  fs.writeFileSync(f.addonPath, f.rebuilt); f.save();
  const before = fs.readFileSync(f.receiptPath);
  assert.deepEqual(f.read(), f.receipt);
  assert.deepEqual(fs.readFileSync(f.receiptPath), before);
  assert.deepEqual(fs.readFileSync(f.addonPath), f.rebuilt);
});

test('keeps successful receipt reuse unavailable to the Intel preparation path', t => {
  const f = reuseFixture(t);
  fs.writeFileSync(f.addonPath, f.rebuilt); f.save();
  assert.throws(() => readReusableSpeechBuild({ ...f.profile, arch: 'x64' }, { addonPath: f.addonPath, receiptPath: f.receiptPath, libraryDirectory: f.directory }), /Only ARM64/);
});

test('refuses modified builds, libraries, stale inputs and incomplete receipts', t => {
  const mutations = [
    f => fs.appendFileSync(f.addonPath, 'changed'),
    f => fs.appendFileSync(path.join(f.directory, 'libonnxruntime.dylib'), 'changed'),
    f => { f.receipt.sourceCommit = 'another-commit'; },
    f => { f.receipt.artifacts[1].sha256 = 'another-header'; },
    f => { f.receipt.compileOptions[7] = '-mcpu=native'; },
    f => { f.receipt.libraries[0].sha256 = 'another-library'; },
    f => { f.receipt.runtime.abi = '148'; },
    f => { f.receipt.runtime.resampling.bytesMatch = false; },
    f => { f.receipt.passed = false; },
    f => { delete f.receipt.compileOptions; },
    f => { const bytes = binary({ minimum: 14 << 16 }); fs.writeFileSync(f.addonPath, bytes); f.receipt.outputSha256 = digest(bytes); },
  ];
  for (const mutate of mutations) {
    const f = reuseFixture(t);
    fs.writeFileSync(f.addonPath, f.rebuilt); mutate(f); f.save();
    assert.throws(f.read);
  }
  const f = reuseFixture(t);
  fs.writeFileSync(f.addonPath, f.rebuilt);
  assert.throws(f.read);
  fs.writeFileSync(f.receiptPath, '{invalid');
  assert.throws(f.read);
});

test('skips speech preparation outside the macOS ARM64 build target', () => {
  assert.equal(shouldPrepareArm64Speech({ platform: 'win32', hostArchitecture: 'arm64', environment: {} }), false);
  assert.equal(shouldPrepareArm64Speech({ platform: 'linux', hostArchitecture: 'arm64', environment: {} }), false);
  assert.equal(shouldPrepareArm64Speech({ platform: 'darwin', hostArchitecture: 'arm64', environment: { OPENCHAMBER_TARGET_ARCH: 'x64' } }), false);
  assert.equal(shouldPrepareArm64Speech({ platform: 'darwin', hostArchitecture: 'arm64', environment: {}, builderArgs: ['--x64'] }), false);
  assert.equal(shouldPrepareArm64Speech({ platform: 'darwin', hostArchitecture: 'x64', environment: { OPENCHAMBER_TARGET_ARCH: 'arm64' } }), true);
  assert.equal(shouldPrepareArm64Speech({ platform: 'darwin', hostArchitecture: 'arm64', environment: {} }), true);
  assert.throws(() => shouldPrepareArm64Speech({ platform: 'darwin', hostArchitecture: 'arm64', environment: { OPENCHAMBER_TARGET_ARCH: 'x64' }, builderArgs: ['--arm64'] }));
});
