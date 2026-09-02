import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './task7-worker-protocol.mjs';

const WPS_APPLICATION = '/Applications/wpsoffice.app';
const WPSCOMPOSER_ROOT = '/Users/neomei/项目/codexprojects/WpsComposer';
const WPS_BRIDGE_RELATIVE_PATH = 'skills/WPSComposer/__init__.py';
const WPS_EXECUTABLE_RELATIVE_PATH = 'Contents/MacOS/wpsoffice';

function spawnCapture(executable, args, { timeoutMs }) {
  return new Promise((resolveSpawn) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let terminalKind = null;
    let settled = false;
    let timeout;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveSpawn({ ...outcome, stdout, stderr });
    };
    child.once('error', (error) => finish({ kind: 'spawn_error', code: null, signal: null, error: error.message }));
    child.once('exit', (code, signal) => finish({ kind: terminalKind ?? 'exit', code, signal, error: null }));
    timeout = setTimeout(() => {
      terminalKind = 'timeout';
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, timeoutMs);
  });
}

export function wpsEnvironmentDefaults() {
  return {
    wps_application: WPS_APPLICATION,
    wpscomposer_root: WPSCOMPOSER_ROOT,
    wps_bridge_relative_path: WPS_BRIDGE_RELATIVE_PATH,
    wps_executable_relative_path: WPS_EXECUTABLE_RELATIVE_PATH,
  };
}

export async function measureWpsIdentity({
  repositoryRoot, timeoutMs = 120_000, wpsApplication = WPS_APPLICATION,
} = {}) {
  const result = await spawnCapture('python3', [
    join(repositoryRoot, 'scripts/poc/solution-b-task7/src/wps-identity-probe.py'),
    '--worker', join(repositoryRoot, 'scripts/poc/gate-3/wps-render-worker.py'),
    '--wps-application', wpsApplication,
    '--wpscomposer-root', WPSCOMPOSER_ROOT,
    '--wps-bridge-relative-path', WPS_BRIDGE_RELATIVE_PATH,
    '--wps-executable-relative-path', WPS_EXECUTABLE_RELATIVE_PATH,
  ], { timeoutMs });
  if (result.kind !== 'exit' || result.code !== 0) {
    return { ok: false, code: 'WPS_IDENTITY_PROBE_FAILED', result };
  }
  try {
    const identity = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (identity.target_kind !== 'macos-app-bundle'
      || !/^[0-9a-f]{64}$/.test(identity.executable_sha256)
      || !/^[0-9a-f]{64}$/.test(identity.bundle_manifest_sha256)
      || !/^[0-9a-f]{64}$/.test(identity.bridge_sha256)) {
      return { ok: false, code: 'WPS_IDENTITY_INVALID', result };
    }
    return { ok: true, identity };
  } catch (error) {
    return { ok: false, code: 'WPS_IDENTITY_INVALID', error: error.message, result };
  }
}

export async function runWpsConversion({
  repositoryRoot, workRoot, jobId, sourcePath, sourceSha256, identity, deadlineMs = 180_000,
  wpsApplication = WPS_APPLICATION,
}) {
  const outputDirectory = join(workRoot, jobId);
  const outputPath = join(outputDirectory, 'wps-authoritative.pdf');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const result = await spawnCapture('python3', [
    join(repositoryRoot, 'scripts/poc/gate-3/wps-render-worker.py'),
    '--source', resolve(sourcePath),
    '--output', resolve(outputPath),
    '--wpscomposer-root', WPSCOMPOSER_ROOT,
    '--expected-source-sha256', sourceSha256,
    '--deadline-ms', String(deadlineMs),
    '--wps-application', wpsApplication,
    '--expected-wps-identity-json', JSON.stringify(identity),
    '--wps-bridge-relative-path', WPS_BRIDGE_RELATIVE_PATH,
    '--wps-executable-relative-path', WPS_EXECUTABLE_RELATIVE_PATH,
  ], { timeoutMs: deadlineMs + 60_000 });
  const durationMs = Date.now() - startedAt;
  let receipt = null;
  try {
    receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
  } catch { receipt = null; }
  const receiptBytes = receipt ? Buffer.from(JSON.stringify(receipt)) : null;
  const binding = {
    kind: 'wps-conversion',
    job_id: jobId,
    worker: { kind: result.kind, code: result.code, signal: result.signal, duration_ms: durationMs },
    identity,
    source: { name: sourcePath.split('/').pop(), sha256: sourceSha256 },
    receipt,
    receipt_sha256: receiptBytes ? 'sha256:' + sha256(receiptBytes) : null,
    output: null,
    stderr_tail: result.stderr ? result.stderr.split('\n').slice(-8) : [],
    ok: false,
  };
  if (result.kind === 'exit' && result.code === 0 && receipt?.status === 'success') {
    try {
      const bytes = readFileSync(outputPath);
      const outputSha256 = sha256(bytes);
      if (receipt.output_sha256 === outputSha256) {
        binding.ok = true;
        binding.output = { path: outputPath, sha256: outputSha256, bytes: bytes.length };
      } else {
        binding.failure = 'WPS_OUTPUT_HASH_MISMATCH';
      }
    } catch (error) {
      binding.failure = 'WPS_OUTPUT_MISSING:' + error.code;
    }
  } else {
    binding.failure = receipt
      ? receipt.status + ':' + receipt.code
      : 'WPS_WORKER_FAILED:' + result.kind + ':' + result.code;
  }
  return binding;
}

export async function probePdfPageCount({ repositoryRoot, pdfPath }) {
  const pdfjs = await import(join(repositoryRoot,
    'scripts/poc/gate-3/node_modules/pdfjs-dist/legacy/build/pdf.min.mjs'));
  const data = new Uint8Array(readFileSync(pdfPath));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const doc = await task.promise;
  const pageCount = doc.numPages;
  await task.destroy();
  return pageCount;
}
