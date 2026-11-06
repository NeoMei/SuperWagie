const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const runPackage = (t, args) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-package-signing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bun = path.join(directory, 'bun');
  const output = path.join(directory, 'arguments.json');
  fs.writeFileSync(bun, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.PACKAGE_ARGUMENTS, JSON.stringify({ args: process.argv.slice(2), adhoc: process.env.SUPERWAGIE_MACOS_ADHOC }));\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'package.mjs'), ...args], {
    env: { ...process.env, npm_execpath: bun, PACKAGE_ARGUMENTS: output },
    encoding: 'utf8',
  });
  return { result, forwarded: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null };
};

test('explicit ad-hoc packaging consumes its flag and requires full signing without automatic publishing', { skip: process.platform !== 'darwin' }, async (t) => {
  const { result, forwarded } = runPackage(t, ['--mac', '--arm64', '--adhoc']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(forwarded.args.includes('--adhoc'), false);
  assert(forwarded.args.includes('--config.mac.identity=-'));
  assert(forwarded.args.includes('--config.forceCodeSigning=true'));
  assert(forwarded.args.includes('--config.mac.strictVerify=true'));
  assert(forwarded.args.includes('--publish=never'));
  assert(forwarded.args.some(argument => argument.startsWith('--config.afterPack=')));
  assert(forwarded.args.some(argument => argument.startsWith('--config.afterAllArtifactBuild=')));
  assert.equal(forwarded.adhoc, '1');
  const projectRequire = createRequire(path.join(__dirname, '..', 'package.json'));
  const { createYargs, configureBuildCommand, normalizeOptions } = projectRequire('electron-builder/out/builder');
  const options = normalizeOptions(configureBuildCommand(createYargs()).parse(forwarded.args.slice(2)));
  const builderRequire = createRequire(projectRequire.resolve('electron-builder/package.json'));
  const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config');
  await validateConfiguration(options.config, { isEnabled: false });
  assert.equal(options.config.mac.identity, '-');
  assert.equal(options.config.mac.strictVerify, true);
  assert.equal(options.config.forceCodeSigning, true);
  assert.equal(options.publish, 'never');
  const { resolveFunction } = builderRequire('app-builder-lib/out/util/resolve');
  const hooks = require('./macos-signing.cjs');
  assert.equal(await resolveFunction('module', options.config.afterPack, 'afterPack', path.resolve(__dirname, '../../..')), hooks.afterPack);
  assert.equal(await resolveFunction('module', options.config.afterAllArtifactBuild, 'afterAllArtifactBuild', path.resolve(__dirname, '../../..')), hooks.afterAllArtifactBuild);
});

test('normal macOS packaging retains certificate selection and still installs the final verifier', { skip: process.platform !== 'darwin' }, (t) => {
  const { result, forwarded } = runPackage(t, ['--mac', '--arm64', '--config.mac.identity=Developer ID Application: Fixture']);
  assert.equal(result.status, 0, result.stderr);
  assert(forwarded.args.includes('--config.mac.identity=Developer ID Application: Fixture'));
  assert.equal(forwarded.args.includes('--config.mac.identity=-'), false);
  assert.equal(forwarded.args.includes('--publish=never'), false);
  assert(forwarded.args.some(argument => argument.startsWith('--config.afterAllArtifactBuild=')));
  assert.equal(forwarded.adhoc, '0');
});

test('ad-hoc packaging rejects non-Mac targets before invoking the builder', (t) => {
  const { result, forwarded } = runPackage(t, ['--win', '--x64', '--adhoc']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--adhoc requires a macOS build on macOS/);
  assert.equal(forwarded, null);
});

test('final macOS verification rejects a missing afterPack receipt', () => {
  const { afterAllArtifactBuild } = require('./macos-signing.cjs');
  assert.throws(() => afterAllArtifactBuild({ platformToTargets: new Map([[{ nodeName: 'darwin' }, new Map()]]) }), /No macOS application was recorded/);
  assert.deepEqual(afterAllArtifactBuild({ platformToTargets: new Map([[{ nodeName: 'win32' }, new Map()]]) }), []);
});

const makeApp = (directory, name, binary) => {
  const app = path.join(directory, `${name}.app`);
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'));
  fs.copyFileSync(binary, path.join(contents, 'MacOS', name));
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.quukk.signing-fixture.${name.startsWith('Helper') ? 'helper' : 'main'}</string><key>CFBundleName</key><string>${name}</string><key>CFBundleExecutable</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1.0.0</string></dict></plist>`);
  return app;
};

test('builder signing seals nested code and preserves resource bytes; the final gate rejects skipped signing and tampering', { skip: process.platform !== 'darwin' }, async (t) => {
  const { prepareMacSigning, afterAllArtifactBuild } = require('./macos-signing.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie.v2 [arm64] (test)+ {seal}$^|?*-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'fixture');
  execFileSync('xcrun', ['clang', '-x', 'c', '-', '-o', binary], { input: 'int main(void) { return 0; }\n', stdio: ['pipe', 'pipe', 'pipe'] });
  const app = makeApp(directory, 'Fixture [arm64]+', binary);
  const helper = makeApp(path.join(app, 'Contents', 'Frameworks'), 'Helper', binary);
  const helperResource = path.join(helper, 'Contents', 'Resources', 'nested.txt');
  fs.writeFileSync(helperResource, 'nested code resources');
  const payload = path.join(app, 'Contents', 'Resources', 'immutable-native');
  fs.copyFileSync(binary, payload);
  execFileSync('codesign', ['--force', '--sign', '-', payload], { stdio: 'pipe' });
  const before = fs.readFileSync(payload);
  const digest = crypto.createHash('sha256').update(before).digest('hex');
  const manifest = path.join(app, 'Contents', 'Resources', 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ sha256: digest }));
  const manifestBefore = fs.readFileSync(manifest);

  const projectRequire = createRequire(path.join(__dirname, '..', 'package.json'));
  const builderRequire = createRequire(projectRequire.resolve('electron-builder/package.json'));
  const { MacPackager, Platform, Arch } = builderRequire('app-builder-lib');
  const { MacTargetHelper } = builderRequire('app-builder-lib/out/mac/MacTargetHelper');
  const result = { platformToTargets: new Map([[Platform.MAC, new Map()]]) };
  const resources = path.resolve(__dirname, '..', 'resources');
  const mac = { identity: '-', hardenedRuntime: true, strictVerify: true, gatekeeperAssess: false, signIgnore: ['existing-filter'], entitlements: path.join(resources, 'entitlements.mac.plist'), entitlementsInherit: path.join(resources, 'entitlements.mac.plist') };
  const packager = {
    appInfo: { type: 'module', productFilename: 'Fixture [arm64]+' },
    config: { electronVersion: projectRequire('electron/package.json').version },
    info: { buildResourcesDir: resources, getWorkspaceRoot: async () => path.resolve(__dirname, '../../..') },
    platformSpecificBuildOptions: mac, resourceList: Promise.resolve(fs.readdirSync(resources)), forceCodeSigning: true,
  };
  const context = { appOutDir: directory, electronPlatformName: 'darwin', packager };
  prepareMacSigning(context, true);
  assert.throws(() => afterAllArtifactBuild(result), /macOS signature verification failed/);
  const signing = new MacTargetHelper(packager);
  const identity = await signing.findSigningIdentity(false, false, '-', undefined, mac);
  const options = await signing.buildSignOptions(app, identity, 'distribution', false, mac, undefined, Arch[process.arch]);
  assert(options.ignore(payload));
  for (const adjacent of [
    payload.replace('superwagie.v2', 'superwagieXv2'),
    payload.replace('[arm64]', 'arm64'),
    payload.replace('(test)+', 'testtt'),
    payload.replace(' {seal}$^|?*', ' other'),
    payload.replace('.app/Contents', 'Xapp/Contents'),
    payload.replace('/Resources/', '/Resources-other/'),
  ]) assert.equal(options.ignore(adjacent), false, `Adjacent path must remain signable: ${adjacent}`);
  assert(options.ignore(path.dirname(payload)), 'The exact top-level Resources directory is excluded');
  assert.equal(options.ignore(helperResource), false);
  assert(options.ignore('existing-filter'));
  await MacPackager.prototype.doSign.call(packager, options, mac, identity);
  assert.deepEqual(fs.readFileSync(payload), before);
  assert.deepEqual(fs.readFileSync(manifest), manifestBefore);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(payload)).digest('hex'), JSON.parse(fs.readFileSync(manifest, 'utf8')).sha256);
  assert.deepEqual(afterAllArtifactBuild(result), []);
  assert.equal(spawnSync('codesign', ['--verify', '--deep', '--strict', helper]).status, 0);

  // Ordinary certificate selection does not inherit the ad-hoc resource exclusion.
  mac.identity = 'Developer ID Application: Fixture';
  mac.signIgnore = ['existing-filter'];
  prepareMacSigning(context, false);
  assert.deepEqual(mac.signIgnore, ['existing-filter']);
  fs.writeFileSync(helperResource, 'changed after signing');
  assert.throws(() => afterAllArtifactBuild(result), /macOS signature verification failed/);
});
