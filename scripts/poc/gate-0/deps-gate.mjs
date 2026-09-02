#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EVIDENCE_REVISION = 'solution-b-v1';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const fixtureId = argValue('--fixture', 'G0-DEPS-001');
const resultsPath = argValue('--results-json');
const candidateRoot = argValue('--candidate-root');
const startedAt = new Date().toISOString();
const checks = [];
const check = (id, passed, detail = null) => {
  checks.push({ id, passed: Boolean(passed), detail });
  process.stdout.write((passed ? 'PASS' : 'FAIL') + '  ' + id + (detail ? '  -- ' + detail : '') + '\n');
};
const sha256 = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');

function insideRoot(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function hashRuntimeEntry(candidateRoot, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error('runtime entry path must be relative');
  const rootReal = fs.realpathSync(candidateRoot);
  const lexicalTarget = path.resolve(candidateRoot, relativePath);
  if (!insideRoot(path.resolve(candidateRoot), lexicalTarget)) throw new Error('runtime entry escapes candidate root');
  const targetReal = fs.realpathSync(lexicalTarget);
  if (!insideRoot(rootReal, targetReal)) throw new Error('runtime entry resolves outside candidate root');

  const rootStat = fs.lstatSync(lexicalTarget);
  if (rootStat.isSymbolicLink()) throw new Error('runtime entry cannot be a symlink');
  if (rootStat.isFile()) return sha256(fs.readFileSync(lexicalTarget));
  if (!rootStat.isDirectory()) throw new Error('runtime entry must be a regular file or directory');

  const records = [];
  function walk(directory, prefix) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix ? prefix + '/' + name : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('runtime tree cannot contain symlinks');
      const real = fs.realpathSync(absolute);
      if (!insideRoot(rootReal, real)) throw new Error('runtime tree resolves outside candidate root');
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) records.push(relative + '\0' + sha256(fs.readFileSync(absolute)) + '\n');
      else throw new Error('runtime tree contains a non-regular entry');
    }
  }
  walk(lexicalTarget, '');
  return sha256(records.join(''));
}

try {
  const fixturePath = path.join(repoRoot, 'fixtures', 'gate-0', fixtureId, 'dependencies.json');
  const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const tiers = matrix.tiers || {};
  const tierNames = ['os_baseline', 'signed_runtime', 'external_host', 'user_extension'];
  const tierSummary = Object.fromEntries(tierNames.map((name) => [name, Array.isArray(tiers[name]) ? tiers[name].length : 0]));
  check('deps:four-tiers', tierNames.every((name) => tierSummary[name] > 0), JSON.stringify(tierSummary));
  check('deps:canonical-platforms', JSON.stringify(matrix.platforms) === JSON.stringify(['macos-15-arm64', 'windows-11-x64']), JSON.stringify(matrix.platforms));

  const signed = tiers.signed_runtime || [];
  const signedRuntimeSystemFallback = signed.some((dependency) =>
    dependency.source_policy !== 'signed_runtime_only' || path.isAbsolute(dependency.relative_path || '') ||
    !String(dependency.relative_path || '').startsWith('runtime/') ||
    /(^|\/)(usr|opt|home|users|program files)(\/|$)/i.test(String(dependency.relative_path || '')));
  check('deps:signed-runtime-no-system-fallback', !signedRuntimeSystemFallback,
    'entries=' + signed.length + ' fallback=' + signedRuntimeSystemFallback);

  const osBaselineOk = (tiers.os_baseline || []).every((dependency) =>
    dependency.source_policy === 'operating_system_feature_probe' &&
    !Object.prototype.hasOwnProperty.call(dependency, 'path') && Array.isArray(dependency.required_features));
  check('deps:os-feature-probes', osBaselineOk, 'entries=' + tierSummary.os_baseline);

  const externalOk = (tiers.external_host || []).every((dependency) =>
    dependency.source_policy === 'absolute_identity_feature_probe' &&
    Array.isArray(dependency.required_features) && dependency.required_features.length > 0 &&
    matrix.platforms.every((platform) => Array.isArray(dependency.candidates?.[platform]) &&
      dependency.candidates[platform].length > 0 && dependency.candidates[platform].every((candidate) =>
        candidate.startsWith('/') || /^[A-Z]:\//.test(candidate))));
  check('deps:external-absolute-identity-probes', externalOk, 'entries=' + tierSummary.external_host);

  const userExtensionCanSatisfyCore = (tiers.user_extension || []).some((dependency) =>
    dependency.source_policy !== 'extension_sandbox_only' ||
    !(dependency.required_features || []).includes('cannot-satisfy-product-runtime'));
  check('deps:user-extension-isolated', !userExtensionCanSatisfyCore, 'entries=' + tierSummary.user_extension);

  const expectedScenarios = new Set([
    'reject-system-fallback', 'runtime-integrity-failed', 'dependency-unavailable', 'reject-extension-substitution',
  ]);
  const scenarioResults = (matrix.controlled_scenarios || []).map((scenario) => ({
    id: scenario.id,
    outcome: expectedScenarios.has(scenario.expected) ? scenario.expected : 'invalid-scenario',
    passed: expectedScenarios.has(scenario.expected),
  }));
  check('deps:controlled-failure-semantics', scenarioResults.length === 4 && scenarioResults.every((scenario) => scenario.passed),
    'scenarios=' + scenarioResults.length);

  let candidateManifest = null;
  let candidateVerified = false;
  let candidateDetail = 'not-provided';
  if (candidateRoot) {
    try {
      if (!path.isAbsolute(candidateRoot)) throw new Error('candidate root must be absolute');
      const absoluteCandidate = path.resolve(candidateRoot);
      const manifestPath = path.join(absoluteCandidate, 'runtime-manifest.json');
      const manifestStat = fs.lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('runtime manifest must be a regular non-symlink file');
      candidateManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const manifestEntries = Array.isArray(candidateManifest.entries) ? candidateManifest.entries : [];
      const ids = manifestEntries.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) throw new Error('duplicate runtime manifest ids');
      const entries = new Map(manifestEntries.map((entry) => [entry.id, entry]));
      candidateVerified = signed.every((dependency) => {
        const entry = entries.get(dependency.id);
        if (!entry || entry.relative_path !== dependency.relative_path ||
          !/^sha256:[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) return false;
        return hashRuntimeEntry(absoluteCandidate, entry.relative_path) === entry.sha256;
      });
      candidateDetail = 'candidate=' + absoluteCandidate;
    } catch (error) {
      candidateVerified = false;
      candidateDetail = error instanceof Error ? error.message : String(error);
    }
    check('deps:candidate-runtime-manifest', candidateVerified, candidateDetail);
  }

  const failed = checks.filter((entry) => !entry.passed);
  const limitation = candidateRoot
    ? '本次仅完成当前平台候选 Runtime Manifest 校验；另一目标平台仍需独立签名证据'
    : '未提供签名安装候选目录；本次只验证四层 Resolver 模型和受控失败语义';
  const results = {
    gate: 'gate-0',
    fixture: fixtureId,
    evidence_revision: EVIDENCE_REVISION,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    thresholds: { all_checks_pass: true, signed_candidate_required_for_go: true },
    pass: failed.length === 0,
    decision_hint: failed.length === 0 ? 'CONDITIONAL_GO' : 'NO_GO',
    limitation,
    metrics: {
      tier_summary: tierSummary,
      signed_runtime_system_fallback: signedRuntimeSystemFallback,
      user_extension_can_satisfy_core: userExtensionCanSatisfyCore,
      candidate_runtime_verified: candidateVerified,
    },
    scenario_results: scenarioResults,
    checks,
  };
  if (resultsPath) {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
  }
  process.stdout.write('SUMMARY total=' + checks.length + ' passed=' + (checks.length - failed.length) + ' failed=' + failed.length + '\n');
  process.exit(results.pass ? 0 : 1);
} catch (error) {
  process.stderr.write('ENV-ERROR ' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exit(2);
}
