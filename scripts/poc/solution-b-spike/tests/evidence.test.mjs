import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runtimePlatform } from '../src/runtime-platform.mjs';

const spikeRoot = resolve(import.meta.dirname, '..');
const builder = join(spikeRoot, 'src', 'build-evidence.mjs');
const platform = runtimePlatform();
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function findFile(root, name) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { const found = findFile(path, name); if (found) return found; }
    else if (entry.name === name) return path;
  }
  return null;
}

function walk(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const metadata = lstatSync(absolute);
      entries.push({ absolute, metadata });
      if (metadata.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return entries;
}

function hashTree(root, target) {
  const metadata = lstatSync(target);
  if (metadata.isFile()) return sha256(readFileSync(target));
  const records = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const item = lstatSync(absolute);
      const path = relative(target, absolute).split('\\').join('/');
      if (item.isDirectory()) visit(absolute);
      else if (item.isSymbolicLink()) records.push(`L\0${path}\0${readlinkSync(absolute)}\n`);
      else records.push(`F\0${path}\0${sha256(readFileSync(absolute))}\n`);
    }
  };
  visit(target);
  return sha256(records.join(''));
}

test('evidence runner builds and launches an offline actual candidate without accepting external PASS JSON', { timeout: 450_000 }, (t) => {
  const preparationRoot = mkdtempSync(join(tmpdir(), 'superwagie-solution-b-evidence-test-'));
  const evidenceParent = join(preparationRoot, 'evidence');
  const electronCache = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'electron', 'Cache')
    : join(homedir(), 'Library', 'Caches', 'electron');
  const electronArchive = findFile(electronCache, platform.archive);
  if (!electronArchive) {
    t.skip(`locked Electron distribution ${platform.archive} is not present in the host cache`);
    return;
  }
  const run = spawnSync(process.execPath, [builder,
    '--output-parent', evidenceParent, '--electron-archive', electronArchive,
  ], { cwd: spikeRoot, encoding: 'utf8', timeout: 420_000, env: { ...process.env, SUPERWAGIE_ENV_CANARY: 'builder-canary' } });
  assert.equal(run.status, 0, `evidence runner failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const built = JSON.parse(run.stdout.trim());
  const evidenceRoot = built.evidence_root;
  const candidateRoot = built.candidate_root;
  assert.equal(relative(evidenceRoot, candidateRoot), 'candidate-root');
  assert.ok(statSync(join(candidateRoot, ...platform.candidateElectron.split('/'))).isFile());
  assert.equal(walk(candidateRoot).some(({ absolute }) => relative(candidateRoot, absolute).split(sep).includes('node_modules')), false);

  for (const name of ['manifest.json', 'environment.json', 'command.json', 'process-stdout.log', 'process-stderr.log',
    'results.json', 'decision.md', 'artifact-hashes.json', 'actual-run.json']) assert.ok(statSync(join(evidenceRoot, name)).isFile(), name);
  const manifest = JSON.parse(readFileSync(join(evidenceRoot, 'manifest.json'), 'utf8'));
  const results = JSON.parse(readFileSync(join(evidenceRoot, 'results.json'), 'utf8'));
  assert.equal(manifest.commit, true);
  assert.equal(manifest.candidate_root, 'candidate-root');
  assert.equal(manifest.platform, platform.id);
  assert.equal(manifest.fixture, platform.fixture);
  assert.equal(results.pass, true);
  assert.equal(results.platform, platform.id);
  assert.equal(results.checks.runner_launched_actual_candidate, true);
  assert.equal(results.checks.no_external_pass_input, true);
  assert.equal(results.checks.offline_no_remote_requests, true);
  assert.equal(results.parent_gate_upgraded, false);
  assert.equal(results.production_fixture_registered, false);
  const actualRun = JSON.parse(readFileSync(join(evidenceRoot, 'actual-run.json'), 'utf8'));
  assert.equal(results.run_nonce, actualRun.run_nonce);
  assert.equal(actualRun.child_process_records.rust_core.length, 2);
  assert.equal(actualRun.child_process_records.render_workers.length, 6);
  assert.deepEqual(actualRun.child_process_records.render_workers.map(({ exit_code }) => exit_code), [0, 0, process.platform === 'win32' ? 1 : null, 0, 1, 1]);
  assert.equal(actualRun.child_process_records.render_workers[2].signal, 'SIGKILL');
  assert.equal(results.checks.builder_derived_process_claims_from_raw_records, true);
  assert.equal(results.checks.builder_derived_recovery_from_raw_records, true);
  assert.equal(results.checks.builder_derived_security_from_raw_records, true);
  assert.equal(results.checks.checkpoint_secret_excluded_from_evidence_and_candidate, true);
  assert.deepEqual(results.derivation_sources.process_relations, ['raw-run/os-process-samples.json', 'raw-run/actual-electron-result.json#processes.records']);
  assert.deepEqual(results.derivation_sources.recovery, ['raw-run/actual-electron-result.json#core_state_history', 'raw worker exits', 'worker-authenticated pre-crash progress receipts', 'clean and recovery PNG bytes']);
  assert.ok(statSync(join(evidenceRoot, 'raw-attestation.json')).isFile());
  assert.ok(statSync(join(evidenceRoot, 'builder-derivation.json')).isFile());

  const runtime = JSON.parse(readFileSync(join(candidateRoot, 'runtime-manifest.json'), 'utf8'));
  assert.equal(runtime.complete_spike_runtime, true);
  assert.equal(runtime.platform, platform.id);
  assert.equal(runtime.fixture, platform.fixture);
  assert.equal(runtime.complete_product_runtime, false);
  assert.equal(runtime.offline_launch_verified, true);
  assert.equal(runtime.system_chrome_dependency, false);
  assert.equal(runtime.node_modules_dependency, false);
  for (const entry of runtime.entries) assert.equal(hashTree(candidateRoot, join(candidateRoot, entry.relative_path)), entry.sha256, entry.id);

  const hashes = JSON.parse(readFileSync(join(evidenceRoot, 'artifact-hashes.json'), 'utf8'));
  assert.equal(Object.keys(hashes.files).some((path) => path.endsWith('.auth-key')), false);
  for (const [path, digest] of Object.entries(hashes.files)) assert.equal(sha256(readFileSync(join(evidenceRoot, path))), digest, path);
  const forbidden = ['/Users/neomei', '/var/folders/', '/tmp/', 'Library/Caches/electron',
    process.env.USERPROFILE, process.env.TEMP, 'AppData\\Local\\electron\\Cache', 'builder-canary'].filter(Boolean);
  const electronRoot = join(candidateRoot, platform.candidateElectronRoot);
  for (const { absolute, metadata } of walk(evidenceRoot)) {
    if (absolute === electronRoot || absolute.startsWith(`${electronRoot}${sep}`)) continue;
    if (!metadata.isFile() || metadata.size > 5_000_000) continue;
    const text = readFileSync(absolute, 'utf8');
    for (const token of forbidden) assert.equal(text.includes(token), false, `privacy leak ${token} in ${relative(evidenceRoot, absolute)}`);
  }
  assert.equal(readdirSync(evidenceParent).some((name) => name.startsWith('.solution-b-v1-stage-')), false);

  const rejected = spawnSync(process.execPath, [builder, '--result', join(preparationRoot, 'forged-pass.json'),
    '--output-parent', join(preparationRoot, 'reject'), '--electron-archive', electronArchive,
  ], { cwd: spikeRoot, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /external result input is forbidden|unknown argument/);
});
