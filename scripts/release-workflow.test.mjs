import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));

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
    assert.ok(config.jobs[windowsJob].steps.some((step) => step.run?.includes('restore-windows-embedded-knowledge.ps1')));
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
