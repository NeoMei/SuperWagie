import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBaseline, validateProof, validateRegistry, validateTestOutput } from './policy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registryPath = 'scripts/regression/accepted-features.json';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const args = process.argv.slice(2);
const staged = args.includes('--staged');
if (args.some((arg) => arg !== '--staged')) throw new Error('Usage: node scripts/regression/run.mjs [--staged]');
const runId = randomUUID();
const outputRoot = join(root, 'apps/desktop/test-results/regression', runId);
mkdirSync(outputRoot, { recursive: true });
const report = { schema_version: 1, run_id: runId, started_at: new Date().toISOString(), status: 'running', platform: { os: process.platform, arch: process.arch }, head: git('rev-parse', 'HEAD'), suites: [], admission_effect: 'none', ui_execution_mode: 'background_non_focusable', native_foreground_acceptance: false };

function fingerprint() {
  const paths = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    const absolute = join(root, path);
    hash.update(path + '\0');
    if (existsSync(absolute) && lstatSync(absolute).isFile()) hash.update(readFileSync(absolute));
    else hash.update('<not-a-regular-file>');
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function command(id, executable, commandArgs, format, minimum) {
  process.stdout.write(`[regression] ${id} …\n`);
  const start = Date.now();
  const log = createWriteStream(join(outputRoot, `${id}.log`));
  let output = '';
  const outcome = await new Promise((resolve) => {
    const child = spawn(executable, commandArgs, {
      cwd: root, detached: true,
      env: { ...process.env, SUPERWAGIE_REGRESSION_RUN_ID: runId, SUPERWAGIE_REGRESSION_OUTPUT_ROOT: outputRoot, SUPERWAGIE_RUN_UI_TESTS: '0', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk) => { output += chunk.toString(); log.write(chunk); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }, 240_000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, error: error.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  await new Promise((resolve) => log.end(resolve));
  report.suites.push({ id, ...outcome, duration_ms: Date.now() - start, log: `${id}.log` });
  if (outcome.code !== 0) throw new Error(`${id} failed: ${outcome.error || outcome.signal || outcome.code}\n${output.slice(-6000)}`);
  if (format) validateTestOutput(output, format, minimum);
  process.stdout.write(`[regression] ${id} passed\n`);
}

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('BLOCKED_ENVIRONMENT: this gate requires a real macOS arm64 desktop; no skipped-GREEN fallback');
  report.platform.version = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
  if (staged) {
    if (git('diff', '--name-only') || git('ls-files', '--others', '--exclude-standard')) {
      throw new Error('Commit gate requires the tested working tree to match the index. Stage intended files and resolve unstaged/untracked changes first; nothing was stashed or discarded.');
    }
    report.index_tree = git('write-tree');
  }
  const registry = JSON.parse(readFileSync(join(root, registryPath), 'utf8'));
  validateRegistry(registry);
  const base = process.env.REGRESSION_BASE_SHA || 'HEAD';
  if (base !== 'HEAD' && !/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid REGRESSION_BASE_SHA');
  const baseHasRegistry = git('ls-tree', '--name-only', base, '--', registryPath);
  if (baseHasRegistry) validateBaseline(JSON.parse(git('show', `${base}:${registryPath}`)), registry);
  const changed = [...new Set([
    ...git('diff', '--name-only', '-z', base, '--').split('\0'),
    ...git('ls-files', '-z', '--others', '--exclude-standard').split('\0'),
  ])].filter(Boolean);
  report.protected_changes_requiring_review = changed.filter((path) => registry.protected_paths.some((prefix) => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix))));
  if (report.protected_changes_requiring_review.length) {
    process.stdout.write(`[regression] Review protected changes: ${report.protected_changes_requiring_review.join(', ')}\n`);
  }
  report.source_fingerprint = fingerprint();
  await command('gate-self-tests', process.execPath, ['--test', '--test-reporter=tap', 'scripts/regression/policy.test.mjs'], 'tap', 10);
  await command('spec-refs', process.execPath, ['scripts/check-spec-refs.mjs']);
  await command('rust-tests', 'cargo', ['test', '--locked', '--manifest-path', 'crates/product-core/Cargo.toml'], 'rust', 40);
  await command('rust-clippy', 'cargo', ['clippy', '--locked', '--manifest-path', 'crates/product-core/Cargo.toml', '--all-targets', '--', '-D', 'warnings']);
  await command('core-build', 'cargo', ['build', '--locked', '--manifest-path', 'crates/product-core/Cargo.toml']);
  // The UI wrapper is deliberately not a unit test: its formerly skipped suite
  // is mandatory below, with a fresh receipt and every registered check required.
  const unitTests = readdirSync(join(root, 'apps/desktop/tests')).filter((file) => file.endsWith('.test.mjs') && file !== 'app-ui.test.mjs').sort();
  await command('desktop-unit', process.execPath, ['--test', '--test-reporter=tap', ...unitTests.map((file) => `apps/desktop/tests/${file}`)], 'tap', 40);
  const suites = [
    { id: 'lifecycle', script: 'test-ui.mjs', directory: 'local-mac-workspace-markdown', scope: 'local-mac-workspace-markdown' },
    { id: 'live-preview', script: 'test-live-preview.mjs', directory: 'live-preview', scope: 'local-mac-live-preview' },
    { id: 'format-toolbar', script: 'test-format-toolbar.mjs', directory: 'format-toolbar', scope: 'local-mac-format-toolbar' },
  ];
  for (const suite of suites) {
    await command(suite.id, process.execPath, [`apps/desktop/scripts/${suite.script}`]);
    const proofPath = join(outputRoot, suite.directory, 'result.json');
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    const checks = registry.features.filter((feature) => feature.suite === suite.id).flatMap((feature) => feature.checks);
    validateProof(proof, { scope: suite.scope, checks }, runId);
    report.suites.at(-1).required_checks_passed = checks.length;
    report.suites.at(-1).proof_sha256 = createHash('sha256').update(readFileSync(proofPath)).digest('hex');
  }
  if (fingerprint() !== report.source_fingerprint || git('rev-parse', 'HEAD') !== report.head) throw new Error('Source changed while regression was running; rerun against the final candidate');
  if (staged && (git('write-tree') !== report.index_tree || git('diff', '--name-only') || git('ls-files', '--others', '--exclude-standard'))) {
    throw new Error('Index or working tree changed during the commit gate; rerun against the final staged candidate');
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  process.stderr.write(`[regression] ${error.message}\n`);
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  writeFileSync(join(outputRoot, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`[regression] ${report.status}: ${join(outputRoot, 'result.json')}\n`);
}
