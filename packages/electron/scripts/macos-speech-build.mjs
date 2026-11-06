import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIntelCompatibility, readMachOSlices } from '../../../scripts/verify-intel-compat.mjs';

// Rebuild only the Node-API wrapper against the pinned, unchanged speech libraries.
const sourceCommit = '11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf';
const speechVersion = '1.13.8';
const artifactsFor = ({ electronVersion, headersSha256 }) => [
  { name: `sherpa-onnx-${sourceCommit}.tar.gz`, root: `sherpa-onnx-${sourceCommit}`, url: `https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/${sourceCommit}`, sha256: '0a8db6c55dd318f4a688faba85f7760b99a6c92e8ef8864479d418531bee1ac2' },
  { name: `node-v${electronVersion}-headers.tar.gz`, root: 'node_headers', url: `https://artifacts.electronjs.org/headers/dist/v${electronVersion}/node-v${electronVersion}-headers.tar.gz`, sha256: headersSha256 },
  { name: 'node-addon-api-7.1.1.tgz', root: 'package', url: 'https://registry.npmjs.org/node-addon-api/-/node-addon-api-7.1.1.tgz', sha256: 'b10455d15a977c0cd17a1cb0eb679e03d939f8ef8d4302eb33e1f78dacc71f82' },
];
const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(electronRoot, '../..');
const require = createRequire(import.meta.url);
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function extract(cache, artifact, destination, members = []) {
  const archive = path.join(cache, artifact.name);
  // Validate link targets before extraction. Git's addon sources are symlinks
  // into harmony-os, so rejecting every symlink would omit the actual sources.
  run('python3', ['-I', '-c', `
import posixpath,sys,tarfile
archive,root,*selected=sys.argv[1:]
with tarfile.open(archive) as source:
    for member in source:
        name=member.name.rstrip('/')
        if selected and not any(name == item or name.startswith(item+'/') for item in selected):
            continue
        if not name or name.startswith('/') or '\\\\' in name or ':' in name or '..' in name.split('/'):
            raise ValueError('Unsafe archive path: '+name)
        if name != root and not name.startswith(root+'/'):
            raise ValueError('Unexpected archive root: '+name)
        if member.issym():
            link=member.linkname
            target=posixpath.normpath(posixpath.join(posixpath.dirname(name),link))
            if link.startswith('/') or '\\\\' in link or ':' in link or not target.startswith(root+'/'):
                raise ValueError('Archive symlink escapes root: '+name)
        elif not member.isfile() and not member.isdir():
            raise ValueError('Unsupported archive entry: '+name)
`, archive, artifact.root, ...members]);
  fs.mkdirSync(destination, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '-C', destination, ...members]);
}

export function assertSpeechCompatibility(bytes, profile, name = 'binary') {
  if (profile.arch === 'x64') return assertIntelCompatibility(bytes, name);
  assert.equal(profile.arch, 'arm64', 'Unsupported speech build architecture');
  const slices = readMachOSlices(bytes);
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, `Expected a thin arm64 Mach-O: ${name}`);
  assert.equal(slices.length, 1, `Expected one arm64 slice: ${name}`);
  assert.equal(slices[0].cpu, 0x0100000c, `Expected arm64: ${name}`);
  assert.equal(bytes.readUInt32LE(8), 0, `Expected generic ARM64 subtype ALL: ${name}`);
  assert(slices[0].minimumVersion <= (13 << 16), `Minimum macOS exceeds 13.0: ${name}`);
  const version = slices[0].minimumVersion;
  return { minimumMacOS: `${version >>> 16}.${(version >>> 8) & 255}.${version & 255}`, architectures: ['arm64'], cpuSubtype: 0 };
}

function speechCompilerOptions(profile) {
  const architecture = profile.arch === 'x64' ? 'x86_64' : 'arm64';
  const flags = ['clang++', '-std=c++17', '-O3', '-DNAPI_VERSION=8', '-arch', architecture, `-mmacosx-version-min=${profile.minimumMacOS}`];
  if (profile.arch === 'arm64') flags.push('-mcpu=generic');
  return [...flags, '-dynamiclib', '-Wl,-undefined,dynamic_lookup', '-Wl,-rpath,@loader_path', '-Wl,-install_name,@rpath/sherpa-onnx.node'];
}

export function speechCompilerArguments(profile, paths) {
  return [...speechCompilerOptions(profile), '-I', paths.source, '-I', paths.nodeHeaders, '-I', paths.addonHeaders, ...paths.sourceFiles, '-L', paths.libraries, '-lsherpa-onnx-c-api', '-lonnxruntime', '-o', paths.output];
}

export function readReusableSpeechBuild(profile, { addonPath, receiptPath, libraryDirectory }) {
  const currentHash = sha256(addonPath);
  if (currentHash === profile.originalAddonSha256) return null;
  assert.equal(profile.arch, 'arm64', 'Only ARM64 speech builds support receipt reuse');
  const receipt = readJson(receiptPath);
  for (const [name, expected] of Object.entries({ schemaVersion: 1, passed: true, staged: true, target: 'darwin-arm64', sourceCommit, speechVersion, electronVersion: profile.electronVersion, nodeAddonApiVersion: '7.1.1', minimumMacOS: `${profile.minimumMacOS}.0`, originalAddonSha256: profile.originalAddonSha256 })) {
    assert.equal(receipt[name], expected, `Speech receipt differs: ${name}`);
  }
  assert.deepEqual(receipt.artifacts, artifactsFor(profile).map(({ name, url, sha256: digest }) => ({ name, url, sha256: digest })), 'Speech build inputs changed');
  assert.deepEqual(receipt.compileOptions, speechCompilerOptions(profile), 'Speech compiler options changed');
  assert.equal(receipt.outputSha256, currentHash, 'Rebuilt speech addon changed');
  assert.equal(receipt.outputSize, fs.statSync(addonPath).size, 'Rebuilt speech addon size changed');
  assert.deepEqual(receipt.compatibility, assertSpeechCompatibility(fs.readFileSync(addonPath), profile, addonPath));
  const libraries = Object.entries(profile.libraryHashes).map(([name, expected]) => {
    const file = path.join(libraryDirectory, name);
    assert.equal(sha256(file), expected, `Pinned speech library differs: ${name}`);
    assertSpeechCompatibility(fs.readFileSync(file), profile, name);
    return { name, sha256: expected };
  });
  assert.deepEqual(receipt.libraries.map(({ name, sha256: digest }) => ({ name, sha256: digest })), libraries, 'Speech receipt libraries changed');
  for (const [name, expected] of Object.entries({ passed: true, electron: profile.electronVersion, abi: profile.electronAbi, nodeApi: 8, version: speechVersion, gitSha1: sourceCommit.slice(0, 8) })) {
    assert.equal(receipt.runtime?.[name], expected, `Speech parity receipt differs: ${name}`);
  }
  assert.deepEqual(receipt.runtime.resampling, { inputSamples: 4096, outputSamples: 1366, bytesMatch: true });
  return receipt;
}

const parityProbe = `
const assert=require('node:assert/strict');
const expected=JSON.parse(process.argv[3]);
assert.equal(process.arch,expected.arch);assert.equal(process.versions.electron,expected.electronVersion);assert.equal(process.versions.modules,expected.modules);
const old=require(process.argv[1]), candidate=require(process.argv[2]);
const keys=Object.keys(old).sort();assert.equal(keys.length,104);assert.deepEqual(Object.keys(candidate).sort(),keys);
for(const key of keys){assert.equal(typeof candidate[key],typeof old[key]);if(typeof old[key]!=='function')assert.deepEqual(candidate[key],old[key]);}
assert.equal(candidate.version,'1.13.8');assert.equal(candidate.gitSha1,'11afbd00');
const input=Float32Array.from({length:4096},(_,index)=>Math.sin(index*0.05)*0.25);
const resample=addon=>{const handle=addon.createLinearResampler(48000,16000);assert.equal(addon.linearResamplerGetInputSampleRate(handle),48000);assert.equal(addon.linearResamplerGetOutputSampleRate(handle),16000);const output=addon.resampleLinear(handle,input,1);assert(output instanceof Float32Array);assert.equal(output.length,1366);assert([...output].every(Number.isFinite));return output;};
assert.deepEqual(resample(old),resample(candidate));
console.log(JSON.stringify({passed:true,electron:process.versions.electron,node:process.versions.node,abi:process.versions.modules,nodeApi:8,exports:keys,version:candidate.version,gitSha1:candidate.gitSha1,onnxruntimeVersion:candidate.onnxruntimeVersion,resampling:{inputSamples:4096,outputSamples:1366,bytesMatch:true}}));
`;

export function prepareMacSpeech(profile) {
  const { arch, electronVersion, originalAddonSha256, libraryHashes, minimumMacOS } = profile;
  const cache = path.join(electronRoot, profile.cacheRelativePath);
  const artifacts = artifactsFor(profile);
  assert.equal(process.platform, 'darwin', 'Speech preparation requires macOS');
  assert.equal(process.arch, arch, 'Speech preparation requires the target native Node runtime');
  assert.equal(arch === 'arm64' ? process.env.MACOSX_DEPLOYMENT_TARGET ?? minimumMacOS : process.env.MACOSX_DEPLOYMENT_TARGET, minimumMacOS);
  const appPackage = readJson(path.join(electronRoot, 'package.json'));
  if (profile.appVersion) assert.equal(appPackage.version, profile.appVersion);
  assert.equal(appPackage.build.mac.minimumSystemVersion, minimumMacOS);
  assert.equal(appPackage.devDependencies.electron, profile.electronDependency);
  assert.equal(require('electron/package.json').version, electronVersion);
  const webRequire = createRequire(require.resolve('@openchamber/web/package.json'));
  const speechRequire = createRequire(webRequire.resolve('sherpa-onnx-node/package.json'));
  const target = path.dirname(speechRequire.resolve(`sherpa-onnx-darwin-${arch}/package.json`));
  assert.equal(readJson(path.join(target, 'package.json')).version, speechVersion);
  assert.equal(webRequire('sherpa-onnx-node/package.json').version, speechVersion);
  const addonPath = path.join(target, 'sherpa-onnx.node');
  if (arch === 'x64') assert.equal(sha256(addonPath), originalAddonSha256, 'Expected the unmodified pinned npm addon before the speech override');
  const installedHeaders = path.dirname(require.resolve('node-addon-api/package.json'));
  assert.equal(readJson(path.join(installedHeaders, 'package.json')).version, '7.1.1');
  const lock = fs.readFileSync(path.join(workspaceRoot, 'bun.lock'), 'utf8').split('\n').find(line => line.includes('"node-addon-api@7.1.1"'));
  assert(lock && lock.includes('sha512-5m3bsyrjFWE1xf7nz7YXdN4udnVtXK6/Yfgn5qnahL6bCkf2yKt4k3nuTKAtT4r3IG8JNR2ncsIMdZuAzJjHQQ=='), 'The build header dependency differs from the workspace lock');
  if (arch === 'arm64') {
    const reused = readReusableSpeechBuild(profile, { addonPath, receiptPath: path.join(electronRoot, 'dist', profile.receiptName), libraryDirectory: target });
    if (reused) {
      console.log(JSON.stringify({ passed: true, reused: true, target: 'darwin-arm64', outputSha256: reused.outputSha256 }));
      return reused;
    }
  }
  fs.mkdirSync(cache, { recursive: true });
  for (const artifact of artifacts) {
    const file = path.join(cache, artifact.name);
    if (!fs.existsSync(file) || sha256(file) !== artifact.sha256) {
      const temporary = `${file}.download-${process.pid}`;
      try {
        run('/usr/bin/curl', ['-fL', '--retry', '2', '--max-time', '150', artifact.url, '-o', temporary]);
        assert.equal(sha256(temporary), artifact.sha256, `Archive checksum differs: ${artifact.name}`);
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    assert.equal(sha256(file), artifact.sha256);
  }
  const staging = fs.mkdtempSync(path.join(cache, 'build-'));
  try {
    const sourceParent = path.join(staging, 'source'), source = path.join(sourceParent, artifacts[0].root);
    extract(cache, artifacts[0], sourceParent, [`${artifacts[0].root}/scripts/node-addon-api`, `${artifacts[0].root}/harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp`, `${artifacts[0].root}/sherpa-onnx/c-api/c-api.h`]);
    extract(cache, artifacts[1], path.join(staging, 'headers'));
    extract(cache, artifacts[2], path.join(staging, 'addon-api'));
    for (const name of ['napi.h', 'napi-inl.h', 'napi-inl.deprecated.h']) assert.equal(sha256(path.join(installedHeaders, name)), sha256(path.join(staging, 'addon-api/package', name)), `Installed Node-API header differs: ${name}`);
    const original = path.join(staging, 'original'), candidate = path.join(staging, 'candidate');
    fs.mkdirSync(original); fs.mkdirSync(candidate);
    fs.copyFileSync(addonPath, path.join(original, 'sherpa-onnx.node'));
    const libraries = Object.entries(libraryHashes).map(([name, expected]) => {
      const file = path.join(target, name); assert.equal(sha256(file), expected, `Pinned speech library differs: ${name}`);
      const compatibility = assertSpeechCompatibility(fs.readFileSync(file), profile, name);
      fs.copyFileSync(file, path.join(original, name)); fs.copyFileSync(file, path.join(candidate, name));
      return { name, sha256: expected, ...compatibility };
    });
    const sourceDirectory = path.join(source, 'scripts/node-addon-api/src');
    const sourceNames = fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.cc')).sort();
    assert.equal(sourceNames.length, 18);
    const sourceFiles = sourceNames.map(name => {
      const file = path.join(sourceDirectory, name), relative = path.relative(source, fs.realpathSync(file));
      assert(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), `Build source escapes archive: ${name}`);
      return { path: `scripts/node-addon-api/src/${name}`, sha256: sha256(file) };
    });
    const built = path.join(candidate, 'sherpa-onnx.node');
    const flags = speechCompilerArguments(profile, { source, nodeHeaders: path.join(staging, 'headers/node_headers/include/node'), addonHeaders: installedHeaders, sourceFiles: sourceNames.map(name => path.join(sourceDirectory, name)), libraries: candidate, output: built });
    run('/usr/bin/xcrun', flags);
    const compatibility = assertSpeechCompatibility(fs.readFileSync(built), profile, 'rebuilt speech addon');
    const parity = JSON.parse(run(require('electron'), ['-e', parityProbe, path.join(original, 'sherpa-onnx.node'), built, JSON.stringify({ arch, electronVersion, modules: profile.electronAbi })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim());
    assert.equal(parity.passed, true);
    for (const library of libraries) assert.equal(sha256(path.join(target, library.name)), library.sha256);
    assert.equal(sha256(addonPath), originalAddonSha256, 'The target addon changed during compilation');
    const outputSha256 = sha256(built), temporary = path.join(target, `.sherpa-onnx.node.${arch === 'x64' ? 'intel' : 'arm64'}-${process.pid}`);
    try { fs.copyFileSync(built, temporary); fs.chmodSync(temporary, 0o755); fs.renameSync(temporary, addonPath); }
    finally { fs.rmSync(temporary, { force: true }); }
    assert.equal(sha256(addonPath), outputSha256);
    const receipt = { schemaVersion: 1, passed: true, staged: true, verifiedAt: new Date().toISOString(), target: `darwin-${arch}`, sourceCommit, speechVersion, electronVersion, nodeAddonApiVersion: '7.1.1', minimumMacOS: `${minimumMacOS}.0`, originalAddonSha256, outputSha256, outputSize: fs.statSync(addonPath).size, compatibility, artifacts: artifacts.map(({ name, url, sha256: digest }) => ({ name, url, sha256: digest })), sourceFiles, libraries, runtime: parity, compiler: run('/usr/bin/xcrun', ['clang++', '--version']).trim(), limits: [`The addon is rebuilt against unchanged pinned libraries; model-based speech recognition and macOS${minimumMacOS} hardware acceptance are separate checks.`] };
    if (arch === 'arm64') receipt.compileOptions = speechCompilerOptions(profile);
    fs.mkdirSync(path.join(electronRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(electronRoot, 'dist', profile.receiptName), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify({ passed: true, sourceCommit, target: `darwin-${arch}`, outputSha256, exports: parity.exports.length, minimumMacOS: receipt.minimumMacOS }));
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
