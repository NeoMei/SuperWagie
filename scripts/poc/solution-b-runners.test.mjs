import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { detectHostPlatform } from './universal-viewer/gvp-0-gate.mjs';

const root = resolve(import.meta.dirname, '..', '..');

function run(relativeScript, fixture, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'superwagie-solution-b-'));
  const resultsPath = join(dir, 'results.json');
  try {
    execFileSync(process.execPath, [
      resolve(root, relativeScript), '--fixture', fixture, '--results-json', resultsPath,
      '--artifacts-dir', join(dir, 'artifacts'),
      ...extraArgs,
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    if (!error || ![1, 2].includes(error.status)) throw error;
  }
  return JSON.parse(readFileSync(resultsPath, 'utf8'));
}

const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

test('dependency runner enforces the four-tier ownership model', () => {
  const result = run('scripts/poc/gate-0/deps-gate.mjs', 'G0-DEPS-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(Object.keys(result.metrics.tier_summary).length, 4);
  assert.equal(result.metrics.signed_runtime_system_fallback, false);
  assert.equal(result.metrics.user_extension_can_satisfy_core, false);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.equal(result.pass, true);
});

test('dependency runner verifies candidate runtime content and rejects tampering', () => {
  const candidate = mkdtempSync(join(tmpdir(), 'superwagie-runtime-candidate-'));
  const matrix = JSON.parse(readFileSync(resolve(root, 'fixtures/gate-0/G0-DEPS-001/dependencies.json'), 'utf8'));
  const entries = matrix.tiers.signed_runtime.map((dependency) => {
    const absolute = join(candidate, dependency.relative_path);
    mkdirSync(absolute, { recursive: true });
    const payload = `${dependency.id}\n`;
    writeFileSync(join(absolute, 'identity.txt'), payload);
    const treeDigest = sha256(`identity.txt\0${sha256(payload)}\n`);
    return { id: dependency.id, relative_path: dependency.relative_path, sha256: treeDigest };
  });
  writeFileSync(join(candidate, 'runtime-manifest.json'), `${JSON.stringify({ entries }, null, 2)}\n`);

  const valid = run('scripts/poc/gate-0/deps-gate.mjs', 'G0-DEPS-001', ['--candidate-root', candidate]);
  assert.equal(valid.metrics.candidate_runtime_verified, true);
  assert.equal(valid.pass, true);

  writeFileSync(join(candidate, 'runtime', 'node', 'identity.txt'), 'tampered\n');
  const tampered = run('scripts/poc/gate-0/deps-gate.mjs', 'G0-DEPS-001', ['--candidate-root', candidate]);
  assert.equal(tampered.metrics.candidate_runtime_verified, false);
  assert.equal(tampered.pass, false);
  assert.equal(tampered.decision_hint, 'NO_GO');
});

test('thread runner exercises the current nine-state lifecycle', () => {
  const result = run('scripts/poc/gate-2/thread-gate.mjs', 'G2-THREAD-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.states_covered, 9);
  assert.equal(result.metrics.archive_restore_verified, true);
  assert.equal(result.pass, true);
});

test('workflow runner separates all three human gate mechanisms', () => {
  const result = run('scripts/poc/gate-2/workflow-gate.mjs', 'G2-WORKFLOW-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.gate_mechanisms, 3);
  assert.equal(result.metrics.risk_kinds, 4);
  assert.equal(result.metrics.local_invalidation_verified, true);
  assert.equal(result.pass, true);
});

test('host runner keeps effect authority in Product Core and isolates the worker', () => {
  const result = run('scripts/poc/gate-2/host-gate.mjs', 'G2-HOST-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.core_effect_journal, true);
  assert.equal(result.metrics.host_worker_isolated, true);
  assert.equal(result.metrics.one_time_worker_identity, true);
  assert.equal(result.pass, true);
});

test('facade runner covers the complete machine-readable public method catalog', () => {
  const catalog = JSON.parse(readFileSync(resolve(root, 'docs/contracts/v1/public-capability-methods.json'), 'utf8'));
  const result = run('scripts/poc/gate-5/facade-gate.mjs', 'G5-FACADE-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.methods_covered, catalog.methods.length);
  assert.equal(result.metrics.trusted_context_forgery_rejected, true);
  assert.equal(result.metrics.caller_kinds_compared, 2);
  assert.equal(result.metrics.payload_result_schemas_resolved, true);
  assert.equal(result.metrics.input_schema_validations, catalog.methods.length * 2);
  assert.equal(result.metrics.output_schema_validations, catalog.methods.length * 2);
  assert.equal(result.metrics.schema_negative_cases_rejected, catalog.methods.length);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.doesNotMatch(result.limitation, /payload\/result Schema/);
  assert.match(result.limitation, /handler.*Worker/i);
  assert.match(result.limitation, /Network Broker.*DNS\/IP\/redirect\/localhost.*每跳/);
  assert.equal(result.pass, true);
});

test('attack runner covers the new trust and receipt boundaries', () => {
  const result = run('scripts/poc/gate-5/attack-gate.mjs', 'G5-ATTACK-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.trusted_context_forgery_rejected, true);
  assert.equal(result.metrics.resource_audience_transfer_rejected, true);
  assert.equal(result.metrics.gate_receipt_forgery_rejected, true);
  assert.equal(result.metrics.process_boundary_escape_rejected, true);
  assert.equal(result.pass, true);
});

test('extension runner binds installation to an Install Gate receipt', () => {
  const result = run('scripts/poc/gate-5/ext-gate.mjs', 'G5-EXT-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.install_gate_binding_verified, true);
  assert.equal(result.metrics.install_gate_trusted_source_verified, true);
  assert.equal(result.metrics.public_facade_only, true);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.match(result.limitation, /真实签名 Installer\/Extension Worker/);
  assert.equal(result.pass, true);
});

test('GVP-1 through GVP-5 remain explicitly non-executable', () => {
  for (let index = 1; index <= 5; index += 1) {
    const actual = spawnSync(resolve(root, 'scripts/poc/run-gate.sh'), [
      `gvp-${index}`, '--platform', 'macos-15-arm64', '--fixture', `GVP-${index}`,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(actual.status, 2, actual.stderr || actual.stdout);
    assert.match(`${actual.stdout}\n${actual.stderr}`, /not executable|not implemented/i);
  }
});

test('GVP-0 public route rejects legacy Gate 3 options', () => {
  const actual = spawnSync(resolve(root, 'scripts/poc/run-gate.sh'), [
    'gvp-0', '--platform', 'macos-15-arm64', '--fixture', 'GVP-0-CORE-001',
    '--candidate-root', resolve(root, 'scripts/poc/universal-viewer/.candidate/source'),
    '--review-checklist', '/tmp/legacy-review.json',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(actual.status, 2, actual.stderr || actual.stdout);
});

test('GVP-0 public runner validates exact arguments before path initialization and sanitizes every failure', () => {
  const runner = resolve(root, 'scripts/poc/universal-viewer/gvp-0-public-runner.mjs');
  const sandbox = mkdtempSync(join(tmpdir(), 'superwagie-gvp0-cli-'));
  const invalidRepo = join(sandbox, 'repo-is-a-file');
  writeFileSync(invalidRepo, 'not a directory\n');
  const required = [
    '--repo-root', sandbox,
    '--platform', 'macos-15-arm64',
    '--fixture', 'GVP-0-CORE-001',
    '--candidate-root', join(sandbox, 'candidate-secret-path'),
  ];
  const cases = [
    ['missing', []],
    ['duplicate', [...required, '--platform', 'macos-15-arm64']],
    ['unknown', [...required, '--api-token', 'super-secret-value']],
    ['invalid option value', required.map((value) => value === 'macos-15-arm64' ? 'not-a-platform' : value)],
    ['initialization', required.map((value) => value === sandbox ? invalidRepo : value)],
  ];
  try {
    for (const [name, args] of cases) {
      const actual = spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8' });
      const output = `${actual.stdout}\n${actual.stderr}`;
      assert.equal(actual.status, 2, `${name}: ${output}`);
      assert.match(output, /GVP0_PUBLIC_(?:ARGUMENT|RUNNER)_FAILURE/);
      assert.doesNotMatch(output, /at (?:file:|async |main|runGvp0)|node:internal|node:fs/u, name);
      assert.doesNotMatch(output, /super-secret-value|candidate-secret-path|repo-is-a-file/u, name);
      assert.doesNotMatch(output, new RegExp(sandbox.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'), name);
    }
    assert.equal(existsSync(join(sandbox, 'evidence')), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('GVP-0 public route handles an empty reserved result without leaking a parser stack', () => {
  const actual = spawnSync(resolve(root, 'scripts/poc/run-gate.sh'), [
    'gvp-0', '--platform', 'macos-15-arm64', '--fixture', 'GVP-0-CORE-001',
    '--candidate-root', resolve(root, 'scripts/poc/universal-viewer/.candidate/source'),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_OFFLINE: 'true' },
  });
  assert.equal(actual.status, 2, actual.stderr || actual.stdout);
  const expectedCode = detectHostPlatform().platform_id === 'macos-15-arm64'
    ? /GVP0_LIVE_AUDIT_UNAVAILABLE/
    : /GVP0_PLATFORM_MISMATCH/;
  assert.match(`${actual.stdout}\n${actual.stderr}`, expectedCode);
  assert.doesNotMatch(`${actual.stdout}\n${actual.stderr}`, /SyntaxError|Unexpected end of JSON|at JSON\.parse|\[eval\]/);
});

test('GVP-0 public route never reopens a swapped run root for final writes', (t) => {
  if (detectHostPlatform().platform_id !== 'macos-15-arm64') {
    t.skip('requires an exact macOS 15 arm64 host to reach post-attestation output mutation');
    return;
  }
  const candidateRoot = resolve(root, 'scripts/poc/universal-viewer/.candidate/source');
  const evidenceRoot = resolve(root, 'evidence/gvp-0');
  const shimRoot = mkdtempSync(join(tmpdir(), 'superwagie-gvp0-npm-shim-'));
  const statePath = join(shimRoot, 'swapped-run.txt');
  const audit = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      dependencies: { prod: 0, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 0 },
    },
  });
  const shim = join(shimRoot, 'npm');
  writeFileSync(shim, `#!${process.execPath}\n`
    + `const fs=require('fs'),path=require('path');\n`
    + `const er=process.env.GVP0_SWAP_EVIDENCE_ROOT,state=process.env.GVP0_SWAP_STATE,candidate=process.env.GVP0_SWAP_CANDIDATE;\n`
    + `if(!fs.existsSync(state)){const run=fs.readdirSync(er).map(n=>path.join(er,n)).filter(p=>{try{return fs.lstatSync(p).isDirectory()}catch{return false}}).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];fs.renameSync(run,run+'.displaced');fs.symlinkSync(candidate,run,'dir');fs.writeFileSync(state,run);}\n`
    + `if(process.argv[2]==='audit')process.stdout.write(${JSON.stringify(`${audit}\n`)});else process.stdout.write(fs.readFileSync(process.env.GVP0_SWAP_SBOM));\n`);
  chmodSync(shim, 0o700);
  const candidateEntriesBefore = readdirSync(candidateRoot).sort();
  const candidateStatusBefore = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: candidateRoot, encoding: 'utf8' });
  let swappedRun;
  try {
    const actual = spawnSync(resolve(root, 'scripts/poc/run-gate.sh'), [
      'gvp-0', '--platform', 'macos-15-arm64', '--fixture', 'GVP-0-CORE-001', '--candidate-root', candidateRoot,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${shimRoot}:${process.env.PATH}`,
        GVP0_SWAP_EVIDENCE_ROOT: evidenceRoot,
        GVP0_SWAP_STATE: statePath,
        GVP0_SWAP_CANDIDATE: candidateRoot,
        GVP0_SWAP_SBOM: resolve(root, 'scripts/poc/universal-viewer/baseline-evidence/source-sbom.cdx.json'),
      },
    });
    assert.equal(actual.status, 2, actual.stderr || actual.stdout);
    assert.equal(existsSync(statePath), true, actual.stderr || actual.stdout);
    swappedRun = readFileSync(statePath, 'utf8');
    assert.equal(lstatSync(swappedRun).isSymbolicLink(), true);
    assert.match(`${actual.stdout}\n${actual.stderr}`, /GVP0_(?:OUTPUT|RUN_ROOT)_IDENTITY_CHANGED/);
    assert.doesNotMatch(`${actual.stdout}\n${actual.stderr}`, /node:fs|ENOENT|at \w|\/Users\//u);
    assert.deepEqual(readdirSync(candidateRoot).sort(), candidateEntriesBefore);
    assert.equal(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: candidateRoot, encoding: 'utf8' }), candidateStatusBefore);
    assert.equal(existsSync(join(candidateRoot, 'decision.md')), false);
    assert.equal(existsSync(join(candidateRoot, 'manifest.json')), false);
  } finally {
    if (swappedRun && existsSync(swappedRun) && lstatSync(swappedRun).isSymbolicLink()) unlinkSync(swappedRun);
    if (swappedRun) rmSync(`${swappedRun}.displaced`, { recursive: true, force: true });
    rmSync(shimRoot, { recursive: true, force: true });
  }
});
