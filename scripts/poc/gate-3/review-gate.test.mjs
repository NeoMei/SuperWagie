import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const gateDir = path.dirname(fileURLToPath(import.meta.url));
const reviewGate = path.join(gateDir, 'review-gate.mjs');
const isolationGate = path.join(gateDir, 'review-isolation-gate.mjs');
const manifest = path.resolve(gateDir, '../../../fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json');
const runner = path.resolve(gateDir, '../run-gate.sh');
const { main, metricDecision, REQUIRED_METRICS, runOwnedProcess } = await import('./review-gate.mjs');
const { attestIsolationResult } = await import('./isolation-evidence.mjs');

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-task8-'));
  const artifacts = path.join(root, 'artifacts');
  const results = path.join(root, 'results.json');
  const python = path.join(root, 'python');
  const wps = path.join(root, 'wpscomposer');
  const provenance = path.join(root, 'provenance.json');
  await writeFile(python, '#!/bin/sh\nexit 0\n');
  await chmod(python, 0o700);
  await mkdir(wps);
  await writeFile(provenance, JSON.stringify(validProvenance()));
  return { root, artifacts, results, python, wps, provenance };
}

function run(script, args, cwd = gateDir) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function unlockedIoreg(_file, _args, _options, callback) {
  callback(null, `+-o Root  <class IORegistryEntry>\n  {\n    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=No})\n  }\n`, '');
}

async function runMainUnlocked(args, overrides = {}) {
  return {
    status: await main(args, { execFile: unlockedIoreg, ...overrides }),
    stderr: ''
  };
}

test('executors expose their narrow help surface after the captured missing-module RED', () => {
  assert.equal(spawnSync(process.execPath, [reviewGate, '--help']).status, 0);
  assert.equal(spawnSync(process.execPath, [isolationGate, '--help']).status, 0);
});

test('unknown fixture exits 2 and valid output paths receive blocked evidence', async () => {
  const ws = await workspace();
  const completed = run(reviewGate, [
    '--fixture', 'G3-REVIEW-999', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts
  ]);
  assert.equal(completed.status, 2);
  const result = JSON.parse(await readFile(ws.results, 'utf8'));
  assert.equal(result.decision_hint, 'BLOCKED_ENVIRONMENT');
  assert.ok(result.reasons.includes('UNKNOWN_FIXTURE'));
});

test('relative paths are rejected before access and absent WPS inputs are blocked', async () => {
  const ws = await workspace();
  const relative = run(reviewGate, [
    '--fixture', 'G3-REVIEW-001', '--results-json', 'results.json',
    '--artifacts-dir', ws.artifacts
  ]);
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /absolute/i);

  const relativeReviewer = run(reviewGate, [
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--reviewer-executable', 'fake-reviewer'
  ]);
  assert.equal(relativeReviewer.status, 2);
  assert.match(relativeReviewer.stderr, /absolute/i);

  const relativeWpsApplication = run(reviewGate, [
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--wps-application', 'WPS.app'
  ]);
  assert.equal(relativeWpsApplication.status, 2);
  assert.match(relativeWpsApplication.stderr, /absolute/i);

  const blocked = run(reviewGate, [
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts
  ]);
  assert.equal(blocked.status, 2);
  assert.equal(JSON.parse(await readFile(ws.results, 'utf8')).decision_hint, 'BLOCKED_ENVIRONMENT');
});

test('locked macOS standard automation blocks before provenance, WPS binding, or reviewer launch', async () => {
  const ws = await workspace();
  const wpsApplication = path.join(ws.root, 'WPS.app');
  await mkdir(wpsApplication);
  const calls = { provenance: 0, binding: 0, reviewer: 0 };
  let invocation = null;

  const status = await main([
    '--fixture', 'G3-REVIEW-001', '--platform', 'macos-15-arm64',
    '--results-json', ws.results, '--artifacts-dir', ws.artifacts,
    '--wps-python', ws.python, '--wpscomposer-root', ws.wps,
    '--wps-application', wpsApplication, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath
  ], {
    execFile: (file, args, options, callback) => {
      invocation = { file, args, options };
      callback(null, `+-o Root  <class IORegistryEntry>\n  {\n    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=Yes})\n  }\n`, '');
    },
    captureTrustedProvenance: async () => { calls.provenance += 1; throw new Error('must not run'); },
    privateWpsLaunchEnvironment: async () => { calls.binding += 1; throw new Error('must not run'); },
    runOwnedProcess: async () => { calls.reviewer += 1; throw new Error('must not run'); }
  });

  assert.equal(status, 2);
  assert.deepEqual(JSON.parse(await readFile(ws.results, 'utf8')), {
    schema_version: 1, gate: 'gate-3', fixture: 'G3-REVIEW-001', pass: false,
    status: 'blocked', decision_hint: 'BLOCKED_ENVIRONMENT',
    reasons: ['INTERACTIVE_SESSION_UNAVAILABLE'], limitations: []
  });
  assert.deepEqual(calls, { provenance: 0, binding: 0, reviewer: 0 });
  assert.equal(invocation.file, '/usr/sbin/ioreg');
  assert.deepEqual(invocation.args, ['-n', 'Root', '-d', '1']);
  assert.equal(invocation.options.shell, false);
  assert.ok(invocation.options.timeout <= 2_000);
  assert.equal(invocation.options.maxBuffer, 128 * 1024);
});

test('macOS session probe accepts a unique logged-in console user when the lock key is absent or exact No', async () => {
  const unlocked = `"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey" = Yes , "kCGSSessionUserNameKey" = "reviewer", "kCGSessionLoginDoneKey" = Yes, "CGSSessionScreenIsLocked" = No })`;
  const unlockedWithOmittedLock = `+-o Root  <class IORegistryEntry>\n  {\n    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes})\n  }`;
  const realSizedUnlockedWithOmittedLock = `${unlockedWithOmittedLock}\n${'x'.repeat(
    83_697 - Buffer.byteLength(unlockedWithOmittedLock) - 1
  )}`;
  const oversized = `${unlocked}${'x'.repeat(128 * 1024 + 1 - Buffer.byteLength(unlocked))}`;
  assert.equal(Buffer.byteLength(realSizedUnlockedWithOmittedLock), 83_697);
  assert.equal(Buffer.byteLength(oversized), 128 * 1024 + 1);
  const blockedCases = [
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=Yes})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=Unknown})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=No,"CGSSessionScreenIsLocked"=No})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=No,"CGSSessionScreenIsLocked"=Yes})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=No,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=No})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="one","kCGSessionLoginDoneKey"=Yes},{"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="two","kCGSessionLoginDoneKey"=Yes})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=No})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"=" ","kCGSessionLoginDoneKey"=Yes})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=No})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Unknown})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer"})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"kCGSessionLoginDoneKey"=Yes})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSessionLoginDoneKey"=Yes,"kCGSessionLoginDoneKey"=No})`, null],
    [`"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="reviewer","kCGSSessionUserNameKey"="other","kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=No})`, null],
    [oversized, null],
    ['', Object.assign(new Error('timeout'), { killed: true })]
  ];

  for (const [output, error] of blockedCases) {
    const ws = await workspace();
    const wpsApplication = path.join(ws.root, 'WPS.app');
    await mkdir(wpsApplication);
    let provenanceCalls = 0;
    const status = await main([
      '--fixture', 'G3-REVIEW-001', '--platform', 'macos-15-arm64',
      '--results-json', ws.results, '--artifacts-dir', ws.artifacts,
      '--wps-python', ws.python, '--wpscomposer-root', ws.wps,
      '--wps-application', wpsApplication, '--fixture-manifest', manifest,
      '--reviewer-executable', process.execPath
    ], {
      execFile: (_file, _args, _options, callback) => callback(error, output, ''),
      captureTrustedProvenance: async () => { provenanceCalls += 1; throw new Error('must not run'); }
    });
    assert.equal(status, 2);
    assert.deepEqual(JSON.parse(await readFile(ws.results, 'utf8')).reasons, ['INTERACTIVE_SESSION_UNAVAILABLE']);
    assert.equal(provenanceCalls, 0);
  }

  const ws = await workspace();
  const wpsApplication = path.join(ws.root, 'WPS.app');
  await mkdir(wpsApplication);
  let provenanceCalls = 0;
  const status = await main([
    '--fixture', 'G3-REVIEW-001', '--platform', 'macos-15-arm64',
    '--results-json', ws.results, '--artifacts-dir', ws.artifacts,
    '--wps-python', ws.python, '--wpscomposer-root', ws.wps,
    '--wps-application', wpsApplication, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath
  ], {
    execFile: (_file, _args, _options, callback) => callback(null, unlocked, ''),
    captureTrustedProvenance: async () => { provenanceCalls += 1; throw new Error('stop after probe'); }
  });
  assert.equal(status, 2);
  assert.deepEqual(JSON.parse(await readFile(ws.results, 'utf8')).reasons, ['RENDERER_PROVENANCE_UNAVAILABLE']);
  assert.equal(provenanceCalls, 1);

  const omittedLockWorkspace = await workspace();
  const omittedLockWpsApplication = path.join(omittedLockWorkspace.root, 'WPS.app');
  await mkdir(omittedLockWpsApplication);
  let omittedLockProvenanceCalls = 0;
  const omittedLockStatus = await main([
    '--fixture', 'G3-REVIEW-001', '--platform', 'macos-15-arm64',
    '--results-json', omittedLockWorkspace.results, '--artifacts-dir', omittedLockWorkspace.artifacts,
    '--wps-python', omittedLockWorkspace.python, '--wpscomposer-root', omittedLockWorkspace.wps,
    '--wps-application', omittedLockWpsApplication, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath
  ], {
    execFile: (_file, _args, _options, callback) => callback(null, realSizedUnlockedWithOmittedLock, ''),
    captureTrustedProvenance: async () => { omittedLockProvenanceCalls += 1; throw new Error('stop after probe'); }
  });
  assert.equal(omittedLockStatus, 2);
  assert.deepEqual(JSON.parse(await readFile(omittedLockWorkspace.results, 'utf8')).reasons, ['RENDERER_PROVENANCE_UNAVAILABLE']);
  assert.equal(omittedLockProvenanceCalls, 1);
});

test('checklist truth table never upgrades missing isolation evidence to GO', async () => {
  const ws = await workspace();
  const metrics = path.join(ws.root, 'metrics.json');
  const checklist = path.join(ws.root, 'checklist.json');
  const manifestHash = await sha256(manifest);
  await writeFile(metrics, JSON.stringify(validMetrics(manifestHash)));
  await writeFile(checklist, JSON.stringify(validChecklist(manifestHash)));
  const completed = run(reviewGate, [
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--fixture-manifest', manifest,
    '--metrics-json', metrics, '--checklist-result', checklist
  ]);
  assert.equal(completed.status, 0);
  const result = JSON.parse(await readFile(ws.results, 'utf8'));
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.ok(result.limitations.some((value) => /codex-never-installed/.test(value)));
});

test('bare isolation labels never permit GO while complete hash-bound evidence does', async () => {
  const ws = await workspace();
  const metrics = path.join(ws.root, 'metrics.json');
  const checklist = path.join(ws.root, 'checklist.json');
  const isolation = path.join(ws.root, 'isolation.json');
  const manifestHash = await sha256(manifest);
  await writeFile(metrics, JSON.stringify(validMetrics(manifestHash)));
  await writeFile(checklist, JSON.stringify(validChecklist(manifestHash)));
  await writeFile(isolation, JSON.stringify({
    fixture: 'G3-REVIEW-002', scenario: 'codex-never-installed', pass: true,
    decision_hint: 'GO'
  }));
  const completed = run(reviewGate, [
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--fixture-manifest', manifest,
    '--metrics-json', metrics, '--checklist-result', checklist,
    '--isolation-result', isolation, '--isolation-evidence-root', ws.root
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(await readFile(ws.results, 'utf8')).decision_hint, 'CONDITIONAL_GO');

  await writeStrictIsolation(ws.root, isolation);
  const accepted = run(reviewGate, [
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--fixture-manifest', manifest,
    '--metrics-json', metrics, '--checklist-result', checklist,
    '--isolation-result', isolation, '--isolation-evidence-root', ws.root
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(await readFile(ws.results, 'utf8')).decision_hint, 'GO');
});

test('invalid checklist, silent misplacement, malformed and stale metrics are NO_GO', async () => {
  const invalidMetricTypes = REQUIRED_METRICS.map((key) => (value) => { value.metrics[key] = 'invalid'; });
  const invalidSampleProvenance = ['progress', 'cachedFirstPage', 'authoritativeFirstPage', 'interactions']
    .map((key) => (value) => { value.provenance.samples[key] = 0; });
  for (const mutate of [
    (value) => { value.metrics.reanchor_silent_misplaced = 1; },
    (value) => { value.provenance.captured_at = '2000-01-01T00:00:00.000Z'; },
    (value) => { value.provenance.fixture = 'G3-REVIEW-002'; },
    (value) => { value.provenance.representative_machine = false; },
    (value) => { value.provenance.raw_user_path = '/Users/reviewer/private'; },
    (value) => { value.provenance.samples.unknown = 1; },
    ...invalidMetricTypes,
    ...invalidSampleProvenance
  ]) {
    const ws = await workspace();
    const metricsPath = path.join(ws.root, 'metrics.json');
    const value = validMetrics(await sha256(manifest));
    mutate(value);
    await writeFile(metricsPath, JSON.stringify(value));
    const completed = run(reviewGate, [
      '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
      '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
      '--wpscomposer-root', ws.wps, '--fixture-manifest', manifest,
      '--metrics-json', metricsPath
    ]);
    assert.equal(completed.status, 1);
    assert.equal(JSON.parse(await readFile(ws.results, 'utf8')).decision_hint, 'NO_GO');
  }

  const ws = await workspace();
  const metricsPath = path.join(ws.root, 'metrics.json');
  const checklistPath = path.join(ws.root, 'checklist.json');
  const manifestHash = await sha256(manifest);
  await writeFile(metricsPath, JSON.stringify(validMetrics(manifestHash)));
  for (const mutateChecklist of [
    (checklist) => { checklist.renderer.application = 'Not-WPS'; },
    (checklist) => { checklist.results.docx_visual = false; }
  ]) {
    const checklist = validChecklist(manifestHash);
    mutateChecklist(checklist);
    await writeFile(checklistPath, JSON.stringify(checklist));
    const invalidChecklist = run(reviewGate, [
      '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
      '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
      '--wpscomposer-root', ws.wps, '--fixture-manifest', manifest,
      '--metrics-json', metricsPath, '--checklist-result', checklistPath
    ]);
    assert.equal(invalidChecklist.status, 1);
    assert.equal(JSON.parse(await readFile(ws.results, 'utf8')).decision_hint, 'NO_GO');
  }
});

test('each performance threshold has an inclusive passing boundary and conditional miss', () => {
  const cases = [
    ['progress_visible_ms', 300], ['cached_first_page_p95_ms', 1000],
    ['authoritative_first_reviewable_page_ms', 5000], ['interaction_p95_ms', 100]
  ];
  for (const [key, boundary] of cases) {
    const exact = validMetrics().metrics;
    exact[key] = boundary;
    assert.deepEqual(metricDecision(exact).performance, []);
    const missed = validMetrics().metrics;
    missed[key] = boundary + 0.001;
    assert.equal(metricDecision(missed).performance.length, 1);
  }
});

test('owned fake executable completes automation and timeout reaps only that process', async () => {
  const ws = await workspace();
  const fake = path.join(ws.root, 'fake-reviewer.mjs');
  const wpsApplication = path.join(ws.root, 'WPS.app');
  const machineProfile = path.join(ws.root, 'machine-profile.json');
  await mkdir(wpsApplication);
  await writeFile(machineProfile, JSON.stringify({
    schema_id: 'superwagie.review-machine-profile.v1', schema_version: 1,
    wps: {
      exact_version: '12.1.0', bridge_identity: `sha256:${'a'.repeat(64)}`,
      bridge_relative_path: 'skills/WPSComposer/__init__.py',
      executable_relative_path: 'Contents/MacOS/wps'
    }
  }));
  await writeFile(fake, `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const root = process.env.SUPERWAGIE_REVIEW_EVIDENCE_DIR;
    mkdirSync(root, { recursive: true });
    const metrics = ${JSON.stringify(validMetrics('0'.repeat(64)))};
    metrics.provenance.session_id = process.env.SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID;
    metrics.provenance.manifest_sha256 = process.env.SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256;
    metrics.provenance.renderer_environment_sha256 = process.env.SUPERWAGIE_WPS_RENDERER_ENV_HASH;
    const capturedAt = new Date().toISOString();
    metrics.provenance.captured_at = capturedAt;
    writeFileSync(path.join(root, 'private-target-receipt.json'), JSON.stringify({
      application: process.env.SUPERWAGIE_WPS_APPLICATION,
      identity: process.env.SUPERWAGIE_WPS_APPLICATION_IDENTITY,
      bridge: process.env.SUPERWAGIE_WPS_BRIDGE_RELATIVE_PATH,
      executable: process.env.SUPERWAGIE_WPS_EXECUTABLE_RELATIVE_PATH
    }));
    writeFileSync(path.join(root, 'review-automation-metrics.json'), JSON.stringify(metrics));
    writeFileSync(path.join(root, 'automation-complete.json'), JSON.stringify({
      session_id: process.env.SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID,
      fixture: 'G3-REVIEW-001', manifest_sha256: process.env.SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256,
      metrics_file: 'review-automation-metrics.json', completed_at: capturedAt,
      preview_hashes: [
        { pageId: 'pdf:page-1', sha256: '${'3'.repeat(64)}' },
        { pageId: 'docx:page-1', sha256: '${'4'.repeat(64)}' },
        { pageId: 'pptx:page-1', sha256: '${'5'.repeat(64)}' }
      ]
    }));
  `);
  const completed = await runMainUnlocked([
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--wps-application', wpsApplication,
    '--machine-profile', machineProfile, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath, '--reviewer-arg', fake,
    '--test-provenance-json', ws.provenance
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(await readFile(ws.results, 'utf8')).decision_hint, 'CONDITIONAL_GO');
  assert.deepEqual(
    JSON.parse(await readFile(path.join(ws.artifacts, 'renderer-provenance.json'), 'utf8')),
    validProvenance()
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(ws.artifacts, 'private-target-receipt.json'), 'utf8')), {
    application: wpsApplication,
    identity: JSON.stringify(validProvenance().wps.application_identity),
    bridge: 'skills/WPSComposer/__init__.py', executable: 'Contents/MacOS/wps'
  });
});

test('owned reviewer dependency failure is trusted only through a bound host failure artifact', async () => {
  const ws = await workspace();
  const fake = path.join(ws.root, 'fake-reviewer-failure.mjs');
  const wpsApplication = path.join(ws.root, 'WPS.app');
  const machineProfile = path.join(ws.root, 'machine-profile.json');
  await mkdir(wpsApplication);
  await writeFile(machineProfile, JSON.stringify({
    schema_id: 'superwagie.review-machine-profile.v1', schema_version: 1,
    wps: {
      exact_version: '12.1.0', bridge_identity: `sha256:${'a'.repeat(64)}`,
      bridge_relative_path: 'skills/WPSComposer/__init__.py',
      executable_relative_path: 'Contents/MacOS/wps'
    }
  }));
  await writeFile(fake, `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const root = process.env.SUPERWAGIE_REVIEW_EVIDENCE_DIR;
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'automation-failure.json'), JSON.stringify({
      schema_id: 'superwagie.review-automation-failure.v1', schema_version: 1,
      session_id: process.env.SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID,
      fixture: 'G3-REVIEW-001',
      manifest_sha256: process.env.SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256,
      renderer_environment_sha256: process.env.SUPERWAGIE_WPS_RENDERER_ENV_HASH,
      failed_at: Date.now(), state: 'dependency_missing',
      error_code: 'SW_REVIEW_RENDER_DEPENDENCY_MISSING'
    }));
    process.exit(2);
  `);
  const completed = await runMainUnlocked([
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--wps-application', wpsApplication,
    '--machine-profile', machineProfile, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath, '--reviewer-arg', fake,
    '--test-provenance-json', ws.provenance
  ]);
  assert.equal(completed.status, 2, completed.stderr);
  const result = JSON.parse(await readFile(ws.results, 'utf8'));
  assert.equal(result.decision_hint, 'BLOCKED_ENVIRONMENT');
  assert.deepEqual(result.reasons, ['WPS_RUNTIME_INCOMPATIBLE']);

  await writeFile(fake, `
    import { writeFileSync } from 'node:fs';
    import path from 'node:path';
    writeFileSync(path.join(process.env.SUPERWAGIE_REVIEW_EVIDENCE_DIR, 'automation-failure.json'), JSON.stringify({
      schema_id: 'superwagie.review-automation-failure.v1', schema_version: 1,
      session_id: process.env.SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID,
      fixture: 'G3-REVIEW-001', manifest_sha256: process.env.SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256,
      renderer_environment_sha256: process.env.SUPERWAGIE_WPS_RENDERER_ENV_HASH,
      failed_at: Date.now(), state: 'failed_recoverable', error_code: 'SW_REVIEW_RENDER_WORKER_FAILED'
    }));
    process.exit(2);
  `);
  const other = await runMainUnlocked([
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--wps-application', wpsApplication,
    '--machine-profile', machineProfile, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath, '--reviewer-arg', fake,
    '--test-provenance-json', ws.provenance
  ]);
  assert.equal(other.status, 1, other.stderr);
  assert.deepEqual(JSON.parse(await readFile(ws.results, 'utf8')).reasons, ['SW_REVIEW_RENDER_WORKER_FAILED']);

  await writeFile(fake, `
    import { writeFileSync } from 'node:fs';
    import path from 'node:path';
    writeFileSync(path.join(process.env.SUPERWAGIE_REVIEW_EVIDENCE_DIR, 'automation-failure.json'), JSON.stringify({
      schema_id: 'superwagie.review-automation-failure.v1', schema_version: 1,
      session_id: process.env.SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID,
      fixture: 'G3-REVIEW-001', manifest_sha256: process.env.SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256,
      renderer_environment_sha256: process.env.SUPERWAGIE_WPS_RENDERER_ENV_HASH,
      failed_at: Date.now(), state: 'failed_terminal',
      error_code: 'SW_REVIEW_AUTOMATION_DOCX_AUTHORITATIVE_FAILED'
    }));
    process.exit(2);
  `);
  const clientFailure = await runMainUnlocked([
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--wps-application', wpsApplication,
    '--machine-profile', machineProfile, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath, '--reviewer-arg', fake,
    '--test-provenance-json', ws.provenance
  ]);
  assert.equal(clientFailure.status, 1, clientFailure.stderr);
  assert.deepEqual(
    JSON.parse(await readFile(ws.results, 'utf8')).reasons,
    ['SW_REVIEW_AUTOMATION_DOCX_AUTHORITATIVE_FAILED']
  );

  await writeFile(fake, `
    import { writeFileSync } from 'node:fs';
    import path from 'node:path';
    writeFileSync(path.join(process.env.SUPERWAGIE_REVIEW_EVIDENCE_DIR, 'automation-failure.json'), JSON.stringify({
      schema_id: 'superwagie.review-automation-failure.v1', schema_version: 1,
      session_id: process.env.SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID,
      fixture: 'G3-REVIEW-001', manifest_sha256: process.env.SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256,
      renderer_environment_sha256: '${'f'.repeat(64)}', failed_at: 1,
      state: 'dependency_missing', error_code: 'SW_REVIEW_RENDER_DEPENDENCY_MISSING'
    }));
    process.exit(2);
  `);
  const tampered = await runMainUnlocked([
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--wps-application', wpsApplication,
    '--machine-profile', machineProfile, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath, '--reviewer-arg', fake,
    '--test-provenance-json', ws.provenance
  ]);
  assert.equal(tampered.status, 1, tampered.stderr);
  assert.deepEqual(JSON.parse(await readFile(ws.results, 'utf8')).reasons, ['REVIEWER_PROCESS_FAILED']);

  await writeFile(fake, `
    import { rmSync } from 'node:fs';
    import path from 'node:path';
    rmSync(path.join(process.env.SUPERWAGIE_REVIEW_EVIDENCE_DIR, 'automation-failure.json'), { force: true });
    process.exit(2);
  `);
  const missing = await runMainUnlocked([
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--wps-application', wpsApplication,
    '--machine-profile', machineProfile, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath, '--reviewer-arg', fake,
    '--test-provenance-json', ws.provenance
  ]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.deepEqual(JSON.parse(await readFile(ws.results, 'utf8')).reasons, ['REVIEWER_PROCESS_FAILED']);
});

test('owned-process deadline reports timeout without killing an unrelated process', async () => {
  const ws = await workspace();
  const sentinel = path.join(ws.root, 'unrelated-completed');
  const unrelated = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ok'), 80)`], {
    stdio: 'ignore'
  });
  const result = await runOwnedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, 30);
  assert.equal(result.timedOut, true);
  await new Promise((resolve, reject) => {
    unrelated.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`unrelated exit ${code}`)));
  });
  assert.equal(await readFile(sentinel, 'utf8'), 'ok');
});

test('automation without trusted completion or metrics is NO_GO', async () => {
  const ws = await workspace();
  const wpsApplication = path.join(ws.root, 'WPS.app');
  const machineProfile = path.join(ws.root, 'machine-profile.json');
  await mkdir(wpsApplication);
  await writeFile(machineProfile, JSON.stringify({
    schema_id: 'superwagie.review-machine-profile.v1', schema_version: 1,
    wps: { exact_version: '12.1.0', bridge_identity: `sha256:${'a'.repeat(64)}`,
      bridge_relative_path: 'skills/WPSComposer/__init__.py', executable_relative_path: 'Contents/MacOS/wps' }
  }));
  const completed = await runMainUnlocked([
    '--fixture', 'G3-REVIEW-001', '--results-json', ws.results,
    '--artifacts-dir', ws.artifacts, '--wps-python', ws.python,
    '--wpscomposer-root', ws.wps, '--wps-application', wpsApplication,
    '--machine-profile', machineProfile, '--fixture-manifest', manifest,
    '--reviewer-executable', process.execPath, '--reviewer-arg', '-e',
    '--reviewer-arg', 'process.exit(0)', '--test-provenance-json', ws.provenance
  ]);
  assert.equal(completed.status, 1, completed.stderr);
  assert.deepEqual(JSON.parse(await readFile(ws.results, 'utf8')).reasons, ['AUTOMATION_COMPLETION_INVALID']);
});

test('unified runner cannot expose the test seam or route current review through the legacy runner', async () => {
  const source = await readFile(runner, 'utf8');
  assert.doesNotMatch(source, /--reviewer-executable|--reviewer-arg/);
  assert.match(source, /--wps-application/);
  assert.match(source, /\[A-Za-z\]:\[\\\\\/\]\*/);
  assert.doesNotMatch(source, /node "\$G3_DIR\/review-gate\.mjs"/);
  assert.match(source, /G3-REVIEW-001\)[\s\S]*environment-gate\.mjs/);
  assert.match(source, /G3-REVIEW-002\)[\s\S]*environment-gate\.mjs/);
});

test('standard review gate accepts canonical Windows platform instead of deriving win32-x64', async () => {
  const ws = await workspace();
  const metrics = path.join(ws.root, 'metrics.json');
  await writeFile(metrics, JSON.stringify(validMetrics(await sha256(manifest))));
  const completed = run(reviewGate, [
    '--fixture', 'G3-REVIEW-001', '--platform', 'windows-11-x64',
    '--results-json', ws.results, '--artifacts-dir', ws.artifacts,
    '--wps-python', ws.python, '--wpscomposer-root', ws.wps,
    '--fixture-manifest', manifest, '--metrics-json', metrics
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(await readFile(ws.results, 'utf8')).decision_hint, 'CONDITIONAL_GO');

  let macProbeCalls = 0;
  const directStatus = await main([
    '--fixture', 'G3-REVIEW-001', '--platform', 'windows-11-x64',
    '--results-json', ws.results, '--artifacts-dir', ws.artifacts,
    '--wps-python', ws.python, '--wpscomposer-root', ws.wps,
    '--fixture-manifest', manifest, '--metrics-json', metrics
  ], {
    execFile: () => { macProbeCalls += 1; throw new Error('macOS probe must not run on Windows'); }
  });
  assert.equal(directStatus, 0);
  assert.equal(macProbeCalls, 0);
});

test('unknown Gate 3 fixture reaches the common finalizer with complete blocked evidence', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const completed = spawnSync('/bin/sh', [runner, 'gate-3', '--platform', 'macos-15-arm64', '--fixture', 'G3-REVIEW-999'], { cwd: path.resolve(gateDir, '../../..'), encoding: 'utf8' });
  assert.equal(completed.status, 2, completed.stderr);
  const match = completed.stdout.match(/evidence: (.+)$/m);
  assert.ok(match);
  try {
    for (const name of ['manifest.json', 'environment.json', 'results.json', 'decision.md']) await readFile(path.join(match[1], name));
    const result = JSON.parse(await readFile(path.join(match[1], 'results.json'), 'utf8'));
    assert.equal(result.decision_hint, 'BLOCKED_ENVIRONMENT');
    assert.deepEqual(result.reasons, ['UNKNOWN_FIXTURE']);
  } finally {
    await rm(match[1], { recursive: true });
  }
});

test('isolation executor captures through its direct-only fake seam and preserves preview order', async () => {
  const ws = await workspace();
  const baseline = path.join(ws.root, 'baseline-results.json');
  const candidate = path.join(ws.root, 'candidate.json');
  await writeFile(candidate, JSON.stringify(validCapture('codex-never-installed')));
  let completed = run(isolationGate, [
    '--fixture', 'G3-REVIEW-002', '--scenario', 'codex-never-installed', '--platform', 'macos-15-arm64',
    '--results-json', baseline, '--artifacts-dir', ws.artifacts, '--test-capture-json', candidate
  ]);
  assert.equal(completed.status, 0, completed.stderr);

  const runningCapture = validCapture('codex-running');
  await writeFile(candidate, JSON.stringify(runningCapture));
  const runningArtifacts = path.join(ws.root, 'running-artifacts');
  completed = run(isolationGate, [
    '--fixture', 'G3-REVIEW-002', '--scenario', 'codex-running', '--platform', 'macos-15-arm64',
    '--results-json', ws.results, '--artifacts-dir', runningArtifacts,
    '--test-capture-json', candidate, '--baseline-results', baseline, '--baseline-evidence-root', ws.root
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(await readFile(ws.results, 'utf8')).pass, true);

  runningCapture.snapshot.preview_hashes.reverse();
  await writeFile(candidate, JSON.stringify(runningCapture));
  const reversed = run(isolationGate, [
    '--fixture', 'G3-REVIEW-002', '--scenario', 'codex-running', '--platform', 'macos-15-arm64',
    '--results-json', ws.results, '--artifacts-dir', path.join(ws.root, 'reversed-artifacts'),
    '--test-capture-json', candidate, '--baseline-results', baseline, '--baseline-evidence-root', ws.root
  ]);
  assert.equal(reversed.status, 1, reversed.stderr);
  assert.deepEqual(JSON.parse(await readFile(ws.results, 'utf8')).reasons, ['PREVIEW_HASH_ORDER_MISMATCH']);

  const source = await readFile(runner, 'utf8');
  assert.doesNotMatch(source, /--test-capture-json|--snapshot-json|--test-provenance-json/);
});

function validMetrics(manifestSha256 = '0'.repeat(64)) {
  return {
    metrics: {
      progress_visible_ms: 20,
      cached_first_page_p95_ms: 200,
      authoritative_first_reviewable_page_ms: 600,
      interaction_p95_ms: 30,
      peak_rss_bytes: 1000000,
      cache_bytes: 2000000,
      reanchor_resolved: 1,
      reanchor_unresolved: 1,
      reanchor_silent_misplaced: 0,
      visual_diff_ratio: 0.01
    },
    provenance: {
      fixture: 'G3-REVIEW-001', session_id: 'session-test',
      manifest_sha256: manifestSha256, captured_at: new Date().toISOString(),
      representative_machine: true,
      renderer_environment_sha256: '9'.repeat(64),
      host_measurements: { source: 'trusted-native-host', peak_rss_bytes: 1000000, cache_bytes: 2000000 },
      correctness_counters: { acceptance: true, basis: 'task-9-validated' },
      samples: { progress: 1, cachedFirstPage: 5, authoritativeFirstPage: 1, interactions: 5 }
    }
  };
}

function validProvenance() {
  const value = {
    schema_id: 'superwagie.review-renderer-provenance.v1', schema_version: 1,
    platform: 'macos-15-arm64', machine: { profile_id: 'test', representative: true },
    wps: {
      application: 'WPS', exact_version: '12.1.0', bridge_identity: `sha256:${'a'.repeat(64)}`,
      application_identity: { target_kind: 'macos-app-bundle', executable_sha256: 'b'.repeat(64), bundle_manifest_sha256: 'c'.repeat(64), bridge_sha256: 'a'.repeat(64) }
    },
    python_executable_sha256: '6'.repeat(64), wpscomposer_source_sha256: '7'.repeat(64),
    font_manifest_sha256: '8'.repeat(64), render_options: { quality: 'authoritative' },
    renderer_environment_sha256: ''
  };
  const identity = Object.fromEntries(['platform', 'machine', 'wps', 'python_executable_sha256', 'wpscomposer_source_sha256', 'font_manifest_sha256', 'render_options'].map((key) => [key, value[key]]));
  value.renderer_environment_sha256 = createHash('sha256').update(JSON.stringify(stable(identity))).digest('hex');
  return value;
}

async function writeStrictIsolation(root, results) {
  const candidate = path.join(root, 'strict-capture.json');
  await writeFile(candidate, JSON.stringify(validCapture('codex-never-installed')));
  const completed = run(isolationGate, [
    '--fixture', 'G3-REVIEW-002', '--scenario', 'codex-never-installed', '--platform', 'macos-15-arm64',
    '--results-json', results, '--artifacts-dir', path.join(root, 'isolation-artifacts'), '--test-capture-json', candidate
  ]);
  assert.equal(completed.status, 0, completed.stderr);
}

function validChecklist(manifestSha256 = '0'.repeat(64)) {
  return {
    fixture: 'G3-REVIEW-001', status: 'executed', manifest_sha256: manifestSha256,
    reviewer: 'reviewer', executed_at: new Date().toISOString(),
    renderer: { application: 'WPS', version: '12.0', font_environment_sha256: '1'.repeat(64), parameters: {} },
    wpscomposer_source_identity: 'source-sha256:' + '2'.repeat(64),
    terms_review: { owner: 'licensing', decision: 'approved' },
    results: Object.fromEntries([
      'provenance_and_confinement', 'docx_structure', 'docx_visual', 'pptx_structure',
      'pptx_visual', 'pdf_structure', 'pdf_visual', 'corrupt_tail_failed_terminal',
      'oversize_unsupported'
    ].map((key) => [key, true])),
    evidence: ['screenshot-1.png'], concerns: []
  };
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function validCapture(scenario) {
  const states = {
    'codex-never-installed': ['never-installed-attested', false, false, true],
    'codex-installed-not-running': ['installed-not-running', false, false, false],
    'codex-running': ['installed-running', true, false, false],
    'codex-config-mutated': ['installed-config-mutated', false, true, false]
  };
  const [state, running, mutated, attested] = states[scenario];
  const probe = (value) => ({ checked: true, sample_count: 1, evidence_sha256: value.repeat(64), forbidden_matches: [] });
  const provenance = validProvenance();
  const manifestSha256 = '0'.repeat(64);
  const metrics = validMetrics(manifestSha256);
  metrics.provenance.samples = {
    progress: metrics.provenance.samples.progress,
    cached_first_page: metrics.provenance.samples.cachedFirstPage,
    authoritative_first_page: metrics.provenance.samples.authoritativeFirstPage,
    interactions: metrics.provenance.samples.interactions
  };
  metrics.provenance.renderer_environment_sha256 = provenance.renderer_environment_sha256;
  return {
    schema_id: 'superwagie.g3-review-test-capture.v1', platform: 'macos-15-arm64', scenario,
    session_id: metrics.provenance.session_id, manifest_sha256: manifestSha256,
    precondition: {
      kind: scenario, verified: true,
      application_inventory: { codex_state: state, digest_sha256: 'a'.repeat(64) },
      process_state: { codex_running: running, digest_sha256: 'b'.repeat(64) },
      fixture_mutation: { applied: mutated, digest_sha256: mutated ? 'c'.repeat(64) : null },
      attestation: { required: attested, verified: attested, digest_sha256: attested ? 'd'.repeat(64) : null }
    },
    snapshot: {
      binary_sha256: '1'.repeat(64), dependency_manifest_sha256: '2'.repeat(64),
      renderer_manifest_sha256: provenance.renderer_environment_sha256,
      preview_hashes: [{ page_id: 'pdf:page-1', sha256: '4'.repeat(64) }, { page_id: 'docx:page-1', sha256: '5'.repeat(64) }],
      probes: { process: probe('6'), paths: probe('7'), network: probe('8') }
    },
    provenance, metrics, complete: {
      trusted: true, fixture: 'G3-REVIEW-001', session_id: metrics.provenance.session_id,
      manifest_sha256: manifestSha256, metrics_file: 'review-automation-metrics.json',
      completed_at: metrics.provenance.captured_at, preview_hashes: undefined
    }
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
