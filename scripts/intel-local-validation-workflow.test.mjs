import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import yaml from 'yaml';

const source = fs.readFileSync(new URL('../.github/workflows/validate-macos-intel-local.yml', import.meta.url), 'utf8');
const workflow = yaml.parse(source);
const job = workflow.jobs['validate-intel-local'];
const steps = job.steps;
const commands = steps.map(step => step.run || '').join('\n');

test('local installer validation preserves immutable payloads and cannot publish or rebuild', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.equal(job['runs-on'], 'macos-15-intel');
  assert.equal(steps.find(step => step.name === 'Checkout the frozen application source').with.ref, '${{ inputs.source }}');
  assert.match(commands, /assert\.equal\(pkg\.devDependencies\.electron, '43\.8\.4'\)/);
  assert.match(commands, /bun install --frozen-lockfile/);
  assert.doesNotMatch(commands, /prepare:|prepare-intel-opencode|build:web-assets|bundle:main|rebuild:native|scripts\/package\.mjs|gh release|latest\.json/);
  const download = steps.find(step => step.name === 'Download the existing local installers');
  assert.equal(download.with.name, 'macos-intel-local');
  assert.equal(download.with['run-id'], '${{ inputs.build_run }}');
  const upload = steps.find(step => step.name === 'Upload the validated Intel local installers');
  assert.equal(upload.with.name, 'macos-intel-local-validated');
  assert.match(upload.with.path, /intel-local-provenance\.json/);
});

test('local validation requires source-bound successful build stages and isolates known placeholder and bounded-startup-check failures', () => {
  const step = steps.find(step => step.name === 'Verify the original full local build stages');
  assert.match(step.run, /checkout --progress --force/);
  assert.match(step.run, /assert\.equal\(run\.path, '\.github\/workflows\/build-macos-intel-local\.yml'\)/);
  assert.match(step.run, /assert\.equal\(failures\.length, 1\)/);
  assert.match(step.run, /failures\[0\] === 'Verify Intel local resources and macOS deployment versions'/);
  assert.match(step.run, /assert\.equal\(failures\[0\], 'Exercise the packaged local backend and crash recovery'\)/);
  assert.match(step.run, /has timed out after 8 minutes/);
  assert.match(step.run, /Staged\/package resource mismatch: ripgrep/);
  assert.match(step.run, /path: '\.gitkeep'/);
  for (const name of ['Exercise native memory with the shared backend', 'Build the macOS 12 native speech module', 'Package the Intel local application', 'Upload Intel local installers']) assert.ok(step.run.includes(name));
  assert.match(step.run, /testSourceCommit: process\.env\.VALIDATION_COMMIT/);
  assert.match(step.run, /testScripts/);
  assert.match(step.run, /RUNNER_TEMP, 'intel-local-validation-provenance\.json'/);
});

test('local validation compares both extracted installers before testing the packaged engine and crash recovery', () => {
  const order = [
    'Preserve the original installer hashes and speech receipt',
    'Extract the immutable local ZIP application',
    'Verify the complete extracted local application',
    'Verify the immutable local DMG application matches ZIP',
    'Exercise the immutable local engine APIs and tools',
    'Exercise the packaged native terminal addon',
    'Exercise local packaged startup and crash recovery',
    'Confirm the validated installers remain unchanged',
    'Upload the validated Intel local installers',
  ];
  let previous = -1;
  for (const name of order) {
    const next = steps.findIndex(step => step.name === name);
    assert.ok(next > previous, `${name} follows its prerequisites`);
    previous = next;
  }
  assert.match(steps.find(step => step.name === 'Verify the complete extracted local application').run, /--installed-only/);
  const dmg = steps.find(step => step.name === 'Verify the immutable local DMG application matches ZIP').run;
  assert.match(dmg, /-readonly -nobrowse/);
  assert.match(dmg, /--ci-receipt=packages\/electron\/dist\/intel-local-resources\.json/);
  assert.match(dmg, /trap cleanup EXIT/);
  const final = steps.find(step => step.name === 'Confirm the validated installers remain unchanged').run;
  assert.match(final, /hash\.digest\('hex'\), expected\.sha256/);
  assert.match(final, /assert\.deepEqual\(startup\.survivingOwnedProcesses, \[\]\)/);
  assert.match(final, /installersUnchanged: true, localRuntimeVerified: true, passed: true/);
});

test('every validation shell and inline Node block parses before native dispatch', () => {
  for (const step of steps) {
    if (!step.run) continue;
    const shell = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
    assert.equal(shell.status, 0, `${step.name}: ${shell.stderr}`);
    for (const match of step.run.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/g)) {
      const js = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: match[1], encoding: 'utf8' });
      assert.equal(js.status, 0, `${step.name}: ${js.stderr}`);
    }
  }
});

test('native installed-app validation explicitly separates development HMR evidence', () => {
  const step = steps.find(step => step.name === 'Exercise local packaged startup and crash recovery');
  assert.match(step.run, /--packaged-only/);
});
