import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import knowledgePins from '../packages/electron/scripts/embedded-knowledge-pin.cjs';
import { memoryIndexOverlayDigest, matchesMemoryIndexOverlay } from '../packages/electron/scripts/embedded-knowledge-memory/apply.mjs';
import { matchesWindowsKnowledgePatch, windowsPatchIdentity } from '../packages/electron/scripts/embedded-knowledge-windows.mjs';
import { verifyHyMemoryResources } from '../packages/electron/scripts/prepare-hy-memory.mjs';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));

test('Windows readback executes complete shared source-pin verification', async (t) => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/windows-build.yml', import.meta.url), 'utf8'));
  const script = config.jobs['build-windows'].steps.find((step) => step.name === 'Verify packaged resources against staged files').run;
  const start = script.indexOf('const knowledgePath =');
  const end = script.indexOf("for (const file of ['SKILL.md'");
  assert.ok(start > 0 && end > start);
  const exactReader = script.slice(start, end);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow source pin '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const electronRoot = directory;
  const resources = path.join(directory, 'dist/win-unpacked/resources');
  fs.mkdirSync(path.join(resources, 'embedded-knowledge'), { recursive: true });
  fs.mkdirSync(path.join(electronRoot, 'resources/embedded-knowledge'), { recursive: true });
  fs.mkdirSync(path.join(electronRoot, 'scripts'));
  fs.copyFileSync(new URL('../packages/electron/scripts/prepare-embedded-knowledge.mjs', import.meta.url), path.join(electronRoot, 'scripts/prepare-embedded-knowledge.mjs'));
  const binary = Buffer.from('fixture Windows backend bytes');
  fs.writeFileSync(path.join(resources, 'embedded-knowledge/embedded-knowledge-server.exe'), binary);
  const pin = knowledgePins.knowledgeSourcePin({});
  const run = async (change = {}, environment = {}) => {
    const expectedPin = knowledgePins.knowledgeSourcePin(environment);
    const manifest = { ...expectedPin, tags: environment.OPENCHAMBER_EMBEDDED_KNOWLEDGE_TAGS || 'sqlite_fts5,anydoc', binary: 'embedded-knowledge-server.exe',
      binarySha256: crypto.createHash('sha256').update(binary).digest('hex'),
      windowsPatch: windowsPatchIdentity('win32'), memoryIndexOverlay: { version: 1, sha256: memoryIndexOverlayDigest() }, ...change };
    for (const root of [resources, path.join(electronRoot, 'resources')]) fs.writeFileSync(path.join(root, 'embedded-knowledge/manifest.json'), JSON.stringify(manifest));
    return vm.runInNewContext(`(async () => { ${exactReader} })()`, {
      assert, fs, path, electronRoot, resources, process: { env: environment }, knowledgeSourcePin: knowledgePins.knowledgeSourcePin,
      readJson: (file) => JSON.parse(fs.readFileSync(file, 'utf8')), matchesMemoryIndexOverlay, matchesWindowsKnowledgePatch,
      hash: async (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    });
  };
  await run();
  await run({}, { OPENCHAMBER_EMBEDDED_KNOWLEDGE_REPO: 'https://example.invalid/approved-repository', OPENCHAMBER_EMBEDDED_KNOWLEDGE_REF: 'approved-ref', OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT: 'a'.repeat(40), OPENCHAMBER_EMBEDDED_KNOWLEDGE_TAGS: 'sqlite_fts5' });
  for (const change of [{ commit: '0'.repeat(40) }, { commit: `${pin.commit}00` }, { repository: 'https://example.invalid/another-repository' }, { ref: 'another-ref' }]) {
    await assert.rejects(run(change), { code: 'ERR_ASSERTION' });
  }
  for (const change of [{ tags: 'other-tags' }, { binarySha256: '0'.repeat(64) }, { memoryIndexOverlay: { version: 1, sha256: '0'.repeat(64) } }, { windowsPatch: { target: 'other', sha256: '0'.repeat(64) } }]) await assert.rejects(run(change), { code: 'ERR_ASSERTION' });
});

test('Windows preparation, cache and packaged readback share the resolved source identity', (t) => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/windows-build.yml', import.meta.url), 'utf8'));
  const steps = config.jobs['build-windows'].steps;
  const resolve = steps.find((step) => step.id === 'knowledge_source');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow pin outputs '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output');
  const start = resolve.run.indexOf('const pin =');
  const end = resolve.run.lastIndexOf('\nNODE');
  assert.ok(start > 0 && end > start);
  const pin = knowledgePins.knowledgeSourcePin();
  vm.runInNewContext(resolve.run.slice(start, end), { fs, createHash: crypto.createHash, knowledgePins,
    process: { env: { GITHUB_OUTPUT: output } } });
  const values = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  assert.deepEqual(values, { ...pin, tags: 'sqlite_fts5,anydoc', sha256: crypto.createHash('sha256').update(JSON.stringify({ ...pin, tags: 'sqlite_fts5,anydoc' })).digest('hex') });
  for (const name of ['Prepare the current Windows knowledge backend', 'Verify packaged resources against staged files']) {
    const step = steps.find((step) => step.name === name);
    for (const [variable, field] of [['REPO', 'repository'], ['REF', 'ref'], ['COMMIT', 'commit'], ['TAGS', 'tags']]) {
      assert.equal(step.env[`OPENCHAMBER_EMBEDDED_KNOWLEDGE_${variable}`], '${{ steps.knowledge_source.outputs.' + field + ' }}');
    }
  }
  assert.ok(steps.find((step) => step.id === 'memory_backend_cache').with.key.includes('${{ steps.knowledge_source.outputs.sha256 }}'));
});

test('all desktop release jobs stage and verify the exact Hy target before packaging', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow Hy targets '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const [file, jobs] of [
    ['release.yml', { 'build-desktop-electron-macos': 'darwin', 'build-desktop-electron-linux': 'linux', 'build-desktop-electron-windows': 'win32' }],
    ['release-desktop-smoke.yml', { 'build-macos-electron': 'darwin', 'build-linux-electron': 'linux', 'build-windows-electron': 'win32' }],
  ]) {
    const config = yaml.parse(fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
    for (const [name, platform] of Object.entries(jobs)) {
      const steps = config.jobs[name].steps;
      const staging = steps.findIndex((step) => step.run?.includes('bun run prepare:hy-memory'));
      const packaging = steps.findIndex((step) => /electron-builder --mac|node \.\/scripts\/package\.mjs/.test(step.run ?? ''));
      assert.ok(staging > 0 && packaging >= staging, `${file} ${name} must stage Hy before packaging`);
      assert.equal(steps[staging]['working-directory'], 'packages/electron');
      assert.equal(steps[staging].env.OPENCHAMBER_TARGET_ARCH, '${{ matrix.arch }}');
      assert.ok(steps[staging].run.includes(`--target=${platform}-` + '${{ matrix.arch }}'));
      assert.ok(steps[staging].run.includes('verifyHyMemoryResources'));
      assert.ok(steps[staging].run.includes(`target: '${platform}-' + process.env.OPENCHAMBER_TARGET_ARCH`));
      const validation = steps[staging].run.match(/node --input-type=module -e "([^"\n]+)"/)?.[1];
      assert.ok(validation);
      const expression = validation.slice(validation.indexOf(';') + 1);
      for (const target of config.jobs[name].strategy.matrix.include) {
        assert.ok(['x64', 'arm64'].includes(target.arch));
        const directory = path.join(fixture, file, name, target.arch);
        const files = ['python/worker.py', platform === 'win32' ? 'runtime/python.exe' : 'runtime/bin/python3'];
        for (const file of files) { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), 'fixture'); }
        const manifest = { schemaVersion: 1, target: `${platform}-${target.arch}`, files: files.sort().map((file) => ({ path: file, sha256: crypto.createHash('sha256').update('fixture').digest('hex'), size: 7 })) };
        const manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const verify = (resource, options) => { assert.equal(resource, 'resources/hy-memory'); return verifyHyMemoryResources(directory, options); };
        const execute = () => vm.runInNewContext(expression, { verifyHyMemoryResources: verify, process: { env: { OPENCHAMBER_TARGET_ARCH: target.arch } } });
        execute();
        fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, target: `${platform}-wrong` }));
        assert.throws(execute, /does not match package target/);
      }
    }
  }
});

test('manifests combine after partial build failures while publication stays strict', () => {
  assert.equal(
    workflow.jobs['combine-electron-manifests'].if,
    "${{ !cancelled() && needs.create-release.result == 'success' }}",
  );
  // Skipped jobs count as done; any failure still stops the release.
  assert.equal(workflow.jobs['finalize-release'].if, "${{ !cancelled() && !failure() && needs.create-release.result == 'success' }}");
});

test('upstream package publication is limited to the upstream repository', () => {
  assert.equal(workflow.jobs['create-release'].if, "github.repository == 'openchamber/openchamber'");
  const extensionWorkflow = yaml.parse(fs.readFileSync(new URL('../.github/workflows/vscode-extension.yml', import.meta.url), 'utf8'));
  assert.equal(extensionWorkflow.jobs.publish.if, "github.repository == 'openchamber/openchamber'");
});

test('Windows installer jobs build x64 only', () => {
  for (const [name, job] of [
    ['windows-build.yml', 'build-windows'],
    ['release.yml', 'build-desktop-electron-windows'],
    ['release-desktop-smoke.yml', 'build-windows-electron'],
  ]) {
    const config = yaml.parse(fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
    assert.deepEqual(config.jobs[job].strategy.matrix.include, [
      { arch: 'x64', target: 'x86_64-pc-windows-msvc', platform: 'win32-x64' },
    ], name);
    assert.ok(config.jobs[job].steps.some((step) => step.run?.includes('windows-update-feeds.mjs')));
    for (const [jobName, definition] of Object.entries(config.jobs)) {
      if (jobName.includes('mac')) {
        assert.equal(definition.steps.some((step) => step.run?.includes('windows-update-feeds.mjs')), false);
      }
    }
  }
  const upload = workflow.jobs['combine-electron-manifests'].steps.find((step) => step.name === 'Upload combined manifests to release');
  assert.equal(upload.with.files.split('\n').filter((file) => file.endsWith('/latest-arm64.yml')).length, 0);
  assert.ok(upload.with.files.split('\n').some((file) => file.endsWith('/latest-x64.yml')));
  assert.ok(upload.with.files.split('\n').some((file) => file.endsWith('/latest.yml')));
});

test('desktop release and smoke jobs prepare the knowledge worker before packaging', () => {
  for (const [file, macJob, linuxJob, windowsJob] of [
    ['release.yml', 'build-desktop-electron-macos', 'build-desktop-electron-linux', 'build-desktop-electron-windows'],
    ['release-desktop-smoke.yml', 'build-macos-electron', 'build-linux-electron', 'build-windows-electron'],
  ]) {
    const config = yaml.parse(fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
    for (const name of [macJob, linuxJob]) {
      const steps = config.jobs[name].steps;
      const script = steps.map((step) => step.run || '').join('\n');
      assert.ok(script.includes('bun run prepare:embedded-knowledge'), `${file} ${name} does not prepare the knowledge worker`);
      assert.ok(script.indexOf('bun run prepare:embedded-knowledge') < script.indexOf('electron-builder --mac') || name === linuxJob);
      assert.ok(steps.some((step) => String(step.uses || '').startsWith('actions/setup-go@')));
      assert.ok(steps.some((step) => String(step.uses || '').startsWith('dtolnay/rust-toolchain@')));
    }
    const windowsSteps = config.jobs[windowsJob].steps;
    const knowledge = windowsSteps.findIndex((step) => /prepare:embedded-knowledge/.test(step.run ?? ''));
    const packaging = windowsSteps.findIndex((step) => /node \.\/scripts\/package\.mjs/.test(step.run ?? ''));
    assert.ok(knowledge >= 0 && packaging > knowledge);
  }
});

test('Windows packages rebuild the memory backend and validate the native Hy runtime', () => {
  const source = fs.readFileSync(new URL('../.github/workflows/windows-build.yml', import.meta.url), 'utf8');
  const config = yaml.parse(source);
  const steps = config.jobs['build-windows'].steps;
  const backend = steps.findIndex((step) => step.name === 'Prepare the current Windows knowledge backend');
  const hy = steps.findIndex((step) => step.name === 'Prepare the native Hy runtime');
  const smoke = steps.findIndex((step) => step.name === 'Exercise native Hy memory with the shared backend');
  const webAssets = steps.findIndex((step) => step.name === 'Build web assets');
  const packaging = steps.findIndex((step) => step.name === 'Build Windows app');
  assert.ok(backend > 0 && hy > backend && smoke > hy && webAssets > smoke && packaging > webAssets);
  assert.match(steps[backend].run, /bun run prepare:embedded-knowledge/);
  assert.match(steps[hy].run, /bun run prepare:hy-memory/);
  assert.match(steps[smoke].run, /hy-memory-smoke\.mjs/);
  assert.match(steps[smoke].run, /hy-memory-s2-smoke\.mjs/);
  assert.match(steps[smoke].run, /firstDayRoundTrip/);
  assert.match(steps[smoke].run, /firstDayUtcRoundTrip/);
  assert.match(steps[smoke].run, /modernRoundTrip/);
  assert.match(source, /x86_64-pc-windows-gnu/);
  assert.match(source, /sqlite3-binding\.h/);
  assert.match(source, /steps\.memory_overlay\.outputs\.sha256/);
  assert.match(source, /matchesMemoryIndexOverlay\(manifest\)/);
  assert.match(source, /verifyHyMemoryResources\(hyPath/);
  assert.match(source, /hyManifest\.runtimeVerified, true/);
  assert.doesNotMatch(source, /SuperWagie-2\.7\.19|bed12a528363cccb/);
});

test('a completed Windows backend build is cached before later packaging stages can fail', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/windows-build.yml', import.meta.url), 'utf8'));
  const steps = config.jobs['build-windows'].steps;
  const restore = steps.find((step) => step.id === 'memory_backend_cache');
  const saveIndex = steps.findIndex((step) => step.name === 'Save the validated knowledge backend');
  const buildIndex = steps.findIndex((step) => step.name === 'Prepare the current Windows knowledge backend');
  const hyIndex = steps.findIndex((step) => step.name === 'Prepare the native Hy runtime');
  assert.match(restore?.uses ?? '', /^actions\/cache\/restore@/);
  assert.ok(saveIndex > buildIndex && saveIndex < hyIndex);
  const save = steps[saveIndex];
  assert.match(save.uses, /^actions\/cache\/save@/);
  assert.equal(save.if, "steps.memory_backend_cache.outputs.cache-hit != 'true'");
  assert.equal(save.with.key, '${{ steps.memory_backend_cache.outputs.cache-primary-key }}');
  assert.equal(save.with.path, restore.with.path);
  assert.match(save.with.path, /\.cargo\/registry/);
  assert.match(save.with.path, /go\/pkg\/mod/);
  assert.match(steps[buildIndex].run, /sourceCommit -ne \$env:OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT/);
});

test('all current Windows release consumers build the same pinned worker and memory overlay from source', () => {
  const jobs = [
    ['windows-build.yml', 'build-windows'],
    ['release.yml', 'build-desktop-electron-windows'],
    ['release-desktop-smoke.yml', 'build-windows-electron'],
  ].map(([file, name]) => ({ file, steps: yaml.parse(fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')).jobs[name].steps }));
  const startName = 'Setup the pinned Go toolchain';
  const endName = 'Save the validated knowledge backend';
  const buildSteps = (steps) => {
    const start = steps.findIndex((step) => step.name === startName);
    const end = steps.findIndex((step) => step.name === endName);
    assert.ok(start > 0 && end > start, 'Missing complete Windows source build toolchain and preparation');
    return steps.slice(start, end + 1);
  };
  const expected = buildSteps(jobs[0].steps);
  for (const { file, steps } of jobs) {
    assert.deepEqual(buildSteps(steps), expected, `${file} must use the same verified source build`);
    assert.equal(steps.some((step) => /restore-windows-embedded-knowledge|SuperWagie-2\.7\.19|SKIP|BYPASS/.test(step.run || '')), false, file);
    const prepare = steps.findIndex((step) => step.name === 'Prepare the current Windows knowledge backend');
    const packaging = steps.findIndex((step) => step.name === 'Build Windows app');
    const superweb = steps.findIndex((step) => step.run?.includes('bun run prepare:superweb'));
    assert.ok(prepare < packaging && superweb > 0 && superweb < packaging, file);
    const commands = expected.map((step) => step.run || '').join('\n');
    assert.match(commands, /knowledgeSourcePin\(process\.env\)/);
    assert.match(commands, /memoryIndexOverlayDigest/);
    assert.match(commands, /sourceCommit -ne \$env:OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT/);
    assert.match(commands, /bun run prepare:embedded-knowledge/);
  }
});

test('Intel compatibility builds remain manual and cannot publish default update feeds', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/build-macos-intel-compat.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(config.on), ['workflow_dispatch']);
  assert.deepEqual(config.permissions, { contents: 'read' });
  const job = config.jobs['build-intel-compat'];
  assert.equal(job['runs-on'], 'macos-15-intel');
  assert.equal(job.env.MACOSX_DEPLOYMENT_TARGET, '12.0');
  assert.equal(job.env.OPENCHAMBER_TARGET_ARCH, 'x64');
  const sourceCheck = job.steps.find((step) => step.name === 'Require a frozen source commit');
  assert.match(sourceCheck.run, /\^\[a-f0-9\]\{40\}\$/);
  const upload = job.steps.find((step) => step.name === 'Upload Intel compatibility installers');
  assert.doesNotMatch(upload.with.path, /latest|\.yml/);
  assert.ok(job.steps.every((step) => !step.uses?.startsWith('softprops/action-gh-release')));
});

test('Intel remote clients package no local engine or native services', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/build-macos-intel-compat.yml', import.meta.url), 'utf8'));
  const steps = config.jobs['build-intel-compat'].steps;
  const packageApp = steps.findIndex((step) => step.name === 'Build the Intel application');
  const resources = steps.findIndex((step) => step.name === 'Verify Intel resources and macOS deployment versions');
  const restart = steps.findIndex((step) => step.name === 'Exercise packaged Intel remote connection and restart');
  const upload = steps.findIndex((step) => step.name === 'Upload Intel compatibility installers');
  assert.ok(packageApp > 0 && resources > packageApp && restart > resources && upload > restart);
  assert.match(steps[packageApp].run, /--config=\.\/scripts\/intel-remote-builder\.cjs/);
  const commands = steps.map(step => step.run || '').join('\n');
  assert.doesNotMatch(commands, /prepare:opencode-cli|prepare:embedded-knowledge|prepare:hy-memory|prepare:superweb|prepare:ripgrep|rebuild:native|rustup|go version/);
  assert.equal(steps.some(step => step.uses?.startsWith('actions/setup-go')), false);
  assert.equal(steps.some(step => step.uses?.startsWith('actions/cache')), false);
  assert.match(steps[restart].run, /smoke-intel-compat\.mjs/);
});

test('Intel local compatibility builds require the frozen macOS 12 candidate and cannot publish feeds', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/build-macos-intel-local.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(config.on), ['workflow_dispatch']);
  assert.deepEqual(config.permissions, { contents: 'read' });
  const job = config.jobs['build-intel-local'];
  assert.equal(job['runs-on'], 'macos-15-intel');
  assert.equal(job.env.MACOSX_DEPLOYMENT_TARGET, '12.0');
  assert.equal(job.env.OPENCHAMBER_TARGET_ARCH, 'x64');
  assert.equal(job.env.ELECTRON_BUILDER_ARCH, 'x64');
  assert.match(job.env.CGO_CFLAGS, /-mmacosx-version-min=12\.0/);
  assert.match(job.env.CGO_LDFLAGS, /-mmacosx-version-min=12\.0/);
  assert.match(job.steps.find(step => step.name === 'Require a frozen source commit').run, /\^\[a-f0-9\]\{40\}\$/);
  const checkout = job.steps.find(step => step.name === 'Checkout');
  assert.equal(checkout.with.ref, '${{ inputs.ref }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const candidate = job.steps.find(step => step.name === 'Validate the local compatibility candidate');
  assert.match(candidate.run, /git rev-parse HEAD/);
  assert.match(candidate.run, /assert\.equal\(pkg\.version, '2\.7\.40-intel'\)/);
  assert.match(candidate.run, /assert\.equal\(pkg\.devDependencies\.electron, '43\.8\.4'\)/);
  assert.match(candidate.run, /assert\.equal\(pkg\.build\.mac\.minimumSystemVersion, '12\.0'\)/);
  assert.match(candidate.run, /assert\.notEqual\(pkg\.build\.extraMetadata\?\.superwagieClientMode, 'remote-client'\)/);
  assert.match(candidate.run, /assert\(!pkg\.build\.extraResources\.some\(resource => resource\.to === 'desktop-mode\.json'\)\)/);
  const runtime = job.steps.find(step => step.name === 'Verify the native Electron runtime and SQLite guard API');
  assert.match(runtime.run, /assert\.equal\(process\.versions\.modules, '148'\)/);
  assert.ok(job.steps.every(step => !step.uses?.startsWith('softprops/action-gh-release')));
  const upload = job.steps.find(step => step.name === 'Upload Intel local installers');
  assert.equal(upload.if, "always() && steps.package_app.outcome == 'success'");
  assert.doesNotMatch(upload.with.path, /latest|\.yml/);
  for (const extension of ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap']) {
    assert.ok(upload.with.path.split('\n').includes(`packages/electron/dist/SuperWagie-2.7.40-intel-mac-x64.${extension}`));
  }
  assert.equal(job.steps.find(step => step.name === 'Upload Intel local diagnostics').if, 'always()');
});

test('Intel local packages build every local service before exercising packaged engine and crash recovery', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/build-macos-intel-local.yml', import.meta.url), 'utf8'));
  const steps = config.jobs['build-intel-local'].steps;
  const orderedNames = [
    'Check SuperWagie customizations',
    'Prepare the macOS 12 local OpenCode engine and ripgrep',
    'Prepare Intel SuperWeb',
    'Prepare the current Intel knowledge backend',
    'Prepare the native Intel memory runtime',
    'Exercise native memory with the shared backend',
    'Build the Intel UI and native modules',
    'Build the macOS 12 native speech module',
    'Package the Intel local application',
    'Verify Intel local resources and macOS deployment versions',
    'Exercise the packaged local engine APIs and tools',
    'Exercise the packaged local backend and crash recovery',
    'Upload Intel local installers',
  ];
  let previousIndex = -1;
  for (const name of orderedNames) {
    const index = steps.findIndex(step => step.name === name);
    assert.ok(index > previousIndex, `${name} follows its prerequisites`);
    previousIndex = index;
  }
  const commands = steps.map(step => step.run || '').join('\n');
  for (const command of ['prepare-intel-opencode.mjs', 'prepare:ripgrep', 'prepare:superweb', 'prepare:embedded-knowledge', 'prepare:hy-memory', 'rebuild:native', 'prepare-intel-speech.mjs', 'hy-memory-smoke.mjs', 'hy-memory-s2-smoke.mjs']) {
    assert.ok(commands.includes(command), `${command} runs in the local build`);
  }
  assert.doesNotMatch(commands, /intel-remote-builder|prepare:opencode-cli|verify:opencode-cli/);
  const packageApp = steps.find(step => step.name === 'Package the Intel local application');
  assert.equal(packageApp.id, 'package_app');
  assert.equal(packageApp.run, 'node ./scripts/package.mjs --mac --x64 --publish=never');
  for (const [name, receipt] of [
    ['Verify Intel local resources and macOS deployment versions', 'intel-local-resources.json'],
    ['Exercise the packaged local engine APIs and tools', 'intel-local-engine.json'],
    ['Exercise the packaged local backend and crash recovery', 'intel-local-startup.json'],
  ]) {
    const step = steps.find(item => item.name === name);
    assert.ok(step.run.includes('--app=packages/electron/dist/mac/犇马.app'));
    assert.ok(step.run.includes(`--receipt=packages/electron/dist/${receipt}`));
  }
});

test('Intel local preparation and packaged verification resolve the same complete compatibility source pin', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/build-macos-intel-local.yml', import.meta.url), 'utf8'));
  const job = config.jobs['build-intel-local'];
  const expected = {
    repository: 'https://github.com/NeoMei/embedded-knowledge',
    ref: 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f',
    commit: 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f',
  };
  for (const step of job.steps) {
    const environment = { ...config.env, ...job.env, ...step.env };
    assert.deepEqual(knowledgePins.knowledgeSourcePin(environment), expected, `${step.name} must use the compatibility source for preparation, packaging and readback`);
  }
});

test('Intel local knowledge cache is isolated by deployment target, pinned toolchains and memory overlay', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/build-macos-intel-local.yml', import.meta.url), 'utf8'));
  const job = config.jobs['build-intel-local'];
  const steps = job.steps;
  assert.equal(job.env.RUSTUP_TOOLCHAIN, '1.97.1');
  assert.equal(job.env.TARGET, 'x86_64-apple-darwin');
  assert.equal(steps.find(step => step.uses?.startsWith('actions/setup-go')).with['go-version'], '1.26.5');
  const restore = steps.find(step => step.id === 'memory_backend_cache');
  assert.match(restore.uses, /^actions\/cache\/restore@/);
  assert.match(restore.with.key, /darwin-x64-macos12-f5adb9e-go1\.26\.5-rust1\.97\.1/);
  assert.match(restore.with.key, /steps\.memory_overlay\.outputs\.sha256/);
  assert.equal(restore.with['restore-keys'], undefined);
  const buildIndex = steps.findIndex(step => step.name === 'Prepare the current Intel knowledge backend');
  const build = steps[buildIndex];
  assert.match(build.run, /rev-parse HEAD\)" = "\$OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT"/);
  assert.match(build.run, /execFileSync\('lipo'/);
  assert.match(build.run, /execFileSync\('otool'/);
  assert.match(build.run, /Number\(minimum\[1\]\) === 12/);
  const saveIndex = steps.findIndex(step => step.name === 'Save the macOS 12 Intel knowledge backend');
  const memoryIndex = steps.findIndex(step => step.name === 'Prepare the native Intel memory runtime');
  assert.ok(saveIndex > buildIndex && saveIndex < memoryIndex);
  assert.equal(steps[saveIndex].if, "steps.memory_backend_cache.outputs.cache-hit != 'true'");
  assert.equal(steps[saveIndex].with.path, restore.with.path);
  assert.equal(steps[saveIndex].with.key, '${{ steps.memory_backend_cache.outputs.cache-primary-key }}');
});

test('Intel local release payloads are extracted and compared before provenance is issued', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/build-macos-intel-local.yml', import.meta.url), 'utf8'));
  const steps = config.jobs['build-intel-local'].steps;
  const extraction = steps.findIndex(step => step.name === 'Verify the actual local DMG and ZIP payloads');
  const startup = steps.findIndex(step => step.name === 'Exercise the packaged local backend and crash recovery');
  const upload = steps.findIndex(step => step.name === 'Upload Intel local installers');
  assert.ok(extraction > startup && upload > extraction);
  const command = steps[extraction].run;
  assert.match(command, /ditto -x -k/);
  assert.match(command, /hdiutil attach .* -readonly -nobrowse/);
  assert.match(command, /trap cleanup EXIT/);
  assert.equal((command.match(/--ci-receipt=/g) || []).length, 2);
  assert.match(command, /assert\.equal\(receipt\.sourceCommit, source/);
  assert.match(command, /createHash\('sha256'\)/);
});

test('Intel local copies require a successful frozen build and a matching draft without changing stable', () => {
  const config = yaml.parse(fs.readFileSync(new URL('../.github/workflows/copy-intel-local-assets.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(config.on), ['workflow_dispatch']);
  const steps = config.jobs['copy-validated-installers'].steps;
  const command = steps.map(step => step.run || '').join('\n');
  assert.match(command, /validate-macos-intel-local\.yml/);
  assert.match(command, /assert\.equal\(run\.conclusion, 'success'\)/);
  assert.match(command, /assert\.equal\(release\.draft, true\)/);
  assert.match(command, /assert\.equal\(release\.target_commitish, source\)/);
  assert.match(command, /assert\.equal\(engine\.sourceCommit, source\)/);
  assert.match(command, /assert\.deepEqual\(stableIdentity\(\), stableBefore/);
  assert.doesNotMatch(command, /release.*(?:create|edit|delete)|latest\.json|latest-x64\.yml/);
});
