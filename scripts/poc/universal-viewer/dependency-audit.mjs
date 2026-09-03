import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(HERE, 'fixtures', 'dependency-policy.json');

class InputError extends Error {}

function input(message) {
  throw new InputError(`Dependency audit input unavailable: ${message}`);
}

function exactVersion(value) {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function packageName(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index === -1 ? lockPath : lockPath.slice(index + marker.length);
}

function licenseDecision(policy, name, version, license) {
  return (policy.license_decisions ?? []).find((item) => (
    item.package === `${name}@${version}` && item.license === license && typeof item.decision === 'string'
  ));
}

function licenseAllowed(policy, name, version, license) {
  if (typeof license !== 'string' || license.trim() === '') return false;
  if ((policy.allowed_licenses ?? []).includes(license)) {
    const blockedAlternative = (policy.blocked_license_families ?? []).some((family) => license.toUpperCase().includes(family));
    return !blockedAlternative || Boolean(licenseDecision(policy, name, version, license));
  }
  return Boolean(licenseDecision(policy, name, version, license));
}

function exceptionFor(policy, name, advisory, now) {
  return (policy.vulnerability_exceptions ?? []).find((item) => (
    item.package === name
    && item.advisory === advisory
    && typeof item.owner === 'string'
    && typeof item.replacement_plan === 'string'
    && Date.parse(item.expires_at) > Date.parse(now)
  ));
}

export function auditDependencyData({ lock, audit, policy, now = new Date().toISOString() } = {}) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') input('package-lock v3 packages map is required');
  if (!audit?.metadata?.vulnerabilities || typeof audit.metadata.vulnerabilities !== 'object') input('npm audit metadata is required');
  if (!policy || typeof policy !== 'object') input('dependency policy is required');
  const dependencies = [];
  const violations = [];
  for (const [lockPath, metadata] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (lockPath === '') continue;
    const name = packageName(lockPath);
    const identity = `${name}@${metadata.version ?? '<missing>'}`;
    dependencies.push({
      identity,
      lock_path: lockPath,
      license: metadata.license ?? 'UNKNOWN',
      production: metadata.dev !== true && metadata.optional !== true,
      resolved: metadata.resolved ?? null,
      integrity: metadata.integrity ?? null,
    });
    if (!exactVersion(metadata.version)) violations.push({ rule: 'non_exact_identity', package: identity });
    if (typeof metadata.resolved !== 'string' || typeof metadata.integrity !== 'string') {
      violations.push({ rule: 'unfixed_artifact', package: identity });
    }
    if (!licenseAllowed(policy, name, metadata.version, metadata.license)) {
      violations.push({ rule: 'license_not_admitted', package: identity, license: metadata.license ?? 'UNKNOWN' });
    }
    if (metadata.dev !== true && metadata.optional !== true && metadata.hasInstallScript === true) {
      violations.push({ rule: 'production_install_script', package: identity });
    }
  }

  let moderateOrHigher = 0;
  for (const [name, finding] of Object.entries(audit.vulnerabilities ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!['moderate', 'high', 'critical'].includes(finding.severity)) continue;
    moderateOrHigher += 1;
    const advisories = (finding.via ?? []).flatMap((item) => typeof item === 'object' && item.url ? [item.url.split('/').at(-1)] : []);
    const excepted = advisories.length > 0 && advisories.every((advisory) => exceptionFor(policy, name, advisory, now));
    if (!excepted) violations.push({ rule: 'production_vulnerability', package: name, severity: finding.severity, advisories });
  }
  const counts = audit.metadata.vulnerabilities;
  const metadataTotal = ['moderate', 'high', 'critical'].reduce((sum, severity) => sum + (Number.isInteger(counts[severity]) ? counts[severity] : 0), 0);
  moderateOrHigher = Math.max(moderateOrHigher, metadataTotal);
  if (moderateOrHigher > 0 && !violations.some((item) => item.rule === 'production_vulnerability')) {
    violations.push({ rule: 'production_vulnerability', package: '<audit-metadata>', severity: 'moderate_or_higher', advisories: [] });
  }

  violations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    schema_id: 'superwagie.viewer-dependency-audit.v1',
    decision: violations.length === 0 ? 'GO' : 'NO_GO',
    lockfile_version: lock.lockfileVersion,
    dependency_count: dependencies.length,
    dependencies,
    moderate_or_higher: moderateOrHigher,
    forbidden_runtime_edges: 0,
    violations,
  };
}

function requireRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) input('candidate root must be an explicit absolute path');
  try {
    if (!statSync(value).isDirectory()) input('candidate root is not a directory');
  } catch {
    input('candidate root does not exist');
  }
  return path.resolve(value);
}

function npmAudit(candidateRoot) {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: candidateRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    if (error.stdout) {
      try { return JSON.parse(error.stdout.toString()); } catch { /* fall through */ }
    }
    input(`npm audit could not run: ${error.message}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || !['--candidate-root', '--output'].includes(name)) input(`${name ?? '<argument>'} is unsupported or missing a value`);
    if (name === '--candidate-root') options.candidateRoot = value;
    else options.outputPath = value;
  }
  if (!options.candidateRoot || !options.outputPath) input('--candidate-root and --output are required');
  const root = requireRoot(options.candidateRoot);
  const lockBytes = readFileSync(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const audit = npmAudit(root);
  const policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
  const result = auditDependencyData({ lock, audit, policy });
  result.package_lock_sha256 = createHash('sha256').update(lockBytes).digest('hex');
  const output = path.resolve(options.outputPath);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision !== 'GO') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof InputError ? 2 : 1;
  }
}
