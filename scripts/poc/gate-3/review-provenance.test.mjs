import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildPathFreeProvenance,
  collectSystemFonts,
  probeWpsApplicationTarget,
  validateRendererProvenanceDocument
} from './review-provenance.mjs';

test('renderer provenance binds interpreter, WPSComposer source, WPS bridge, options, fonts, and representative profile without paths', () => {
  const input = provenanceInput();
  const first = buildPathFreeProvenance(input);
  const second = buildPathFreeProvenance({ ...input, fontRecords: [...input.fontRecords].reverse() });
  assert.deepEqual(first, second, 'ordered font manifest must be canonical');
  assert.equal(first.schema_id, 'superwagie.review-renderer-provenance.v1');
  assert.equal(first.wps.application, 'WPS');
  assert.equal(first.machine.representative, true);
  assert.doesNotMatch(JSON.stringify(first), /\/Users\/|private-root|bin\/python/);

  const changedFont = buildPathFreeProvenance({ ...input, fontRecords: [{ family: 'Noto Sans', version: '2', style: 'Regular' }] });
  const changedPython = buildPathFreeProvenance({ ...input, pythonBytes: Buffer.from('python-v2') });
  const changedSource = buildPathFreeProvenance({ ...input, wpsComposerFiles: [{ identity: 'src/index.py', bytes: Buffer.from('v2') }] });
  assert.notEqual(first.font_manifest_sha256, changedFont.font_manifest_sha256);
  assert.notEqual(first.python_executable_sha256, changedPython.python_executable_sha256);
  assert.notEqual(first.wpscomposer_source_sha256, changedSource.wpscomposer_source_sha256);
  const changedApplication = buildPathFreeProvenance({ ...input, wpsApplicationIdentity: { ...input.wpsApplicationIdentity, executable_sha256: 'f'.repeat(64) } });
  assert.notEqual(first.wps.application_identity.executable_sha256, changedApplication.wps.application_identity.executable_sha256);
  assert.notEqual(first.renderer_environment_sha256, changedApplication.renderer_environment_sha256);
  assert.notEqual(first.renderer_environment_sha256, changedFont.renderer_environment_sha256);
});

test('renderer provenance validator enforces the exact versioned identity and recomputes its canonical digest', () => {
  const document = buildPathFreeProvenance(provenanceInput());
  const verified = validateRendererProvenanceDocument(document, {
    platform: 'macos-15-arm64', representative: true
  });
  assert.equal(verified.rendererEnvironmentSha256, document.renderer_environment_sha256);

  const selfReported = structuredClone(document);
  selfReported.renderer_environment_sha256 = '9'.repeat(64);
  assert.throws(() => validateRendererProvenanceDocument(selfReported), /digest/i);

  const unknownField = structuredClone(document);
  unknownField.source_path = '/Users/private/WPS.app';
  assert.throws(() => validateRendererProvenanceDocument(unknownField), /schema/i);

  const wrongBridge = structuredClone(document);
  wrongBridge.wps.bridge_identity = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateRendererProvenanceDocument(wrongBridge), /bridge/i);
});

test('macOS WPS bundle probe hashes the actual executable/bundle/bridge and rejects declared mismatches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-wps-app-'));
  const app = path.join(root, 'WPS.app');
  const composer = path.join(root, 'composer');
  await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(path.join(app, 'Contents', 'Frameworks'), { recursive: true });
  await mkdir(path.join(app, 'Contents', 'PlugIns'), { recursive: true });
  await mkdir(path.join(app, 'Contents', 'Resources'), { recursive: true });
  await mkdir(path.join(composer, 'bridge'), { recursive: true });
  await writeFile(path.join(app, 'Contents', 'MacOS', 'wps'), 'fake-wps-binary');
  await writeFile(path.join(app, 'Contents', 'Frameworks', 'render-engine.dylib'), 'framework-v1');
  await writeFile(path.join(app, 'Contents', 'PlugIns', 'writer-plugin.bundle'), 'plugin-v1');
  await writeFile(path.join(app, 'Contents', 'Resources', 'layout-profile.dat'), 'resource-v1');
  await writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>12.1.0.17900</string></dict></plist>');
  await writeFile(path.join(composer, 'bridge', 'wps-bridge.js'), 'bridge-v1');
  const bridgeIdentity = `sha256:${sha('bridge-v1')}`;
  const profile = { exact_version: '12.1.0.17900', bridge_identity: bridgeIdentity, executable_relative_path: 'Contents/MacOS/wps', bridge_relative_path: 'bridge/wps-bridge.js' };

  const identity = await probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile, execFile: crossPlatformMacPlistExec });
  assert.equal(identity.target_kind, 'macos-app-bundle');
  assert.equal(identity.executable_sha256, sha('fake-wps-binary'));
  assert.equal(identity.bridge_sha256, sha('bridge-v1'));
  assert.doesNotMatch(JSON.stringify(identity), /superwagie-wps-app|\/tmp\//);
  for (const [relative, replacement] of [
    ['Contents/Frameworks/render-engine.dylib', 'framework-v2'],
    ['Contents/PlugIns/writer-plugin.bundle', 'plugin-v2'],
    ['Contents/Resources/layout-profile.dat', 'resource-v2']
  ]) {
    await writeFile(path.join(app, relative), replacement);
    const changed = await probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile, execFile: crossPlatformMacPlistExec });
    assert.notEqual(changed.bundle_manifest_sha256, identity.bundle_manifest_sha256, `${relative} must change bundle identity`);
    await writeFile(path.join(app, relative), relative.includes('Frameworks') ? 'framework-v1' : relative.includes('PlugIns') ? 'plugin-v1' : 'resource-v1');
  }
  await assert.rejects(probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile: { ...profile, exact_version: 'wrong' }, execFile: crossPlatformMacPlistExec }), /version/i);
  await assert.rejects(probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile: { ...profile, bridge_identity: `sha256:${'0'.repeat(64)}` }, execFile: crossPlatformMacPlistExec }), /bridge/i);
});

test('macOS WPS bundle probe reads the exact version from a binary Info.plist', async (t) => {
  if (process.platform !== 'darwin') return t.skip('binary plist fixture requires macOS plutil');
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-wps-binary-plist-'));
  const app = path.join(root, 'WPS.app');
  const composer = path.join(root, 'composer');
  const xml = path.join(root, 'Info.xml.plist');
  const info = path.join(app, 'Contents', 'Info.plist');
  await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(path.join(composer, 'bridge'), { recursive: true });
  await writeFile(path.join(app, 'Contents', 'MacOS', 'wps'), 'fake-wps-binary');
  await writeFile(path.join(composer, 'bridge', 'wps-bridge.js'), 'bridge-v1');
  await writeFile(xml, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleShortVersionString</key><string>12.1.26055</string>',
    '</dict></plist>'
  ].join('\n'));
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', info, xml]);
  const profile = {
    exact_version: '12.1.26055', bridge_identity: `sha256:${sha('bridge-v1')}`,
    executable_relative_path: 'Contents/MacOS/wps', bridge_relative_path: 'bridge/wps-bridge.js'
  };

  const identity = await probeWpsApplicationTarget({
    platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile
  });

  assert.equal(identity.target_kind, 'macos-app-bundle');
  assert.equal(identity.executable_sha256, sha('fake-wps-binary'));
  assert.doesNotMatch(JSON.stringify(identity), /superwagie-wps-binary-plist|\/tmp\//);

  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', info]);
  const xmlIdentity = await probeWpsApplicationTarget({
    platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile
  });
  assert.equal(xmlIdentity.executable_sha256, identity.executable_sha256);
  assert.notEqual(xmlIdentity.bundle_manifest_sha256, identity.bundle_manifest_sha256,
    'bundle identity must hash the original Info.plist bytes, not only its semantic version');

  await writeFile(info, 'not-a-plist');
  await assert.rejects(
    probeWpsApplicationTarget({
      platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile
    }),
    /WPS bundle version key unavailable/
  );
});

test('macOS WPS bundle probe invokes only absolute plutil with structured args and owned limits', async () => {
  const fixture = await macWpsFixture('superwagie-wps-plutil-contract-');
  const calls = [];
  const execFile = async (program, args, options) => {
    calls.push({ program, args, options });
    return { stdout: `${fixture.profile.exact_version}\n` };
  };

  const identity = await probeWpsApplicationTarget({
    platform: 'macos-15-arm64', wpsApplication: fixture.app,
    wpsComposerRoot: fixture.composer, profile: fixture.profile, execFile
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, '/usr/bin/plutil');
  assert.deepEqual(calls[0].args, [
    '-extract', 'CFBundleShortVersionString', 'raw', '--',
    await realpath(path.join(fixture.app, 'Contents', 'Info.plist'))
  ]);
  assert.deepEqual(calls[0].options, {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    killSignal: 'SIGKILL', shell: false
  });
  assert.doesNotMatch(JSON.stringify(identity), /superwagie-wps-plutil-contract|\/tmp\//);
});

test('macOS WPS bundle probe fails closed for missing, malformed, or failed plist reads without leaking the target path', async () => {
  const fixture = await macWpsFixture('superwagie-wps-plutil-failure-');
  const failures = [
    async () => { throw new Error(`missing key in ${fixture.app}`); },
    async () => ({ stdout: '12.1.26055\n/Users/private/WPS.app' }),
    async () => { const error = new Error(`plutil failed for ${fixture.app}`); error.code = 'ETIMEDOUT'; throw error; }
  ];
  for (const execFile of failures) {
    await assert.rejects(
      probeWpsApplicationTarget({
        platform: 'macos-15-arm64', wpsApplication: fixture.app,
        wpsComposerRoot: fixture.composer, profile: fixture.profile, execFile
      }),
      (error) => {
        assert.match(error.message, /WPS bundle version key unavailable/);
        assert.doesNotMatch(error.message, /superwagie-wps-plutil-failure|\/Users\/private/);
        return true;
      }
    );
  }
});

test('macOS WPS bundle identity binds an in-bundle relative symlink target outside the five manifest roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-wps-symlink-'));
  const app = path.join(root, 'WPS.app');
  const composer = path.join(root, 'composer');
  await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(path.join(app, 'Contents', 'Resources'), { recursive: true });
  await mkdir(path.join(app, 'Contents', 'Shared'), { recursive: true });
  await mkdir(path.join(composer, 'bridge'), { recursive: true });
  await writeFile(path.join(app, 'Contents', 'MacOS', 'wps'), 'fake-wps-binary');
  await writeFile(path.join(app, 'Contents', 'Shared', 'runtime.dat'), 'runtime-v1');
  await symlink('../Shared/runtime.dat', path.join(app, 'Contents', 'Resources', 'runtime.dat'));
  await writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>12.1.0.17900</string></dict></plist>');
  await writeFile(path.join(composer, 'bridge', 'wps-bridge.js'), 'bridge-v1');
  const profile = {
    exact_version: '12.1.0.17900', bridge_identity: `sha256:${sha('bridge-v1')}`,
    executable_relative_path: 'Contents/MacOS/wps', bridge_relative_path: 'bridge/wps-bridge.js'
  };

  const first = await probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile, execFile: crossPlatformMacPlistExec });
  await writeFile(path.join(app, 'Contents', 'Shared', 'runtime.dat'), 'runtime-v2');
  const second = await probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile, execFile: crossPlatformMacPlistExec });

  assert.notEqual(second.bundle_manifest_sha256, first.bundle_manifest_sha256);
  assert.doesNotMatch(JSON.stringify(second), /superwagie-wps-symlink|\/tmp\//);
});

test('Node probe and Python pre/post worker use one recursive symlink target manifest contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-wps-parity-'));
  const app = path.join(root, 'WPS.app');
  const composer = path.join(root, 'composer');
  await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(path.join(app, 'Contents', 'Resources'), { recursive: true });
  await mkdir(path.join(app, 'Contents', 'Shared', 'Runtime'), { recursive: true });
  await mkdir(path.join(composer, 'skills', 'WPSComposer'), { recursive: true });
  await writeFile(path.join(app, 'Contents', 'MacOS', 'wps'), 'fake-wps-binary');
  await writeFile(path.join(app, 'Contents', 'Shared', 'Runtime', 'runtime.dat'), 'runtime-v1');
  await symlink('../Shared/Runtime', path.join(app, 'Contents', 'Resources', 'Runtime'));
  await symlink('../Shared/Runtime', path.join(app, 'Contents', 'Resources', 'RuntimeAlias'));
  await writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>12.1.0.17900</string></dict></plist>');
  await writeFile(path.join(composer, 'skills', 'WPSComposer', '__init__.py'), 'bridge-v1');
  const profile = {
    exact_version: '12.1.0.17900', bridge_identity: `sha256:${sha('bridge-v1')}`,
    executable_relative_path: 'Contents/MacOS/wps', bridge_relative_path: 'skills/WPSComposer/__init__.py'
  };
  const nodeIdentity = await probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile, execFile: crossPlatformMacPlistExec });
  const worker = fileURLToPath(new URL('./wps-render-worker.py', import.meta.url));
  const python = process.env.SUPERWAGIE_TEST_PYTHON || 'python3';
  const source = [
    'import importlib.util,json,sys',
    'from pathlib import Path',
    'from types import SimpleNamespace',
    'spec=importlib.util.spec_from_file_location("worker",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
    'dummy={"target_kind":"macos-app-bundle","executable_sha256":"1"*64,"bundle_manifest_sha256":"2"*64,"bridge_sha256":"3"*64}',
    'args=SimpleNamespace(wps_application=Path(sys.argv[2]),wpscomposer_root=Path(sys.argv[3]),expected_wps_identity_json=json.dumps(dummy,separators=(",",":")),wps_bridge_relative_path="skills/WPSComposer/__init__.py",wps_executable_relative_path="Contents/MacOS/wps")',
    'print(json.dumps(module.measured_wps_identity(args),separators=(",",":")))'
  ].join(';');
  const pythonIdentity = JSON.parse(execFileSync(python, ['-c', source, worker, app, composer], { encoding: 'utf8' }));
  assert.deepEqual(pythonIdentity, nodeIdentity);

  const outside = path.join(root, 'outside.dat');
  const escape = path.join(app, 'Contents', 'Resources', 'Escape');
  await writeFile(outside, 'outside');
  await symlink('../../../outside.dat', escape);
  await assert.rejects(
    probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile, execFile: crossPlatformMacPlistExec }),
    /escaped/i
  );
  await unlink(escape);
  await symlink('.', path.join(app, 'Contents', 'Shared', 'Runtime', 'cycle'));
  await assert.rejects(
    probeWpsApplicationTarget({ platform: 'macos-15-arm64', wpsApplication: app, wpsComposerRoot: composer, profile, execFile: crossPlatformMacPlistExec }),
    /cycle/i
  );
});

test('Windows uses its executable/version and font contracts while Linux fails closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-windows-wps-'));
  const executable = path.join(root, 'wps.exe');
  const composer = path.join(root, 'composer');
  await mkdir(path.join(composer, 'bridge'), { recursive: true });
  await writeFile(executable, 'fake-pe');
  await writeFile(path.join(composer, 'bridge', 'wps-bridge.js'), 'bridge-win');
  const commands = [];
  const execFile = async (program, args) => {
    commands.push({ program, args });
    if (/powershell/i.test(program) && args.some((arg) => String(arg).includes('ProductVersion'))) return { stdout: '12.2.0.1\n' };
    return { stdout: JSON.stringify([
      { family: 'Microsoft YaHei', style: 'system-file', version: `6.25;sha256:${'1'.repeat(64)}` },
      { family: 'Arial', style: 'system-file', version: `7.00;sha256:${'2'.repeat(64)}` }
    ]) };
  };
  const profile = { exact_version: '12.2.0.1', bridge_identity: `sha256:${sha('bridge-win')}`, bridge_relative_path: 'bridge/wps-bridge.js' };
  const identity = await probeWpsApplicationTarget({ platform: 'windows-11-x64', wpsApplication: executable, wpsComposerRoot: composer, profile, execFile });
  const fonts = await collectSystemFonts('windows-11-x64', { execFile });
  assert.equal(identity.target_kind, 'windows-executable');
  assert.deepEqual(fonts.map(({ family }) => family), ['Arial', 'Microsoft YaHei']);
  assert.ok(fonts.every(({ version }) => /;sha256:[0-9a-f]{64}$/.test(version)));
  assert.ok(commands.every(({ program }) => !program.includes('system_profiler')));
  const windowsProvenance = buildPathFreeProvenance({
    ...provenanceInput(), platform: 'windows-11-x64', wpsApplicationIdentity: identity,
    bridgeIdentity: profile.bridge_identity, wpsVersion: profile.exact_version, fontRecords: fonts
  });
  assert.equal(windowsProvenance.wps.application_identity.target_kind, 'windows-executable');
  assert.throws(() => buildPathFreeProvenance({ ...provenanceInput(), platform: 'windows-11-x64' }), /identity/i);
  await assert.rejects(collectSystemFonts('linux-x64', { execFile }), /unsupported/i);
  await assert.rejects(probeWpsApplicationTarget({ platform: 'linux-x64', wpsApplication: executable, wpsComposerRoot: composer, profile, execFile }), /unsupported/i);
});

test('renderer provenance defaults representative false and rejects placeholder or incomplete identity', () => {
  const input = provenanceInput();
  assert.equal(buildPathFreeProvenance({ ...input, representative: undefined }).machine.representative, false);
  assert.throws(() => buildPathFreeProvenance({ ...input, wpsVersion: 'task-8-explicit' }));
  assert.throws(() => buildPathFreeProvenance({ ...input, bridgeIdentity: '' }));
  assert.throws(() => buildPathFreeProvenance({ ...input, fontRecords: [] }));
  assert.throws(() => buildPathFreeProvenance({ ...input, renderOptions: { cache_root: '/Users/private/render-cache' } }), /path/i);
});

function provenanceInput() {
  return {
    platform: 'macos-15-arm64', machineProfileId: 'mac-arm64-reference-v1', representative: true,
    wpsVersion: '12.1.0.17900', bridgeIdentity: `sha256:${'e'.repeat(64)}`,
    pythonBytes: Buffer.from('python-v1'),
    wpsComposerFiles: [{ identity: 'src/index.py', bytes: Buffer.from('v1') }],
    fontRecords: [
      { family: 'Noto Sans', version: '1', style: 'Regular' },
      { family: 'Noto Serif CJK', version: '1', style: 'Regular' }
    ],
    renderOptions: { quality: 'authoritative' },
    wpsApplicationIdentity: { target_kind: 'macos-app-bundle', executable_sha256: 'c'.repeat(64), bundle_manifest_sha256: 'd'.repeat(64), bridge_sha256: 'e'.repeat(64) }
  };
}

async function macWpsFixture(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const app = path.join(root, 'WPS.app');
  const composer = path.join(root, 'composer');
  await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(path.join(composer, 'bridge'), { recursive: true });
  await writeFile(path.join(app, 'Contents', 'MacOS', 'wps'), 'fake-wps-binary');
  await writeFile(
    path.join(app, 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key><string>12.1.26055</string></dict></plist>'
  );
  await writeFile(path.join(composer, 'bridge', 'wps-bridge.js'), 'bridge-v1');
  return {
    app,
    composer,
    profile: {
      exact_version: '12.1.26055', bridge_identity: `sha256:${sha('bridge-v1')}`,
      executable_relative_path: 'Contents/MacOS/wps', bridge_relative_path: 'bridge/wps-bridge.js'
    }
  };
}

const crossPlatformMacPlistExec = process.platform === 'darwin' ? undefined : async (program, args) => {
  assert.equal(program, '/usr/bin/plutil');
  const source = await readFile(args.at(-1), 'utf8');
  const matched = source.match(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/);
  if (!matched) throw new Error('plist key missing');
  return { stdout: `${matched[1].trim()}\n` };
};

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}
