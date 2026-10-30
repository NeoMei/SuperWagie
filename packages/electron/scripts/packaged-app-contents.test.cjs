const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { readAsarFiles, findPackagedAppContentProblems } = require('./packaged-app-contents.cjs');
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

const completeApp = () => [
  ...['dist-bundle/entry.mjs', 'dist-bundle/main.mjs', 'dist-bundle/early-startup.mjs', 'preload.mjs', 'browser-panel-preload.cjs', 'package.json'],
  `${web}/package.json`,
  `${web}/server/index.js`,
  ...builtinMarkdown,
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

test('normalized file sets preserve built-in skill Markdown while excluding other dependency docs', async (t) => {
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
    `${web}/server/other.md`,
    `${web}/other.md`,
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
  fs.writeFileSync(path.join(knowledge, 'manifest.json'), JSON.stringify({ binary: 'embedded-knowledge-server', repository: 'https://github.com/NeoMei/embedded-knowledge', ref: 'embedded-knowledge', commit: 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f', tags: 'sqlite_fts5,anydoc', binarySha256: crypto.createHash('sha256').update(binary).digest('hex'), anydocSource: { version: '0.2.4', sourceSha256: 'cf0d78e4cfe3654eb3ea04422ec5a94352000ee56e97902125e68e51f7527062', patchedTreeSha256: 'a9641c5da12abbc3f492e75f6140d7e2c57a78edd012110c57ed6836cb221cde' } }));
  assert.doesNotThrow(() => afterPack(context));
  assert.throws(() => afterPack({ ...context, arch: 3 }), /architecture/i);
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
