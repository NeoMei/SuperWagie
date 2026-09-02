#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateIsolationEvidence } from './isolation-evidence.mjs';
import {
  captureTrustedProvenance,
  privateWpsLaunchEnvironment,
  validateRendererProvenanceDocument
} from './review-provenance.mjs';
import {
  REQUIRED_METRICS,
  deriveReviewOutcome,
  metricDecision,
  validateAutomationCompletion,
  validateAutomationFailure,
  validateMetricsDocument
} from './standard-review-evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json');
const DEFAULT_EXECUTABLE = path.join(HERE, `reviewer-shell/target/debug/superwagie-reviewer-poc${process.platform === 'win32' ? '.exe' : ''}`);
const MACOS_IOREG = '/usr/sbin/ioreg';
const MACOS_IOREG_ARGS = ['-n', 'Root', '-d', '1'];
const MACOS_IOREG_TIMEOUT_MS = 2_000;
const MACOS_IOREG_MAX_BUFFER = 128 * 1024;
const CHECKLIST_KEYS = [
  'provenance_and_confinement', 'docx_structure', 'docx_visual', 'pptx_structure',
  'pptx_visual', 'pdf_structure', 'pdf_visual', 'corrupt_tail_failed_terminal',
  'oversize_unsupported'
];

function parseArgs(argv) {
  const result = { reviewerArgs: [] };
  const aliases = new Map([['--review-checklist', 'checklist'], ['--checklist-result', 'checklist']]);
  const names = new Map([
    ['--fixture', 'fixture'], ['--platform', 'platform'], ['--results-json', 'resultsJson'], ['--artifacts-dir', 'artifactsDir'],
    ['--wps-python', 'wpsPython'], ['--wpscomposer-root', 'wpscomposerRoot'], ['--wps-application', 'wpsApplication'],
    ['--wps-node', 'wpsNode'],
    ['--wps-home', 'wpsHome'],
    ['--scenario', 'scenario'], ['--fixture-manifest', 'fixtureManifest'],
    ['--reviewer-executable', 'reviewerExecutable'], ['--metrics-json', 'metricsJson'],
    ['--isolation-result', 'isolationResult'], ['--isolation-evidence-root', 'isolationEvidenceRoot'],
    ['--machine-profile', 'machineProfile'], ['--test-provenance-json', 'testProvenanceJson']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') return { help: true, reviewerArgs: [] };
    if (token === '--reviewer-arg') {
      if (index + 1 >= argv.length) throw new CliError('MISSING_ARGUMENT', '--reviewer-arg requires a value');
      result.reviewerArgs.push(argv[++index]);
      continue;
    }
    const key = aliases.get(token) ?? names.get(token);
    if (!key || index + 1 >= argv.length) throw new CliError('UNKNOWN_ARGUMENT', `invalid argument: ${token}`);
    if (result[key] !== undefined) throw new CliError('DUPLICATE_ARGUMENT', `duplicate argument: ${token}`);
    result[key] = argv[++index];
  }
  return result;
}

class CliError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new CliError('RELATIVE_PATH_REJECTED', `${label} must be an absolute path`);
  }
  return path.normalize(value);
}

async function isFile(value) {
  try { return (await stat(value)).isFile(); } catch { return false; }
}

async function isDirectory(value) {
  try { return (await stat(value)).isDirectory(); } catch { return false; }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function baseResult(fixture, decision, reasons, extra = {}) {
  return {
    schema_version: 1,
    gate: 'gate-3',
    fixture: fixture ?? null,
    pass: decision === 'GO' || decision === 'CONDITIONAL_GO',
    status: decision === 'BLOCKED_ENVIRONMENT' ? 'blocked' : decision === 'NO_GO' ? 'failed' : 'passed',
    decision_hint: decision,
    reasons: [...new Set(reasons)].sort(),
    limitations: [],
    ...extra
  };
}

async function writeResult(file, result) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

function validateChecklist(checklist, manifestSha256) {
  const errors = [];
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist)
    || checklist.fixture !== 'G3-REVIEW-001' || checklist.status === 'example-not-executed'
    || checklist.manifest_sha256 !== manifestSha256
    || typeof checklist.reviewer !== 'string' || checklist.reviewer.length === 0
    || !Number.isFinite(Date.parse(checklist.executed_at))
    || checklist.renderer?.application !== 'WPS'
    || typeof checklist.renderer?.version !== 'string' || checklist.renderer.version.length === 0
    || !/^[0-9a-f]{64}$/.test(checklist.renderer?.font_environment_sha256 ?? '')
    || !Array.isArray(checklist.evidence) || checklist.evidence.length === 0
    || checklist.evidence.some((entry) => typeof entry !== 'string' || entry.length === 0 || path.isAbsolute(entry) || entry.includes('..'))
    || !Array.isArray(checklist.concerns)) errors.push('CHECKLIST_SCHEMA_INVALID');
  if (!checklist?.results || Object.keys(checklist.results).sort().join('\0') !== [...CHECKLIST_KEYS].sort().join('\0')
    || CHECKLIST_KEYS.some((key) => typeof checklist.results?.[key] !== 'boolean')) errors.push('CHECKLIST_RESULTS_INVALID');
  if (CHECKLIST_KEYS.some((key) => checklist.results?.[key] === false)) errors.push('CHECKLIST_ITEM_FAILED');
  const termsApproved = checklist?.terms_review?.decision === 'approved'
    && typeof checklist.terms_review?.owner === 'string' && checklist.terms_review.owner.length > 0;
  const sourceRecorded = /^source-sha256:[0-9a-f]{64}$/.test(checklist?.wpscomposer_source_identity ?? '');
  return { errors: [...new Set(errors)], termsApproved, sourceRecorded };
}

async function validateIsolationPrerequisite(file, evidenceRoot, platform) {
  if (!file || !evidenceRoot) return false;
  await validateIsolationEvidence(file, evidenceRoot, { scenario: 'codex-never-installed', platform });
  return true;
}

export async function runOwnedProcess(executable, args, environment, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { env: environment, stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    let timedOut = false;
    let hardTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    };
    child.once('error', () => finish({ code: null, timedOut: false, launchFailed: true }));
    child.once('exit', (code, signal) => finish({ code, signal, timedOut, launchFailed: false }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeoutMs);
  });
}

function macConsoleSessionIsUnlocked(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > MACOS_IOREG_MAX_BUFFER) return false;
  const consoleLine = output.split(/\r?\n/).find((line) => line.includes('"IOConsoleUsers"'));
  if (!consoleLine) return false;
  const records = consoleLine.match(/\{[^{}]*\}/g) ?? [];
  const assignments = (record, key) => {
    const occurrences = [...record.matchAll(new RegExp(`"${key}"\\s*=`, 'g'))].length;
    const values = [...record.matchAll(new RegExp(`"${key}"\\s*=\\s*([^,}]*)\\s*(?=[,}])`, 'g'))]
      .map((match) => match[1].trim());
    return { occurrences, values };
  };
  const exactBoolean = (record, key, expected) => {
    const found = assignments(record, key);
    return found.occurrences === 1 && found.values.length === 1 && found.values[0] === expected;
  };
  const exactUser = (record) => {
    const occurrences = [...record.matchAll(/"kCGSSessionUserNameKey"\s*=/g)].length;
    const values = [...record.matchAll(/"kCGSSessionUserNameKey"\s*=\s*"([^"\r\n]+)"\s*(?:[,}])/g)];
    return occurrences === 1 && values.length === 1 && values[0][1].trim().length > 0;
  };
  const consoleCandidates = records.filter((record) =>
    assignments(record, 'kCGSSessionOnConsoleKey').values.includes('Yes'));
  const currentConsole = consoleCandidates.filter((record) =>
    exactBoolean(record, 'kCGSSessionOnConsoleKey', 'Yes'));
  const lockStateIsAdmitted = (record) => {
    const found = assignments(record, 'CGSSessionScreenIsLocked');
    return found.occurrences === 0
      || (found.occurrences === 1 && found.values.length === 1 && found.values[0] === 'No');
  };
  return currentConsole.length === 1
    && consoleCandidates.length === 1
    && exactUser(currentConsole[0])
    && exactBoolean(currentConsole[0], 'kCGSessionLoginDoneKey', 'Yes')
    && lockStateIsAdmitted(currentConsole[0]);
}

async function probeMacInteractiveSession(execFileImpl) {
  return new Promise((resolve) => {
    try {
      execFileImpl(MACOS_IOREG, MACOS_IOREG_ARGS, {
        encoding: 'utf8', timeout: MACOS_IOREG_TIMEOUT_MS,
        maxBuffer: MACOS_IOREG_MAX_BUFFER, shell: false, windowsHide: true
      }, (error, stdout, stderr) => {
        if (error || typeof stdout !== 'string' || typeof stderr !== 'string'
          || Buffer.byteLength(stderr) > MACOS_IOREG_MAX_BUFFER) {
          resolve(false);
          return;
        }
        resolve(macConsoleSessionIsUnlocked(stdout));
      });
    } catch {
      resolve(false);
    }
  });
}

async function main(argv, overrides = {}) {
  const dependencies = {
    execFile, captureTrustedProvenance, privateWpsLaunchEnvironment,
    runOwnedProcess, ...overrides
  };
  let args;
  try { args = parseArgs(argv); } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (args.help) {
    console.log('review-gate.mjs --fixture G3-REVIEW-001 --platform ID --results-json ABS --artifacts-dir ABS --wps-python ABS --wpscomposer-root ABS --wps-application ABS --wps-node ABS');
    return 0;
  }
  let resultsPath;
  let artifactsDir;
  if (args.wpsPython === '') delete args.wpsPython;
  if (args.wpscomposerRoot === '') delete args.wpscomposerRoot;
  if (args.wpsApplication === '') delete args.wpsApplication;
  if (args.wpsNode === '') delete args.wpsNode;
  if (args.wpsHome === '') delete args.wpsHome;
  if (args.checklist === '') delete args.checklist;
  if (args.scenario === '') delete args.scenario;
  for (const key of ['machineProfile', 'testProvenanceJson', 'isolationResult', 'isolationEvidenceRoot']) if (args[key] === '') delete args[key];
  try {
    resultsPath = requireAbsolute(args.resultsJson, '--results-json');
    artifactsDir = requireAbsolute(args.artifactsDir, '--artifacts-dir');
    for (const [value, label] of [[args.wpsPython, '--wps-python'], [args.wpscomposerRoot, '--wpscomposer-root'], [args.wpsApplication, '--wps-application'], [args.wpsNode, '--wps-node'], [args.wpsHome, '--wps-home'],
      [args.fixtureManifest, '--fixture-manifest'], [args.reviewerExecutable, '--reviewer-executable'],
      [args.metricsJson, '--metrics-json'], [args.checklist, '--checklist-result'],
      [args.isolationResult, '--isolation-result'], [args.isolationEvidenceRoot, '--isolation-evidence-root'],
      [args.machineProfile, '--machine-profile'], [args.testProvenanceJson, '--test-provenance-json']]) if (value !== undefined) requireAbsolute(value, label);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  await mkdir(artifactsDir, { recursive: true });
  if (args.fixture !== 'G3-REVIEW-001') {
    await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['UNKNOWN_FIXTURE']));
    return 2;
  }
  const platform = args.platform ?? (process.platform === 'darwin' && process.arch === 'arm64'
    ? 'macos-15-arm64' : process.platform === 'win32' && process.arch === 'x64' ? 'windows-11-x64' : null);
  if (!platform || !/^(?:macos-15-arm64|windows-11-x64)$/.test(platform)) {
    await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['PLATFORM_INVALID']));
    return 2;
  }
  if (!args.wpsPython || !args.wpscomposerRoot || (!args.metricsJson && !args.testProvenanceJson && !args.wpsApplication)) {
    await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['MISSING_EXPLICIT_WPS_INPUTS']));
    return 2;
  }
  if (!await isFile(args.wpsPython) || !await isDirectory(args.wpscomposerRoot)) {
    await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['INVALID_EXPLICIT_WPS_INPUTS']));
    return 2;
  }
  if (args.wpsNode && !await isFile(args.wpsNode)) {
    await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['INVALID_EXPLICIT_WPS_INPUTS']));
    return 2;
  }
  if (args.wpsHome && !await isDirectory(args.wpsHome)) {
    await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['INVALID_EXPLICIT_WPS_INPUTS']));
    return 2;
  }
  const manifestPath = args.fixtureManifest ?? DEFAULT_MANIFEST;
  if (!await isFile(manifestPath)) {
    await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['FIXTURE_MANIFEST_MISSING']));
    return 2;
  }
  const manifestSha256 = await sha256File(manifestPath);
  if (platform === 'macos-15-arm64' && !args.metricsJson && !args.checklist
    && !await probeMacInteractiveSession(dependencies.execFile)) {
    await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['INTERACTIVE_SESSION_UNAVAILABLE']));
    return 2;
  }
  const startedAt = Date.now();
  const sessionId = randomBytes(16).toString('hex');
  let automationCompletion = null;
  let rendererProvenance = null;
  if (!args.metricsJson || args.testProvenanceJson) {
    try {
      rendererProvenance = args.testProvenanceJson
        ? await readJson(args.testProvenanceJson)
        : await dependencies.captureTrustedProvenance({ wpsPython: args.wpsPython, wpsComposerRoot: args.wpscomposerRoot, wpsApplication: args.wpsApplication, machineProfile: args.machineProfile, platform });
      validateRendererProvenanceDocument(rendererProvenance, {
        platform, representative: true
      });
      await writeResult(path.join(artifactsDir, 'renderer-provenance.json'), rendererProvenance);
    } catch {
      await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['RENDERER_PROVENANCE_UNAVAILABLE']));
      return 2;
    }
  }
  let metricsPath = args.metricsJson;
  if (!metricsPath) {
    const executable = args.reviewerExecutable ?? DEFAULT_EXECUTABLE;
    if (!await isFile(executable)) {
      await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['REVIEWER_EXECUTABLE_MISSING']));
      return 2;
    }
    const automation = !args.checklist;
    let privateWpsEnvironment;
    try {
      privateWpsEnvironment = await dependencies.privateWpsLaunchEnvironment({
        wpsApplication: args.wpsApplication,
        machineProfile: args.machineProfile,
        provenance: rendererProvenance
      });
    } catch {
      await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['WPS_TARGET_BINDING_UNAVAILABLE']));
      return 2;
    }
    const environment = {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      SUPERWAGIE_REVIEW_EVIDENCE_DIR: artifactsDir,
      SUPERWAGIE_WPS_PYTHON: args.wpsPython,
      SUPERWAGIE_WPSCOMPOSER_ROOT: args.wpscomposerRoot,
      SUPERWAGIE_WPS_RENDERER_VERSION: rendererProvenance.wps.exact_version,
      SUPERWAGIE_WPS_RENDERER_ENV_HASH: rendererProvenance.renderer_environment_sha256,
      SUPERWAGIE_WPS_FONT_ENV_HASH: rendererProvenance.font_manifest_sha256,
      ...(args.wpsNode ? { SUPERWAGIE_WPS_NODE: args.wpsNode } : {}),
      ...(args.wpsHome ? {
        SUPERWAGIE_WPS_CONTAINER_HOME_PROBE: 'required',
        SUPERWAGIE_WPS_PROBED_HOME: args.wpsHome
      } : {}),
      SUPERWAGIE_REVIEW_PROVENANCE_SHA256: rendererProvenance.renderer_environment_sha256,
      SUPERWAGIE_REVIEW_MACHINE_REPRESENTATIVE: rendererProvenance.machine.representative ? '1' : '0',
      ...privateWpsEnvironment,
      ...(automation ? {
        SUPERWAGIE_REVIEW_AUTOMATION: '1',
        SUPERWAGIE_REVIEW_FIXTURE_MANIFEST: manifestPath,
        SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256: manifestSha256,
        SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID: sessionId
      } : {})
    };
    const processResult = await dependencies.runOwnedProcess(executable, args.reviewerArgs, environment);
    if (processResult.timedOut || processResult.launchFailed || processResult.code !== 0) {
      if (automation && !processResult.timedOut && !processResult.launchFailed && processResult.code === 2) {
        let failure = null;
        try { failure = await readJson(path.join(artifactsDir, 'automation-failure.json')); } catch { failure = null; }
        const failureValidation = validateAutomationFailure(failure, {
          fixture: args.fixture,
          sessionId,
          manifestSha256,
          rendererEnvironmentSha256: rendererProvenance.renderer_environment_sha256,
          notBefore: startedAt,
          now: Date.now()
        });
        if (failureValidation.errors.length === 0) {
          if (failure.state === 'dependency_missing') {
            await writeResult(resultsPath, baseResult(args.fixture, 'BLOCKED_ENVIRONMENT', ['WPS_RUNTIME_INCOMPATIBLE']));
            return 2;
          }
          await writeResult(resultsPath, baseResult(args.fixture, 'NO_GO', [failure.error_code]));
          return 1;
        }
      }
      await writeResult(resultsPath, baseResult(args.fixture, 'NO_GO', [processResult.timedOut ? 'AUTOMATION_TIMEOUT' : 'REVIEWER_PROCESS_FAILED']));
      return 1;
    }
    metricsPath = path.join(artifactsDir, automation ? 'review-automation-metrics.json' : 'review-performance.json');
    if (automation) {
      const completePath = path.join(artifactsDir, 'automation-complete.json');
      try { automationCompletion = await readJson(completePath); } catch { automationCompletion = null; }
      if (!automationCompletion) {
        await writeResult(resultsPath, baseResult(args.fixture, 'NO_GO', ['AUTOMATION_COMPLETION_INVALID']));
        return 1;
      }
    }
  }
  let metricsDocument;
  try { metricsDocument = await readJson(metricsPath); } catch { metricsDocument = null; }
  const metricsValidation = validateMetricsDocument(metricsDocument, {
    fixture: args.fixture, manifestSha256,
    rendererEnvironmentSha256: rendererProvenance?.renderer_environment_sha256,
    sessionId: args.metricsJson ? null : (!args.checklist ? sessionId : null)
  });
  if (metricsValidation.errors.length > 0) {
    await writeResult(resultsPath, baseResult(args.fixture, 'NO_GO', metricsValidation.errors));
    return 1;
  }
  if (automationCompletion) {
    const completionValidation = validateAutomationCompletion(automationCompletion, {
      fixture: args.fixture,
      sessionId,
      manifestSha256,
      capturedAt: metricsDocument.provenance.captured_at,
      notBefore: startedAt
    });
    if (completionValidation.errors.length > 0) {
      await writeResult(resultsPath, baseResult(args.fixture, 'NO_GO', ['AUTOMATION_COMPLETION_INVALID']));
      return 1;
    }
  }
  const thresholds = metricDecision(metricsDocument.metrics);
  if (thresholds.correctness.length > 0) {
    await writeResult(resultsPath, baseResult(args.fixture, 'NO_GO', thresholds.correctness, { metrics: metricsDocument.metrics, metrics_provenance: metricsDocument.provenance }));
    return 1;
  }
  let checklistValidation = null;
  if (args.checklist) {
    try { checklistValidation = validateChecklist(await readJson(args.checklist), manifestSha256); }
    catch { checklistValidation = { errors: ['CHECKLIST_MALFORMED'], termsApproved: false, sourceRecorded: false }; }
    if (checklistValidation.errors.length > 0) {
      await writeResult(resultsPath, baseResult(args.fixture, 'NO_GO', checklistValidation.errors));
      return 1;
    }
  }
  let isolationPassed = false;
  try { isolationPassed = await validateIsolationPrerequisite(args.isolationResult, args.isolationEvidenceRoot, platform); } catch { isolationPassed = false; }
  const outcome = deriveReviewOutcome({
    checklistPresent: Boolean(args.checklist),
    termsApproved: checklistValidation?.termsApproved ?? false,
    sourceRecorded: checklistValidation?.sourceRecorded ?? false,
    isolationPassed,
    performanceReasons: thresholds.performance,
    correctnessAccepted: metricsDocument.provenance.correctness_counters.acceptance
  });
  const { decision, reasons, limitations } = outcome;
  const result = baseResult(args.fixture, decision, reasons, {
    limitations,
    metrics: metricsDocument.metrics,
    metrics_provenance: metricsDocument.provenance,
    automation: { manifest_sha256: manifestSha256, trusted_completion: !args.metricsJson && !args.checklist }
  });
  await writeResult(resultsPath, result);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

export { REQUIRED_METRICS, main, metricDecision, validateChecklist, validateMetricsDocument };
