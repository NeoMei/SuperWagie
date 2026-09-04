#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeEvidenceRun } from '../evidence-run-init.mjs';
import { redactedGateCommand } from '../gate-3/runner-evidence.mjs';
import { runGvp0Gate, sanitizeDiagnostic } from './gvp-0-gate.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);

const REQUIRED_OPTIONS = Object.freeze(['--repo-root', '--platform', '--fixture', '--candidate-root']);

function parseExactArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== REQUIRED_OPTIONS.length * 2) throw new Error('invalid argument shape');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_OPTIONS.includes(name) || values.has(name) || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error('invalid argument shape');
    }
    values.set(name, value);
  }
  if (values.size !== REQUIRED_OPTIONS.length) throw new Error('invalid argument shape');
  const repoRoot = values.get('--repo-root');
  const candidateRoot = values.get('--candidate-root');
  const platform = values.get('--platform');
  const fixture = values.get('--fixture');
  if (!path.isAbsolute(repoRoot) || !path.isAbsolute(candidateRoot)
    || !['macos-15-arm64', 'windows-11-x64'].includes(platform)
    || fixture !== 'GVP-0-CORE-001') throw new Error('invalid argument value');
  return { repoRoot: path.resolve(repoRoot), platform, fixture, candidateRoot: path.resolve(candidateRoot) };
}

function inodeIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function writeOwned(handle, value) {
  if (handle.written) throw new Error(`output capability already consumed: ${handle.name}`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  ftruncateSync(handle.fd, 0);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(handle.fd, bytes, offset, bytes.length - offset, offset);
  fsyncSync(handle.fd);
  handle.written = true;
}

function createPublicEvidenceCapability(runRoot) {
  const rootFlags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  const fileReadFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const fileUpdateFlags = fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0);
  const createFlags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const rootFd = openSync(runRoot, rootFlags);
  const artifactsFd = openSync(path.join(runRoot, 'artifacts'), rootFlags);
  const screenshotsFd = openSync(path.join(runRoot, 'screenshots'), rootFlags);
  const manifestFd = openSync(path.join(runRoot, 'manifest.json'), fileUpdateFlags);
  const environmentFd = openSync(path.join(runRoot, 'environment.json'), fileReadFlags);
  const created = new Map();
  try {
    for (const name of ['command.txt', 'decision.md', 'stdout.log', 'stderr.log']) {
      const fd = openSync(path.join(runRoot, name), createFlags, 0o600);
      created.set(name, { name, fd, written: false });
    }
  } catch (error) {
    for (const handle of created.values()) closeSync(handle.fd);
    for (const fd of [environmentFd, manifestFd, screenshotsFd, artifactsFd, rootFd]) closeSync(fd);
    throw error;
  }
  const initialManifest = readFileSync(manifestFd);
  const identities = new Map([
    [runRoot, inodeIdentity(fstatSync(rootFd))],
    [path.join(runRoot, 'artifacts'), inodeIdentity(fstatSync(artifactsFd))],
    [path.join(runRoot, 'screenshots'), inodeIdentity(fstatSync(screenshotsFd))],
    [path.join(runRoot, 'manifest.json'), inodeIdentity(fstatSync(manifestFd))],
    [path.join(runRoot, 'environment.json'), inodeIdentity(fstatSync(environmentFd))],
    ...[...created].map(([name, handle]) => [path.join(runRoot, name), inodeIdentity(fstatSync(handle.fd))]),
  ]);
  const assertPublicIdentity = () => {
    for (const [publicPath, identity] of identities) {
      const stat = lstatSync(publicPath);
      const isExpectedKind = publicPath === runRoot || publicPath.endsWith('/artifacts') || publicPath.endsWith('/screenshots')
        ? stat.isDirectory()
        : stat.isFile();
      if (!isExpectedKind || stat.isSymbolicLink() || inodeIdentity(stat) !== identity || realpathSync(publicPath) !== publicPath) {
        throw new Error('GVP0_RUN_ROOT_IDENTITY_CHANGED');
      }
    }
  };
  const close = () => {
    for (const handle of created.values()) closeSync(handle.fd);
    for (const fd of [environmentFd, manifestFd, screenshotsFd, artifactsFd, rootFd]) closeSync(fd);
  };
  assertPublicIdentity();
  return {
    initialManifest,
    manifest: { name: 'manifest.json', fd: manifestFd, written: false },
    command: created.get('command.txt'),
    decision: created.get('decision.md'),
    stdout: created.get('stdout.log'),
    stderr: created.get('stderr.log'),
    assertPublicIdentity,
    close,
  };
}

function decisionEvidence({ capability, result, finishedAt }) {
  const receipt = result.receipt;
  const pass = receipt?.verdict === 'GO';
  const decision = receipt?.verdict ?? (result.exitCode === 2 ? 'BLOCKED_ENVIRONMENT' : 'NO_GO');
  const manifest = JSON.parse(capability.initialManifest.toString('utf8'));
  manifest.finished_at = finishedAt;
  const resultHash = receipt ? sha256(jsonBytes(receipt)) : null;
  const lines = [
    '# Decision (draft)',
    '',
    '- gate: GVP-0',
    `- fixture: ${manifest.fixture}`,
    `- platform: ${manifest.platform}`,
    `- evidence_sha256: ${resultHash ?? 'unavailable'}`,
    `- outcome: ${pass ? 'all checks passed' : 'verification failed'}`,
    `- draft decision: ${decision} (待所有者角色签署后生效)`,
  ];
  if (result.error) lines.push(`- limitation: ${sanitizeDiagnostic(result.error)}`);
  lines.push('', '签署规则见 docs/技术可行性/技术验证执行计划.md §7。', '');
  return { manifest: jsonBytes(manifest), decision: Buffer.from(lines.join('\n')) };
}

export async function runGvp0PublicRoute({ repoRoot, platform, fixture, candidateRoot, now = () => new Date().toISOString() } = {}) {
  let runRoot;
  let capability;
  let finalized = false;
  try {
    if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)
      || typeof candidateRoot !== 'string' || !path.isAbsolute(candidateRoot)
      || !['macos-15-arm64', 'windows-11-x64'].includes(platform)
      || fixture !== 'GVP-0-CORE-001') throw new Error('invalid public route arguments');
    runRoot = initializeEvidenceRun({
      evidenceRoot: path.join(repoRoot, 'evidence'),
      gate: 'gvp-0',
      fixture,
      platform,
      release: os.release(),
    });
    capability = createPublicEvidenceCapability(runRoot);
    writeOwned(capability.command, redactedGateCommand({ gate: 'gvp-0', platform, fixture, candidateRoot }));
    const finalize = async ({ admission, receipt }) => {
      capability.assertPublicIdentity();
      const result = { ...admission, receipt, code: receipt.verdict === 'GO' ? 'GVP0_ACCEPTED' : 'GVP0_ACCEPTANCE_NO_GO' };
      const output = decisionEvidence({ capability, result, finishedAt: now() });
      writeOwned(capability.stdout, `${JSON.stringify({ code: result.code, verdict: receipt.verdict })}\n`);
      writeOwned(capability.stderr, '');
      writeOwned(capability.decision, output.decision);
      writeOwned(capability.manifest, output.manifest);
      capability.assertPublicIdentity();
      finalized = true;
    };
    let result = await runGvp0Gate({
      candidateRoot,
      fixture,
      platform,
      resultsPath: path.join(runRoot, 'results.json'),
      artifactsDir: path.join(runRoot, 'artifacts'),
      pocRoot: path.join(repoRoot, 'scripts', 'poc', 'universal-viewer'),
      repoRoot,
      finalizeRunEvidence: finalize,
    });
    try {
      capability.assertPublicIdentity();
    } catch {
      result = { exitCode: 2, code: 'GVP0_RUN_ROOT_IDENTITY_CHANGED', error: 'reserved run root identity changed during execution' };
      process.stderr.write(`${result.code}\n`);
      return { ...result, runRoot };
    }
    if (!finalized) {
      const output = decisionEvidence({ capability, result, finishedAt: now() });
      const diagnostic = `${JSON.stringify({ code: result.code, error: sanitizeDiagnostic(result.error) })}\n`;
      writeOwned(capability.stdout, '');
      writeOwned(capability.stderr, diagnostic);
      writeOwned(capability.decision, output.decision);
      writeOwned(capability.manifest, output.manifest);
      capability.assertPublicIdentity();
    }
    const terminal = result.exitCode === 2 ? process.stderr : process.stdout;
    terminal.write(`${JSON.stringify({
      code: result.code,
      verdict: result.receipt?.verdict,
      error: result.error === undefined ? undefined : sanitizeDiagnostic(result.error),
    })}\n`);
    process.stdout.write(`evidence: ${path.relative(repoRoot, runRoot).split(path.sep).join('/')}\n`);
    return { ...result, runRoot };
  } catch (error) {
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
    process.stderr.write(`GVP0_PUBLIC_RUNNER_FAILURE: ${message}\n`);
    return { exitCode: 2, code: 'GVP0_PUBLIC_RUNNER_FAILURE', error: message, runRoot };
  } finally {
    capability?.close();
  }
}

async function main() {
  try {
    const result = await runGvp0PublicRoute(parseExactArgs(process.argv.slice(2)));
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('GVP0_PUBLIC_ARGUMENT_FAILURE\n');
    process.exitCode = 2;
  }
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) main();
