import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const X64 = 0x01000007;
const VERSION = '2.7.39-intel';
const ELECTRON = '43.8.4';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const versionText = version => `${version >>> 16}.${(version >>> 8) & 255}.${version & 255}`;
const machOMagic = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

export function readMachOSlices(bytes) {
  assert(bytes.length >= 4, 'Truncated Mach-O magic');
  const magic = bytes.readUInt32BE(0);
  assert(machOMagic.has(magic), 'Expected a Mach-O binary');
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    assert(bytes.length >= 8, 'Truncated universal Mach-O header');
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    const u32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const u64 = offset => Number(little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset));
    const count = u32(4), entrySize = wide ? 32 : 20, end = 8 + count * entrySize;
    assert(count > 0 && count <= 32 && end <= bytes.length, 'Invalid universal Mach-O architecture table');
    const ranges = [], cpus = new Set(), slices = [];
    for (let index = 0; index < count; index++) {
      const base = 8 + index * entrySize, cpu = u32(base);
      const offset = wide ? u64(base + 8) : u32(base + 8);
      const size = wide ? u64(base + 16) : u32(base + 12);
      assert(!cpus.has(cpu), 'Duplicate universal Mach-O architecture');
      assert(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= end && size >= 28 && offset <= bytes.length - size, 'Invalid universal Mach-O slice bounds');
      assert(ranges.every(range => offset >= range.end || offset + size <= range.start), 'Overlapping universal Mach-O slices');
      ranges.push({ start: offset, end: offset + size }); cpus.add(cpu);
      const payload = bytes.subarray(offset, offset + size);
      assert(![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(payload.readUInt32BE()), 'Nested universal Mach-O slice');
      const thin = readMachOSlices(payload);
      assert.equal(thin.length, 1); assert.equal(thin[0].cpu, cpu, 'Universal Mach-O CPU differs from its slice');
      slices.push(...thin);
    }
    return slices;
  }
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const u32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const headerSize = wide ? 32 : 28;
  assert(bytes.length >= headerSize, 'Truncated Mach-O header');
  const count = u32(16), size = u32(20), end = headerSize + size;
  assert(count > 0 && count <= 4096 && size >= count * 8 && end <= bytes.length, 'Invalid Mach-O load-command table');
  let offset = headerSize;
  const minimumVersions = [];
  for (let index = 0; index < count; index++) {
    assert(offset <= end - 8, 'Truncated Mach-O load command');
    const command = u32(offset), commandSize = u32(offset + 4);
    assert(commandSize >= 8 && commandSize % 4 === 0 && offset <= end - commandSize, 'Invalid Mach-O load-command bounds');
    if (command === 0x24) {
      assert(commandSize >= 16, 'Truncated minimum-macOS load command');
      minimumVersions.push(u32(offset + 8));
    } else if (command === 0x32) {
      assert(commandSize >= 24 && commandSize >= 24 + u32(offset + 20) * 8, 'Truncated build-version load command');
      assert.equal(u32(offset + 8), 1, 'Mach-O build platform is not macOS');
      minimumVersions.push(u32(offset + 12));
    }
    offset += commandSize;
  }
  assert.equal(offset, end, 'Mach-O load-command sizes disagree');
  assert(minimumVersions.length > 0 && minimumVersions.every(value => value > 0), 'Mach-O has no declared minimum macOS');
  return [{ cpu: u32(4), minimumVersion: Math.max(...minimumVersions) }];
}

export function assertIntelCompatibility(bytes, name = 'binary') {
  const slices = readMachOSlices(bytes);
  const intel = slices.find(slice => slice.cpu === X64);
  assert(intel, `No Intel x86_64 slice: ${name}`);
  assert(intel.minimumVersion <= (12 << 16), `Minimum macOS exceeds 12.0: ${name} requires ${versionText(intel.minimumVersion)}`);
  return { minimumMacOS: versionText(intel.minimumVersion), architectures: slices.map(slice => slice.cpu === X64 ? 'x64' : `cpu-${slice.cpu.toString(16)}`) };
}

function inventory(directory) {
  const files = [];
  const boundary = fs.realpathSync(directory);
  const visit = (folder, prefix = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file, relative);
      else if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(file), target = fs.realpathSync(file), outside = path.relative(boundary, target);
        assert(!path.isAbsolute(link) && outside !== '..' && !outside.startsWith(`..${path.sep}`) && !path.isAbsolute(outside), `Package symlink escapes boundary: ${relative}`);
        files.push({ path: relative, link });
      } else {
        assert(entry.isFile(), `Unsupported package entry: ${relative}`);
        const bytes = fs.readFileSync(file);
        files.push({ path: relative, size: bytes.length, mode: fs.statSync(file).mode & 0o777, sha256: hash(bytes) });
      }
    }
  };
  visit(directory);
  return files;
}

function openAsar(file) {
  const bytes = fs.readFileSync(file);
  assert(bytes.length >= 16, 'Truncated ASAR header');
  const headerLength = bytes.readUInt32LE(12), contentOffset = 8 + bytes.readUInt32LE(4);
  assert(headerLength > 0 && 16 + headerLength <= contentOffset && contentOffset <= bytes.length, 'Invalid ASAR header bounds');
  const header = JSON.parse(bytes.subarray(16, 16 + headerLength).toString('utf8')), entries = new Map();
  function visit(node, prefix = '') {
    assert(node.files && Object.getPrototypeOf(node.files) === Object.prototype, 'Invalid ASAR directory');
    for (const [name, entry] of Object.entries(node.files)) {
      assert(name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'), 'Unsafe ASAR name');
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entry.files) visit(entry, relative);
      else {
        assert(!entry.link, `Unexpected ASAR link: ${relative}`);
        assert(Number.isSafeInteger(entry.size) && entry.size >= 0, 'Invalid ASAR entry size');
        entries.set(relative, entry);
      }
    }
  }
  visit(header);
  const read = name => {
    const entry = entries.get(name); assert(entry, `Missing ASAR file: ${name}`);
    if (entry.unpacked) return fs.readFileSync(path.join(`${file}.unpacked`, name));
    const offset = Number(entry.offset);
    assert(Number.isSafeInteger(offset) && offset >= 0 && contentOffset + offset <= bytes.length - entry.size, `Invalid ASAR entry bounds: ${name}`);
    return bytes.subarray(contentOffset + offset, contentOffset + offset + entry.size);
  };
  return { read, entries };
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).map(argument => {
    const match = /^--(app|receipt|source|ci-receipt)=(.+)$/.exec(argument); assert(match, `Unknown option: ${argument}`); return [match[1], match[2]];
  }));
  assert(options.app && options.receipt, 'Required: --app=path --receipt=path');
  const root = process.cwd();
  const app = path.resolve(options.app), resources = path.join(app, 'Contents/Resources');
  const source = options.source || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert(/^[a-f0-9]{40}$/.test(source), 'Expected immutable source SHA');
  const plist = file => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
  const info = plist(path.join(app, 'Contents/Info.plist'));
  assert.equal(info.CFBundleShortVersionString, VERSION, 'Finder app version differs from the compatibility package');
  assert.equal(info.CFBundleIdentifier, 'com.quukk.superwagie');
  assert.equal(info.LSMinimumSystemVersion, '12.0');
  const framework = plist(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist'));
  assert.equal(framework.CFBundleVersion, ELECTRON);
  const asar = openAsar(path.join(resources, 'app.asar'));
  const appPackage = JSON.parse(asar.read('package.json')), webPackage = JSON.parse(asar.read('node_modules/@openchamber/web/package.json'));
  assert.equal(appPackage.version, VERSION); assert.equal(webPackage.version, VERSION);
  const sourceNames = ['platform-model/store.js', 'platform-model/writer-lock.js', 'platform-model/runtime.js', 'conversation-memory/runtime.js', 'conversation-memory/extractor.js', 'conversation-memory/methodology.js', 'hy-memory/results.js'];
  const sourceFiles = sourceNames.map(name => {
    const file = `packages/web/server/lib/${name}`;
    const bytes = execFileSync('git', ['show', `${source}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    assert(asar.read(`node_modules/@openchamber/web/server/lib/${name}`).equals(bytes), `Frozen source mismatch: ${file}`);
    return { path: file, sha256: hash(bytes), size: bytes.length };
  });
  assert.equal(appPackage.superwagieClientMode, 'remote-client');
  const mode = JSON.parse(fs.readFileSync(path.join(resources, 'desktop-mode.json')));
  assert.deepEqual(mode, { mode: 'remote-client' });
  for (const directory of ['opencode-cli', 'ripgrep', 'embedded-knowledge', 'hy-memory', 'superweb', 'windows-diagnostics']) assert(!fs.existsSync(path.join(resources, directory)), `Unexpected local service resource: ${directory}`);
  const files = inventory(app), native = [];
  const inspect = (bytes, name) => {
    if (bytes.length >= 4 && machOMagic.has(bytes.readUInt32BE())) native.push({ path: name, ...assertIntelCompatibility(bytes, name) });
  };
  for (const file of files) if (file.link === undefined) inspect(fs.readFileSync(path.join(app, file.path)), file.path);
  for (const [name, entry] of asar.entries) if (!entry.unpacked) inspect(asar.read(name), `Contents/Resources/app.asar/${name}`);
  for (const required of ['Contents/MacOS/', '/Electron Framework']) assert(native.some(file => file.path.includes(required)), `Missing native shell: ${required}`);
  for (const file of native) assert(file.path.startsWith('Contents/MacOS/') || file.path.startsWith('Contents/Frameworks/'), `Unexpected local engine binary: ${file.path}`);
  for (const name of asar.entries.keys()) assert(!/\/node_modules\/(?:node-pty|bun-pty|sherpa-onnx[^/]*)(?:\/|$)/.test('/'+name), `Local native dependency remains: ${name}`);
  const uiFiles = files.filter(file => file.path.startsWith('Contents/Resources/web-dist/') && file.path.endsWith('.js'));
  const markers = ['superwagie.unihub.login-username.v1:', 'SuperWagie memory engine · {state}', 'SuperWagie 记忆引擎 · {state}'];
  const foundMarkers = new Set();
  for (const file of uiFiles) {
    const text = fs.readFileSync(path.join(app, file.path), 'utf8');
    for (const marker of markers) if (text.includes(marker)) foundMarkers.add(marker);
    assert(!text.includes('Memory engine {name} {version}') && !text.includes('记忆引擎 {name} {version}'), `Old visible engine template: ${file.path}`);
  }
  assert.equal(foundMarkers.size, markers.length, 'Missing username cache or memory engine labels');
  if (options['ci-receipt']) {
    const ci = JSON.parse(fs.readFileSync(options['ci-receipt']));
    assert.equal(ci.sourceCommit, source); assert.equal(ci.version, VERSION); assert.equal(ci.passed, true);
    assert.deepEqual(files, ci.files, 'Actual installer differs from the CI package inventory');
  } else {
    assert.deepEqual(inventory(path.join(resources, 'web-dist')), inventory(path.join(root, 'packages/electron/resources/web-dist')), 'Staged/package UI mismatch');
    for (const name of ['dist-bundle/entry.mjs', 'dist-bundle/main.mjs', 'dist-bundle/early-startup.mjs', 'preload.mjs', 'browser-panel-preload.cjs']) assert(asar.read(name).equals(fs.readFileSync(path.join(root, 'packages/electron', name))), `Staged/package Electron bundle mismatch: ${name}`);
  }
  const receipt = { schemaVersion: 1, passed: true, verifiedAt: new Date().toISOString(), sourceCommit: source, version: VERSION, target: 'darwin-x64', mode: 'remote-client', electronVersion: ELECTRON, minimumSystemVersion: info.LSMinimumSystemVersion, bundleVersion: info.CFBundleShortVersionString, asarSha256: hash(fs.readFileSync(path.join(resources, 'app.asar'))), sourceFiles, native, files, productMarkers: [...foundMarkers].sort(), oldVisibleEngineStatusAbsent: true, limits: ['Remote SuperWagie service hosts OpenCode and owns project, knowledge and memory data', 'Mach-O deployment targets and package bytes are checked here; macOS 12 hardware acceptance remains separate'] };
  fs.mkdirSync(path.dirname(path.resolve(options.receipt)), { recursive: true });
  fs.writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, sourceCommit: source, version: VERSION, files: files.length, nativeFiles: native.length, receipt: options.receipt }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
