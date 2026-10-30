const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { readAsarFiles, findPackagedAppContentProblems, verifyPackagedAppContents } = require('./packaged-app-contents.cjs');
const afterPack = require('./after-pack.cjs');
const crypto = require('node:crypto');

const web = 'node_modules/@openchamber/web';
const helpers = [
  `${web}/server/lib/git/credential-helper.js`,
  `${web}/server/lib/git/ssh-wrapper.js`,
  `${web}/server/lib/git/repository-credential-helper.js`,
];
const builtinRoot = path.resolve(__dirname, '../../web/server/builtin-skills');
const builtinMarkdown = fs.readdirSync(builtinRoot, { recursive: true })
  .filter((name) => name.endsWith('.md') && !name.split(path.sep).includes('node_modules'))
  .map((name) => `${web}/server/builtin-skills/${name.split(path.sep).join('/')}`);
const supervideoPayload = ['engine-manifest.json',
  ...JSON.parse(fs.readFileSync(path.join(builtinRoot, 'supervideo-engine/engine-manifest.json'), 'utf8')).files.map((file) => file.path),
].map((name) => `${web}/server/builtin-skills/supervideo-engine/${name}`);

const completeApp = () => [
  ...['dist-bundle/entry.mjs', 'dist-bundle/main.mjs', 'dist-bundle/early-startup.mjs', 'preload.mjs', 'browser-panel-preload.cjs', 'package.json'],
  `${web}/package.json`,
  `${web}/server/index.js`,
  ...builtinMarkdown,
  ...supervideoPayload,
].map((filePath) => ({ path: filePath, unpacked: false }))
  .concat(helpers.map((filePath) => ({ path: filePath, unpacked: true })));

const writeAsar = (directory, header) => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(json.length + 8, 4);
  prefix.writeUInt32LE(json.length + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  const asarPath = path.join(directory, 'app.asar');
  fs.writeFileSync(asarPath, Buffer.concat([prefix, json]));
  return asarPath;
};

test('a complete app has no problems', () => {
  assert.deepEqual(findPackagedAppContentProblems(completeApp()), []);
});

test('the web build output inside the archive is rejected', () => {
  const files = [...completeApp(), { path: `${web}/dist/assets/index.js`, unpacked: false }];
  assert.deepEqual(findPackagedAppContentProblems(files), [`${web}/dist must not be packaged (1 files found)`]);
});

test('ripgrep platform packages inside the archive are rejected', () => {
  const files = [...completeApp(), { path: 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg', unpacked: false }];
  assert.deepEqual(findPackagedAppContentProblems(files), [
    '@vscode/ripgrep platform packages must not be packaged (1 files found); the binary ships in Resources/ripgrep',
  ]);
  assert.deepEqual(findPackagedAppContentProblems([...completeApp(), { path: 'node_modules/@vscode/ripgrep/lib/index.js', unpacked: false }]), []);
});

test('files copied from outside the allowlist are rejected', () => {
  const files = [...completeApp(), ...['main.mjs', '.cache/opencode-cli/opencode'].map((filePath) => ({ path: filePath, unpacked: false }))];
  assert.deepEqual(findPackagedAppContentProblems(files), ['2 unexpected files outside node_modules (main.mjs, .cache/opencode-cli/opencode)']);
});

test('a missing server entry or a packed git helper is reported', () => {
  const files = completeApp()
    .filter((file) => file.path !== `${web}/server/index.js`)
    .map((file) => (file.path === helpers[0] ? { ...file, unpacked: false } : file));
  assert.deepEqual(findPackagedAppContentProblems(files), [
    `${web}/server/index.js is missing`,
    `${helpers[0]} must be unpacked from the asar`,
  ]);
});

test('missing SuperVideo lock and render sources are rejected before shipping', () => {
  for (const relative of ['package-lock.json', 'src/render/Root.tsx', 'src/render/Scene.tsx',
    'src/render/components.tsx', 'src/render/index.tsx', 'src/render/preview.tsx']) {
    const missing = `${web}/server/builtin-skills/supervideo-engine/${relative}`;
    assert.deepEqual(findPackagedAppContentProblems(completeApp().filter((file) => file.path !== missing)), [
      `${missing} is missing`,
    ]);
  }
});

test('reads nested files and the unpacked flag from an asar header', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-asar-'));
  try {
    const asarPath = writeAsar(directory, {
      files: {
        'preload.mjs': { size: 1, offset: '0' },
        node_modules: { files: { pkg: { files: { 'index.js': { size: 1, unpacked: true } } } } },
      },
    });
    assert.deepEqual(readAsarFiles(asarPath), [
      { path: 'preload.mjs', unpacked: false },
      { path: 'node_modules/pkg/index.js', unpacked: true },
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('normalized file sets preserve built-in instructions and SuperVideo payload while excluding other dependency sources', async (t) => {
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const { doMergeConfigs } = builderRequire('app-builder-lib/out/util/config/config');
  const { FileMatcher, getFileMatchers, getNodeModuleFileMatcher } = builderRequire('app-builder-lib/out/fileMatcher');
  const { computeFileSets, getDestinationPath } = builderRequire('app-builder-lib/out/util/appFileCopier');
  const { NodeModuleCopyHelper } = builderRequire('app-builder-lib/out/util/NodeModuleCopyHelper');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-builtin-markdown-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appDirectory = path.join(directory, 'packages/electron');
  const entries = [
    `${web}/server/builtin-skills/skills/grilling/SKILL.md`,
    `${web}/server/builtin-skills/skills/superwriter/references/chapters.md`,
    `${web}/server/builtin-skills/superppt/skills/superppt/SKILL.md`,
    `${web}/server/builtin-skills/superppt/src/source.ts`,
    `${web}/server/builtin-skills/supervideo-engine/package-lock.json`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/Root.tsx`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/Scene.tsx`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/components.tsx`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/index.tsx`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/preview.tsx`,
    `${web}/server/other.md`,
    `${web}/other.md`,
    'node_modules/third-party/package-lock.json',
    'node_modules/third-party/source.tsx',
    'node_modules/third-party/guide.md',
    'node_modules/third-party/LICENSE.md',
  ];
  for (const entry of entries) {
    const file = path.join(appDirectory, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
    if (entry.startsWith(`${web}/`)) {
      const source = path.join(directory, 'packages/web', entry.slice(web.length + 1));
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, 'fixture');
    }
  }
  const nestedDependency = path.join(directory, 'packages/web/server/builtin-skills/skills/superweb/node_modules/third-party/guide.md');
  fs.mkdirSync(path.dirname(nestedDependency), { recursive: true });
  fs.writeFileSync(nestedDependency, 'excluded dependency docs');
  const engineDependency = path.join(directory, 'packages/web/server/builtin-skills/supervideo-engine/node_modules/third-party/source.tsx');
  fs.mkdirSync(path.dirname(engineDependency), { recursive: true });
  fs.writeFileSync(engineDependency, 'excluded dependency source');
  const destination = path.join(directory, 'output');
  const packager = {
    config: doMergeConfigs([structuredClone(require('../package.json').build)]),
    debugLogger: { isEnabled: false },
    appInfo: { type: 'module' },
    getWorkspaceRoot: async () => directory,
  };
  const expand = (value) => value.replaceAll('${platform}', 'darwin').replaceAll('${arch}', 'arm64');
  const included = [];
  const fileMatchers = getFileMatchers(packager.config, 'files', destination, {
    defaultSrc: appDirectory, macroExpander: expand, customBuildOptions: {}, globalOutDir: destination,
  });
  const fileSets = await computeFileSets(fileMatchers, null, { info: packager }, false);
  for (const fileSet of fileSets) {
    included.push(...fileSet.files.filter((file) => fileSet.metadata.get(file)?.isFile())
      .map((file) => path.relative(destination, getDestinationPath(file, fileSet)).split(path.sep).join('/')));
  }
  const mainMatcher = getNodeModuleFileMatcher(appDirectory, destination, expand, {}, packager);
  for (const name of ['@openchamber/web', 'third-party']) {
    const moduleRoot = path.join(appDirectory, 'node_modules', name);
    const matcher = new FileMatcher(moduleRoot, path.join(destination, 'node_modules', name), expand, mainMatcher.patterns);
    const copier = new NodeModuleCopyHelper(matcher, packager);
    const files = await copier.collectNodeModules({ name, dir: moduleRoot }, [], `node_modules/${name}`);
    included.push(...files.map((file) => path.relative(appDirectory, file).split(path.sep).join('/')));
  }
  assert.deepEqual(included.sort(), [
    `${web}/server/builtin-skills/skills/grilling/SKILL.md`,
    `${web}/server/builtin-skills/skills/superwriter/references/chapters.md`,
    `${web}/server/builtin-skills/superppt/skills/superppt/SKILL.md`,
    `${web}/server/builtin-skills/supervideo-engine/package-lock.json`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/Root.tsx`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/Scene.tsx`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/components.tsx`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/index.tsx`,
    `${web}/server/builtin-skills/supervideo-engine/src/render/preview.tsx`,
    'node_modules/third-party/LICENSE.md',
  ].sort());
});

test('afterPack rejects missing built-in skill instructions and referenced Markdown', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-after-pack-builtin-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const resources = path.join(directory, 'resources');
  const hyDirectory = path.join(resources, 'hy-memory');
  const hyFiles = ['python/worker.py', 'runtime/bin/python3'];
  for (const file of hyFiles) {
    fs.mkdirSync(path.dirname(path.join(hyDirectory, file)), { recursive: true });
    fs.writeFileSync(path.join(hyDirectory, file), 'fixture');
  }
  fs.writeFileSync(path.join(hyDirectory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, target: 'linux-x64',
    files: hyFiles.map((file) => ({ path: file, sha256: require('node:crypto').createHash('sha256').update('fixture').digest('hex'), size: 7 })) }));
  fs.mkdirSync(path.join(resources, 'ripgrep'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'ripgrep', process.platform === 'win32' ? 'rg.exe' : 'rg'), 'fixture');
  for (const helper of helpers) {
    const file = path.join(resources, 'app.asar.unpacked', helper);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  const writePackage = (missing) => {
    const header = { files: {} };
    for (const file of completeApp().filter((entry) => entry.path !== missing)) {
      const parts = file.path.split('/');
      const name = parts.pop();
      let parent = header;
      for (const part of parts) parent = parent.files[part] ??= { files: {} };
      parent.files[name] = { size: 1, offset: '0', unpacked: file.unpacked };
    }
    writeAsar(resources, header);
  };
  const context = { electronPlatformName: 'linux', appOutDir: directory, arch: 1 };
  writePackage();
  assert.throws(() => afterPack(context), /embedded.knowledge/i);
  const knowledge = path.join(resources, 'embedded-knowledge');
  fs.mkdirSync(path.join(knowledge, 'config'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'migrations', 'sqlite'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'LICENSE'), 'fixture');
  fs.writeFileSync(path.join(knowledge, 'config', 'config.yaml'), 'fixture');
  fs.writeFileSync(path.join(knowledge, 'migrations', 'sqlite', '001.sql'), 'fixture');
  const binary = Buffer.alloc(64); binary.write('\x7fELF', 0, 'latin1'); binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(62, 18);
  fs.writeFileSync(path.join(knowledge, 'embedded-knowledge-server'), binary);
  fs.writeFileSync(path.join(knowledge, 'manifest.json'), JSON.stringify({ binary: 'embedded-knowledge-server', repository: 'https://github.com/NeoMei/embedded-knowledge', ref: 'cd90b9a57abe85ad498e59b9be74e2748110c353', commit: 'cd90b9a57abe85ad498e59b9be74e2748110c353', tags: 'sqlite_fts5,anydoc', binarySha256: crypto.createHash('sha256').update(binary).digest('hex'), anydocSource: { version: '0.2.4', sourceSha256: 'cf0d78e4cfe3654eb3ea04422ec5a94352000ee56e97902125e68e51f7527062', patchedTreeSha256: 'a9641c5da12abbc3f492e75f6140d7e2c57a78edd012110c57ed6836cb221cde' } }));
  assert.doesNotThrow(() => afterPack(context));
  const hyManifest = path.join(hyDirectory, 'manifest.json');
  const hyManifestBytes = fs.readFileSync(hyManifest);
  fs.unlinkSync(hyManifest);
  assert.throws(() => afterPack(context), (error) => error.code === 'ENOENT' && error.path === hyManifest);
  fs.writeFileSync(hyManifest, hyManifestBytes);
  assert.throws(() => afterPack({ ...context, arch: 3 }), /architecture/i);
  assert.throws(() => afterPack({ ...context, packager: { config: { extraMetadata: { superwagieClientMode: 'remote-client' } } } }),
    /Remote compatibility packaging requires macOS x64/);
  for (const missing of [
    `${web}/server/builtin-skills/skills/grilling/SKILL.md`,
    `${web}/server/builtin-skills/skills/superwriter/references/门禁清单.md`,
    `${web}/server/builtin-skills/superppt/skills/superppt/SKILL.md`,
  ]) {
    assert.ok(builtinMarkdown.includes(missing), `Fixture Markdown must exist: ${missing}`);
    writePackage(missing);
    assert.throws(() => afterPack(context), (error) => error.message.includes(`${missing} is missing`));
  }
});

test('remote clients require their mode and UI, and refuse local native payloads', (t) => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-remote-package-'));
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const writePackage = (extra = []) => {
    const header = { files: {} };
    for (const file of [...completeApp(), ...extra]) {
      const parts = file.path.split('/');
      const name = parts.pop();
      let directory = header;
      for (const part of parts) directory = directory.files[part] ??= { files: {} };
      directory.files[name] = { size: 1, offset: '0', unpacked: file.unpacked };
    }
    writeAsar(resources, header);
  };
  for (const helper of helpers) {
    const file = path.join(resources, 'app.asar.unpacked', helper);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  writePackage();
  const mode = path.join(resources, 'desktop-mode.json');
  assert.throws(() => verifyPackagedAppContents(resources, { remoteClient: true }), /fixed desktop-mode/);
  fs.writeFileSync(mode, JSON.stringify({ mode: 'remote-client' }));
  assert.throws(() => verifyPackagedAppContents(resources, { remoteClient: true }), /bundled web-dist/);
  fs.mkdirSync(path.join(resources, 'web-dist'));
  fs.writeFileSync(path.join(resources, 'web-dist/index.html'), 'fixture');
  assert.doesNotThrow(() => verifyPackagedAppContents(resources, { remoteClient: true }));
  // A mode file alone never relaxes the normal distribution's local contract.
  assert.throws(() => verifyPackagedAppContents(resources), /prepare:ripgrep/);
  fs.writeFileSync(mode, JSON.stringify({ mode: 'local' }));
  assert.throws(() => verifyPackagedAppContents(resources, { remoteClient: true }), /fixed desktop-mode/);
  fs.writeFileSync(mode, JSON.stringify({ mode: 'remote-client' }));
  for (const resource of ['opencode-cli', 'embedded-knowledge', 'hy-memory', 'superweb', 'ripgrep', 'windows-diagnostics']) {
    fs.mkdirSync(path.join(resources, resource));
    assert.throws(() => verifyPackagedAppContents(resources, { remoteClient: true }), new RegExp(`must not bundle ${resource}`));
    fs.rmSync(path.join(resources, resource), { recursive: true });
  }
  for (const file of ['node_modules/node-pty/lib/index.js', 'node_modules/sherpa-onnx-darwin-x64/index.js', 'node_modules/@other/native/addon.node']) {
    writePackage([{ path: file, unpacked: true }]);
    assert.throws(() => verifyPackagedAppContents(resources, { remoteClient: true }), /local native dependency/);
  }
});

test('Intel remote builder excludes local payloads without mutating the normal build', () => {
  const normal = structuredClone(require('../package.json').build);
  const config = require('./intel-remote-builder.cjs');
  assert.deepEqual(require('../package.json').build, normal);
  assert.equal(config.extraMetadata.superwagieClientMode, 'remote-client');
  assert.equal(config.mac.minimumSystemVersion, '12.0');
  assert.deepEqual(config.extraResources.map(resource => resource.to), ['web-dist', 'icons/icon.ico', 'icons/icon.png', 'icons/tray', 'desktop-mode.json']);
  assert.match(config.files.at(-1), /node,dylib,dll,so,exe,a/);
  assert.equal(normal.extraResources.some(resource => resource.to === 'hy-memory'), true);
});

test('normalized remote filters retain JS helpers and omit native dependency files', async (t) => {
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const { doMergeConfigs } = builderRequire('app-builder-lib/out/util/config/config');
  const { FileMatcher, getNodeModuleFileMatcher } = builderRequire('app-builder-lib/out/fileMatcher');
  const { NodeModuleCopyHelper } = builderRequire('app-builder-lib/out/util/NodeModuleCopyHelper');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-remote-filters-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appDirectory = path.join(directory, 'packages/electron');
  for (const entry of [
    'node_modules/node-pty/lib/index.js',
    'node_modules/node-pty/build/Release/pty.node',
    'node_modules/sherpa-onnx-darwin-x64/sherpa-onnx.node',
    'node_modules/other/index.js',
    'node_modules/other/addon.node',
    'node_modules/other/libnative.dylib',
  ]) {
    const file = path.join(appDirectory, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  const destination = path.join(directory, 'output');
  const packager = {
    config: doMergeConfigs([structuredClone(require('./intel-remote-builder.cjs'))]),
    debugLogger: { isEnabled: false },
    appInfo: { type: 'module' },
    getWorkspaceRoot: async () => directory,
  };
  const expand = value => value.replaceAll('${platform}', 'darwin').replaceAll('${arch}', 'x64');
  const mainMatcher = getNodeModuleFileMatcher(appDirectory, destination, expand, {}, packager);
  const included = [];
  for (const name of ['node-pty', 'sherpa-onnx-darwin-x64', 'other']) {
    const moduleRoot = path.join(appDirectory, 'node_modules', name);
    const matcher = new FileMatcher(moduleRoot, path.join(destination, 'node_modules', name), expand, mainMatcher.patterns);
    const copier = new NodeModuleCopyHelper(matcher, packager);
    const files = await copier.collectNodeModules({ name, dir: moduleRoot }, [], `node_modules/${name}`);
    included.push(...files.map(file => path.relative(appDirectory, file).split(path.sep).join('/')));
  }
  assert.deepEqual(included, ['node_modules/other/index.js']);
});
