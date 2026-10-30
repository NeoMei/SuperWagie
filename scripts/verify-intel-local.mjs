import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyHyMemoryResources } from '../packages/electron/scripts/prepare-hy-memory.mjs';
import { canReuseStagedKnowledge } from '../packages/electron/scripts/prepare-embedded-knowledge.mjs';
import { assertIntelCompatibility } from './verify-intel-compat.mjs';

const VERSION = '2.7.40-intel';
const ELECTRON = '43.8.4';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const machOMagic = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

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

export function stagedResourceInventory(directory) {
  return inventory(directory).filter(file => {
    if (file.path !== '.gitkeep') return true;
    assert.equal(file.size, 0, 'The source placeholder must be empty');
    assert.equal(file.sha256, hash(Buffer.alloc(0)), 'The source placeholder changed');
    return false;
  });
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
    if (argument === '--installed-only') return ['installed-only', true];
    const match = /^--(app|receipt|source|ci-receipt)=(.+)$/.exec(argument); assert(match, `Unknown option: ${argument}`); return [match[1], match[2]];
  }));
  assert(options.app && options.receipt, 'Required: --app=path --receipt=path');
  assert(!(options['installed-only'] && options['ci-receipt']), 'Choose initial installed-payload validation or comparison with a previous receipt');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  const sourceNames = ['platform-model/store.js', 'platform-model/writer-lock.js', 'platform-model/runtime.js', 'conversation-memory/runtime.js', 'conversation-memory/extractor.js', 'conversation-memory/methodology.js', 'hy-memory/results.js', 'opencode/bundled-runtime.js', 'opencode/env-runtime.js', 'opencode/model-configuration-env.js', 'knowledge-library/runtime.js'];
  const sourceFiles = sourceNames.map(name => {
    const file = `packages/web/server/lib/${name}`;
    const bytes = execFileSync('git', ['show', `${source}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    assert(asar.read(`node_modules/@openchamber/web/server/lib/${name}`).equals(bytes), `Frozen source mismatch: ${file}`);
    return { path: file, sha256: hash(bytes), size: bytes.length };
  });
  assert.notEqual(appPackage.superwagieClientMode, 'remote-client');
  assert(!fs.existsSync(path.join(resources, 'desktop-mode.json')), 'Local distribution must not carry remote-only metadata');
  const engineRoot = path.join(resources, 'opencode-cli');
  const engine = JSON.parse(fs.readFileSync(path.join(engineRoot, 'manifest.json'), 'utf8'));
  assert.equal(engine.platform, 'darwin'); assert.equal(engine.arch, 'x64');
  assert.equal(engine.version, '2.1.4'); assert.equal(engine.binary, 'opencode');
  assert.equal(engine.sourceCommit, '68bc26b7da1990ce10ffecfbc1e09eb13aa5d824');
  assert.equal(engine.runtime.kind, 'electron-node24'); assert.equal(engine.runtime.serverOnly, true);
  for (const name of ['opencode', 'node']) {
    const file = path.join(engineRoot, name), text = fs.readFileSync(file, 'utf8');
    assert(text.startsWith('#!/bin/sh\n'), `Expected a fixed shell launcher: ${name}`);
    assert((fs.statSync(file).mode & 0o111) !== 0, `Launcher is not executable: ${name}`);
    assert(!text.includes('/tmp/') && !text.includes('/Users/') && !text.includes('/home/runner/'), `Build host path in launcher: ${name}`);
  }
  for (const name of ['runtime-init.mjs', 'opencode.mjs', 'LICENSE.opencode', 'third-party-licenses.json']) assert(fs.statSync(path.join(engineRoot, name)).isFile(), `Missing local engine file: ${name}`);
  const engineInventory = inventory(engineRoot).filter(file => file.path !== 'manifest.json');
  assert(engineInventory.every(file => !file.link), 'Unexpected engine symlink');
  assert(Array.isArray(engine.files) && engine.files.length === engineInventory.length, 'Engine inventory is incomplete');
  assert.equal(new Set(engine.files.map(file => file.path)).size, engineInventory.length, 'Duplicate engine inventory entry');
  for (const file of engineInventory) {
    const entry = engine.files.find(entry => entry.path === file.path);
    assert(entry, `Engine manifest omits ${file.path}`);
    assert.equal(entry.size, file.size, `Engine file size differs: ${file.path}`);
    assert.equal(entry.sha256, file.sha256, `Engine file checksum differs: ${file.path}`);
  }
  const hy = verifyHyMemoryResources(path.join(resources, 'hy-memory'), { target: 'darwin-x64' });
  assert.equal(hy.runtimeVerified, true);
  const hyPrefix = 'packages/web/server/lib/hy-memory/';
  const hySourcePaths = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', source, '--', `${hyPrefix}python`, `${hyPrefix}vendor`, `${hyPrefix}requirements.txt`], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter(file => file && !file.split('/').some(segment => segment === 'tests' || segment === '__pycache__') && !/\.(?:pyc|pyo)$/.test(file));
  const hySourceFiles = hy.files.filter(file => file.path.startsWith('python/') || file.path.startsWith('vendor/') || file.path === 'requirements.txt');
  assert.equal(hySourceFiles.length, hySourcePaths.length, 'Packaged memory source file count differs from frozen Git');
  for (const file of hySourcePaths) {
    const relative = file.slice(hyPrefix.length), entry = hySourceFiles.find(item => item.path === relative);
    assert(entry, `Missing frozen memory source: ${relative}`);
    const bytes = execFileSync('git', ['show', `${source}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(entry.sha256, hash(bytes), `Frozen memory source mismatch: ${file}`); assert.equal(entry.size, bytes.length);
  }
  const knowledge = JSON.parse(fs.readFileSync(path.join(resources, 'embedded-knowledge/manifest.json')));
  assert(canReuseStagedKnowledge({ manifest: knowledge, directory: path.join(resources, 'embedded-knowledge'), binaryName: 'embedded-knowledge-server', repository: 'https://github.com/NeoMei/embedded-knowledge', ref: 'embedded-knowledge', pinnedCommit: 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f', tags: 'sqlite_fts5,anydoc', platform: 'darwin' }), 'Incomplete or stale knowledge backend');
  const files = inventory(app), native = [];
  const inspect = (bytes, name) => {
    if (bytes.length >= 4 && machOMagic.has(bytes.readUInt32BE())) native.push({ path: name, ...assertIntelCompatibility(bytes, name) });
  };
  for (const file of files) if (file.link === undefined) inspect(fs.readFileSync(path.join(app, file.path)), file.path);
  for (const [name, entry] of asar.entries) if (!entry.unpacked) inspect(asar.read(name), `Contents/Resources/app.asar/${name}`);
  for (const required of ['Contents/MacOS/', '/Electron Framework', '/ripgrep/rg', '/embedded-knowledge/embedded-knowledge-server', '/hy-memory/runtime/bin/python', 'pty.node', 'sherpa-onnx.node', '/superweb/']) {
    assert(native.some(file => file.path.includes(required)), `Missing native payload: ${required}`);
  }
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
  } else if (!options['installed-only']) {
    for (const name of ['web-dist', 'opencode-cli', 'ripgrep', 'embedded-knowledge', 'hy-memory', 'superweb']) {
      const staged = stagedResourceInventory(path.join(root, 'packages/electron/resources', name));
      assert.deepEqual(inventory(path.join(resources, name)), staged, `Staged/package resource mismatch: ${name}`);
    }
    for (const name of ['dist-bundle/entry.mjs', 'dist-bundle/main.mjs', 'dist-bundle/early-startup.mjs', 'preload.mjs', 'browser-panel-preload.cjs']) assert(asar.read(name).equals(fs.readFileSync(path.join(root, 'packages/electron', name))), `Staged/package Electron bundle mismatch: ${name}`);
  }
  const receipt = { schemaVersion: 1, passed: true, validationInputs: { frozenSource: true, stagedResourcesCompared: !options['installed-only'] && !options['ci-receipt'], previousInventoryCompared: Boolean(options['ci-receipt']) }, verifiedAt: new Date().toISOString(), sourceCommit: source, version: VERSION, target: 'darwin-x64', electronVersion: ELECTRON, minimumSystemVersion: info.LSMinimumSystemVersion, bundleVersion: info.CFBundleShortVersionString, asarSha256: hash(fs.readFileSync(path.join(resources, 'app.asar'))), sourceFiles, native, files, hy: { sourceSha256: hy.sourceSha256, sourceFiles: hySourceFiles.length, sourceBytesMatch: true, runtimeVerified: hy.runtimeVerified, files: hy.files.length }, knowledge, engine, productMarkers: [...foundMarkers].sort(), oldVisibleEngineStatusAbsent: true, limits: ['Mach-O deployment targets and package bytes are checked here; native runtime execution and macOS 12 hardware acceptance are separate checks.'] };
  fs.mkdirSync(path.dirname(path.resolve(options.receipt)), { recursive: true });
  fs.writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, sourceCommit: source, version: VERSION, files: files.length, nativeFiles: native.length, receipt: options.receipt }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
