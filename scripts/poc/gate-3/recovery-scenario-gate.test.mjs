import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const MODULE_URL = new URL('./recovery-scenario-gate.mjs', import.meta.url);
const RECOVERY_SCENARIOS = [
  'wps-missing', 'wps-timeout', 'wps-crash', 'webview-restart',
  'cache-corrupt', 'source-revision-changed'
];
const RUST_RECOVERY_HARNESS = path.join(
  HERE,
  `reviewer-shell/target/debug/recovery_contract_harness${process.platform === 'win32' ? '.exe' : ''}`
);
function prepareRustRecoveryHarness() {
  if (existsSync(RUST_RECOVERY_HARNESS)) return { available: true, skip: false };
  const built = spawnSync('cargo', ['build', '--quiet', '--bin', 'recovery_contract_harness'], {
    cwd: path.join(HERE, 'reviewer-shell'),
    encoding: 'utf8',
  });
  if (built.status === 0 && existsSync(RUST_RECOVERY_HARNESS)) return { available: true, skip: false };
  if (built.error?.code === 'ENOENT') {
    return { available: false, skip: `Rust recovery harness unavailable: ${built.error.message}` };
  }
  const detail = built.stderr || built.stdout || built.error?.message || `cargo exited ${built.status}`;
  if (process.platform === 'win32' && /LNK1181[^\r\n]*dbghelp\.lib|dbghelp\.lib[^\r\n]*LNK1181/i.test(detail)) {
    return { available: false, skip: 'Rust recovery harness unavailable: Windows SDK dbghelp.lib is missing' };
  }
  throw new Error(`Rust recovery harness build failed:\n${detail}`);
}
const RUST_RECOVERY = prepareRustRecoveryHarness();
const RUNNER = path.join(REPO_ROOT, 'scripts/poc/run-gate.sh');
const BASH = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : '/bin/sh';

test('wps-missing keeps DOCX fast preview readable and blocks PPTX truth acceptance', async () => {
  const run = await runScenario('wps-missing');
  assert.equal(run.code, 0);
  assert.equal(run.receipt.harness.kind, 'typescript-production-contracts');
  assert.deepEqual(run.receipt.harness.contract_sources, [
    'preview-orchestrator.ts', 'reviewer-ui/src/docx-fast-adapter.ts'
  ]);
  assert.deepEqual(run.receipt.outcome, {
    docx: { state: 'fast_ready', fidelity: 'fast', readable: true, acceptance_enabled: false },
    pptx: { state: 'dependency_missing', preview_published: false, acceptance_enabled: false }
  });
});

test('wps-timeout publishes no partial preview, preserves acceptance, and reaps only its owned child', { skip: RUST_RECOVERY.skip }, async () => {
  const run = await runScenario('wps-timeout');
  assert.equal(run.code, 0);
  assert.equal(run.receipt.harness.kind, 'rust-production-contracts');
  assert.deepEqual(run.receipt.harness.contract_sources, ['preview_cache.rs', 'review_state.rs', 'wps_worker.rs']);
  assert.equal(run.receipt.outcome.state, 'failed_recoverable');
  assert.equal(run.receipt.outcome.error_code, 'WPS_RENDER_TIMEOUT');
  assert.equal(run.receipt.outcome.partial_preview_published, false);
  assert.equal(run.receipt.outcome.publication_cache_bytes_after_error, 0);
  assert.equal(run.receipt.outcome.prior_accepted_hash, run.receipt.outcome.accepted_hash_after);
  assert.deepEqual(run.receipt.outcome.owned_child, {
    started: true, reaped: true, termination: 'deadline_kill_wait', other_processes_inspected: false
  });
});

test('wps-crash publishes no partial preview, preserves acceptance, and reaps only its owned child', { skip: RUST_RECOVERY.skip }, async () => {
  const run = await runScenario('wps-crash');
  assert.equal(run.code, 0);
  assert.equal(run.receipt.harness.kind, 'rust-production-contracts');
  assert.equal(run.receipt.outcome.state, 'failed_recoverable');
  assert.equal(run.receipt.outcome.error_code, 'WPS_RENDER_PROTOCOL_INVALID');
  assert.equal(run.receipt.outcome.partial_preview_published, false);
  assert.equal(run.receipt.outcome.publication_cache_bytes_after_error, 0);
  assert.equal(run.receipt.outcome.prior_accepted_hash, run.receipt.outcome.accepted_hash_after);
  assert.deepEqual(run.receipt.outcome.owned_child, {
    started: true, reaped: true, termination: 'exit_86', other_processes_inspected: false
  });
});

test('webview-restart restores annotation and accepted revision bytes without a render replay', { skip: RUST_RECOVERY.skip }, async () => {
  const run = await runScenario('webview-restart');
  assert.equal(run.code, 0);
  assert.equal(run.receipt.harness.kind, 'composed-production-contracts');
  assert.deepEqual(run.receipt.harness.contract_sources, [
    'review_state.rs', 'reviewer-ui/src/review-shell.ts'
  ]);
  assert.equal(run.receipt.outcome.state_bytes_before_sha256, run.receipt.outcome.state_bytes_after_sha256);
  assert.equal(run.receipt.outcome.annotation_bytes_before_sha256, run.receipt.outcome.annotation_bytes_after_sha256);
  assert.equal(run.receipt.outcome.accepted_revision_before, run.receipt.outcome.accepted_revision_after);
  assert.equal(run.receipt.outcome.active_page_before, run.receipt.outcome.active_page_after);
  assert.equal(run.receipt.outcome.accepted_state_restored, true);
  assert.deepEqual(run.receipt.outcome.render_side_effects, { before_restart: 0, after_restart: 0, replayed: false });
});

test('cache-corrupt rejects only corrupt content, rerenders a replacement, and preserves acceptance', { skip: RUST_RECOVERY.skip }, async () => {
  const run = await runScenario('cache-corrupt');
  assert.equal(run.code, 0);
  assert.equal(run.receipt.harness.kind, 'rust-production-contracts');
  assert.deepEqual(run.receipt.harness.contract_sources, ['preview_cache.rs', 'review_state.rs']);
  assert.equal(run.receipt.outcome.corrupt_entry_rejected, true);
  assert.equal(run.receipt.outcome.clean_entry_preserved, true);
  assert.equal(run.receipt.outcome.rerendered, true);
  assert.notEqual(run.receipt.outcome.corrupt_bytes_sha256, run.receipt.outcome.replacement_bytes_sha256);
  assert.equal(run.receipt.outcome.replacement_bytes_sha256, run.receipt.outcome.expected_bytes_sha256);
  assert.equal(run.receipt.outcome.prior_accepted_hash, run.receipt.outcome.accepted_hash_after);
});

test('source-revision-changed retains the old binding and emits an explicit deterministic relocation', async () => {
  const run = await runScenario('source-revision-changed');
  assert.equal(run.code, 0);
  assert.equal(run.receipt.harness.kind, 'typescript-production-contracts');
  assert.deepEqual(run.receipt.harness.contract_sources, ['annotation-reanchor.ts']);
  assert.deepEqual(run.receipt.outcome.old_annotation_binding_after, run.receipt.outcome.old_annotation_binding_before);
  assert.notEqual(run.receipt.outcome.old_annotation_binding_after.artifact_revision_id, run.receipt.outcome.target_revision.artifact_revision_id);
  assert.ok(['resolved', 'unresolved'].includes(run.receipt.outcome.relocation.status));
  assert.equal(run.receipt.outcome.silent_movement, false);
  const harnessSource = await readFile(path.join(HERE, 'recovery-contract-harness.ts'), 'utf8');
  assert.doesNotMatch(harnessSource, /old_annotation_binding_after:\s*\{\s*\.\.\.before\s*\}/);
  assert.doesNotMatch(harnessSource, /silent_movement:\s*false/);
});

test('live-admitted recovery evidence has an exact path-free schema, artifact hash, and canonical attestation', { skip: RUST_RECOVERY.skip }, async () => {
  const run = await runScenario('webview-restart');
  assert.equal(run.code, 0);
  assert.deepEqual(Object.keys(run.result).sort(), [
    'artifacts', 'attestation', 'captured_at', 'decision_hint', 'fixture', 'gate',
    'pass', 'platform', 'reasons', 'run_id', 'scenario', 'schema_id',
    'schema_version', 'status'
  ].sort());
  assert.equal(run.result.schema_id, 'superwagie.g3-review-recovery-result.v1');
  assert.equal(Math.abs(Date.now() - Date.parse(run.result.captured_at)) < 60_000, true);
  const receiptBytes = await readFile(path.join(run.root, run.result.artifacts.recovery_receipt.relative_path));
  assert.equal(sha(receiptBytes), run.result.artifacts.recovery_receipt.sha256);
  const { attestation, ...unsigned } = run.result;
  assert.equal(attestation.algorithm, 'sha256');
  assert.equal(attestation.canonical_sha256, sha(JSON.stringify(stable(unsigned))));
  assert.equal(containsNativeOrForbiddenString(run.result), false);
  assert.equal(containsNativeOrForbiddenString(run.receipt), false);
  assert.deepEqual((await readdir(path.join(run.root, 'artifacts'))).sort(), ['recovery-receipt.json']);
});

test('tampered recovery evidence fails complete hash-chain validation', { skip: RUST_RECOVERY.skip }, async () => {
  const run = await runScenario('cache-corrupt');
  assert.equal(run.code, 0);
  const recovery = await loadRecoveryModule();
  assert.ok(recovery, 'recovery production module is missing');
  const receiptPath = path.join(run.root, run.result.artifacts.recovery_receipt.relative_path);
  const tampered = JSON.parse(await readFile(receiptPath, 'utf8'));
  tampered.outcome.clean_entry_preserved = false;
  await writeFile(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(recovery.validateRecoveryEvidence(path.join(run.root, 'results.json'), run.root));
});

test('archival validation remains valid for retained evidence while admission rejects stale rehashed evidence', { skip: RUST_RECOVERY.skip }, async () => {
  const run = await runScenario('webview-restart');
  assert.equal(run.code, 0);
  const recovery = await loadRecoveryModule();
  assert.ok(recovery, 'recovery production module is missing');
  const resultsPath = path.join(run.root, 'results.json');
  const receiptPath = path.join(run.root, run.result.artifacts.recovery_receipt.relative_path);
  const result = JSON.parse(await readFile(resultsPath, 'utf8'));
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.captured_at = '2000-01-01T00:00:00.000Z';
  result.captured_at = receipt.captured_at;
  await rewriteEvidence(resultsPath, receiptPath, result, receipt);
  await recovery.validateRecoveryEvidence(resultsPath, run.root, { mode: 'archive' });
  const now = Date.now();
  await assert.rejects(
    recovery.validateRecoveryEvidence(resultsPath, run.root, {
      mode: 'admission', notBefore: now - 1_000, now
    }),
    /INVALID_FRESHNESS/
  );
});

test('archival validation still rejects an invalid timestamp after full rehash and reattestation', { skip: RUST_RECOVERY.skip }, async () => {
  const run = await runScenario('webview-restart');
  assert.equal(run.code, 0);
  const recovery = await loadRecoveryModule();
  const resultsPath = path.join(run.root, 'results.json');
  const receiptPath = path.join(run.root, run.result.artifacts.recovery_receipt.relative_path);
  const result = JSON.parse(await readFile(resultsPath, 'utf8'));
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.captured_at = 'not-a-timestamp';
  result.captured_at = receipt.captured_at;
  await rewriteEvidence(resultsPath, receiptPath, result, receipt);
  await assert.rejects(
    recovery.validateRecoveryEvidence(resultsPath, run.root, { mode: 'archive' }),
    /INVALID/
  );
});

test('every recovery outcome and harness rejects unknown nested fields after full rehash and reattestation', { skip: RUST_RECOVERY.skip }, async () => {
  const recovery = await loadRecoveryModule();
  for (const scenario of RECOVERY_SCENARIOS) {
    const run = await runScenario(scenario);
    assert.equal(run.code, 0, scenario);
    const resultsPath = path.join(run.root, 'results.json');
    const receiptPath = path.join(run.root, run.result.artifacts.recovery_receipt.relative_path);
    const mutations = [
      ['harness', (receipt) => { receipt.harness.unexpected_nested_field = true; }],
      ['outcome', (receipt) => { receipt.outcome.unexpected_nested_field = true; }]
    ];
    if (scenario === 'wps-missing') {
      mutations.push(['outcome.docx', (receipt) => { receipt.outcome.docx.unexpected_nested_field = true; }]);
    } else if (scenario === 'wps-timeout' || scenario === 'wps-crash') {
      mutations.push(['outcome.owned_child', (receipt) => { receipt.outcome.owned_child.unexpected_nested_field = true; }]);
    } else if (scenario === 'webview-restart') {
      mutations.push(['outcome.render_side_effects', (receipt) => {
        receipt.outcome.render_side_effects.unexpected_nested_field = true;
      }]);
    } else if (scenario === 'source-revision-changed') {
      mutations.push(['outcome.relocation', (receipt) => {
        receipt.outcome.relocation.unexpected_nested_field = true;
      }]);
    }
    for (const [target, mutate] of mutations) {
      const result = structuredClone(run.result);
      const receipt = structuredClone(run.receipt);
      mutate(receipt);
      await rewriteEvidence(resultsPath, receiptPath, result, receipt);
      await assert.rejects(
        recovery.validateRecoveryEvidence(resultsPath, run.root, { mode: 'archive' }),
        /INVALID/,
        `${scenario}:${target}`
      );
    }
  }
});

test('a production-behavior mutation is rejected by the internal outcome evaluator', async () => {
  const recovery = await loadRecoveryModule();
  assert.ok(recovery, 'recovery production module is missing');
  const evaluated = recovery.evaluateHarnessForScenario({
    schema_id: 'superwagie.recovery-ts-harness.v1',
    schema_version: 1,
    scenario: 'wps-missing',
    contract_sources: ['preview-orchestrator.ts', 'reviewer-ui/src/docx-fast-adapter.ts'],
    outcome: {
      docx: { state: 'fast_ready', fidelity: 'fast', readable: true, acceptance_enabled: true },
      pptx: { state: 'dependency_missing', preview_published: false, acceptance_enabled: false }
    }
  }, 'wps-missing');
  assert.equal(evaluated.reason, 'WPS_MISSING_FALLBACK_INVALID');
});

test('atomic evidence publication cleans every precommit fault and makes rename the final hook', async () => {
  const recovery = await loadRecoveryModule();
  assert.ok(recovery, 'recovery production module is missing');
  for (const failedStage of recovery.ATOMIC_STAGES) {
    const root = await mkdtemp(path.join(tmpdir(), 'superwagie-atomic-fault-'));
    try {
      await assert.rejects(recovery.publishJsonAtomic(path.join(root, 'final.json'), { committed: true }, {
        stageHook(stage) {
          if (stage === failedStage) throw new Error(`fault:${stage}`);
        }
      }));
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-atomic-success-'));
  try {
    const observed = [];
    await recovery.publishJsonAtomic(path.join(root, 'final.json'), { committed: true }, {
      stageHook(stage) { observed.push(stage); }
    });
    assert.deepEqual(observed, recovery.ATOMIC_STAGES);
    assert.deepEqual(await readdir(root), ['final.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const source = await readFile(fileURLToPath(MODULE_URL), 'utf8');
  assert.match(source, /await fileHandle\.writeFile\(bytes\)[\s\S]*await fileHandle\.datasync\(\)[\s\S]*await fileHandle\.sync\(\)[\s\S]*directoryHandle = await open\(path\.dirname\(file\), 'r'\)[\s\S]*await directoryHandle\.sync\(\)[\s\S]*stageHook\('rename'\);\s*await rename\(temporary, file\);\s*committed = true;\s*return bytes;/);
});

test('the historical scenario router stays exact while the public route fails closed on solution B', async () => {
  const routing = await import(`./recovery-scenario-routing.mjs?load=${Date.now()}`);
  const value = await routing.validateAuthoritativeScenarioRouting();
  assert.equal(value.authoritative.length, 10);
  assert.deepEqual([...value.isolation, ...value.recovery].sort(), [...value.authoritative].sort());
  for (const scenario of value.isolation) assert.equal(await routing.routeScenario(scenario), 'isolation');
  for (const scenario of value.recovery) assert.equal(await routing.routeScenario(scenario), 'recovery');
  await assert.rejects(routing.routeScenario('wps-normal'), /UNKNOWN_G3_REVIEW_002_SCENARIO/);

  const platform = process.platform === 'darwin' && process.arch === 'arm64'
    ? 'macos-15-arm64'
    : process.platform === 'win32' && process.arch === 'x64' ? 'windows-11-x64' : null;
  if (!platform) return;
  const result = spawnSync(BASH, [RUNNER,
    'gate-3', '--platform', platform, '--fixture', 'G3-REVIEW-002', '--scenario', 'wps-normal'
  ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 });
  const evidenceLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('evidence: '));
  try {
    assert.equal(result.status, 2);
    assert.ok(evidenceLine);
    const runRoot = evidenceLine.slice('evidence: '.length);
    assert.match(await readFile(path.join(runRoot, 'stderr.log'), 'utf8'), /ELECTRON_PREVIEW_RECOVERY_HARNESS_REQUIRED/);
    const resultDocument = JSON.parse(await readFile(path.join(runRoot, 'results.json'), 'utf8'));
    assert.equal(resultDocument.decision_hint, 'BLOCKED_ENVIRONMENT');
    assert.equal(resultDocument.evidence_revision, 'solution-b-v1');
  } finally {
    if (evidenceLine) await rm(evidenceLine.slice('evidence: '.length), { recursive: true, force: true });
  }
});

test('the unified runner blocks recovery IDs until the solution B harness exists', async () => {
  const platform = process.platform === 'darwin' && process.arch === 'arm64'
    ? 'macos-15-arm64'
    : process.platform === 'win32' && process.arch === 'x64' ? 'windows-11-x64' : null;
  if (!platform) return;
  const result = spawnSync(BASH, [RUNNER, 'gate-3', '--platform', platform, '--fixture', 'G3-REVIEW-002', '--scenario', 'wps-missing'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000
  });
  const evidenceLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('evidence: '));
  try {
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.ok(evidenceLine, 'unified runner did not publish an evidence path');
    const runRoot = evidenceLine.slice('evidence: '.length);
    const gateRoot = path.join(REPO_ROOT, 'evidence/gate-3');
    assert.equal(path.dirname(runRoot), gateRoot);
    const value = JSON.parse(await readFile(path.join(runRoot, 'results.json'), 'utf8'));
    assert.equal(value.decision_hint, 'BLOCKED_ENVIRONMENT');
    assert.equal(value.evidence_revision, 'solution-b-v1');
    assert.deepEqual(value.reasons, ['ELECTRON_PREVIEW_RECOVERY_HARNESS_REQUIRED']);
  } finally {
    if (evidenceLine) {
      const runRoot = evidenceLine.slice('evidence: '.length);
      if (path.dirname(runRoot) === path.join(REPO_ROOT, 'evidence/gate-3')) {
        await rm(runRoot, { recursive: true, force: true });
      }
    }
  }
});

async function runScenario(scenario) {
  assert.ok(RECOVERY_SCENARIOS.includes(scenario));
  const recovery = await loadRecoveryModule();
  assert.ok(recovery, 'recovery production module is missing');
  const root = await mkdtemp(path.join(tmpdir(), `superwagie-${scenario}-`));
  const code = await recovery.main(argsFor(root, scenario));
  const result = JSON.parse(await readFile(path.join(root, 'results.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(path.join(root, 'artifacts/recovery-receipt.json'), 'utf8'));
  return { root, code, result, receipt };
}

function argsFor(root, scenario) {
  return [
    '--fixture', 'G3-REVIEW-002', '--scenario', scenario,
    '--platform', process.platform === 'win32' ? 'windows-11-x64' : 'macos-15-arm64',
    '--results-json', path.join(root, 'results.json'),
    '--artifacts-dir', path.join(root, 'artifacts')
  ];
}

async function loadRecoveryModule() {
  try { return await import(`${MODULE_URL.href}?load=${Date.now()}`); }
  catch { return null; }
}

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

async function rewriteEvidence(resultsPath, receiptPath, result, receipt) {
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(receiptPath, receiptBytes);
  result.artifacts.recovery_receipt.sha256 = sha(receiptBytes);
  const { attestation: _old, ...unsigned } = result;
  result.attestation = {
    algorithm: 'sha256',
    canonical_sha256: sha(JSON.stringify(stable(unsigned)))
  };
  await writeFile(resultsPath, `${JSON.stringify(result, null, 2)}\n`);
}

function containsNativeOrForbiddenString(value) {
  if (typeof value === 'string') {
    return /(?:^\/|^[A-Za-z]:[\\/]|\/Users\/|\/Applications\/|\.codex(?:[\\/]|$)|Codex(?:\.app|\.exe)|https?:\/\/)/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsNativeOrForbiddenString);
  return value && typeof value === 'object' ? Object.values(value).some(containsNativeOrForbiddenString) : false;
}
