import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './task7-worker-protocol.mjs';

const MACOS_WPS_APPLICATION = '/Applications/wpsoffice.app';
const MACOS_WPSCOMPOSER_ROOT = '/Users/neomei/项目/codexprojects/WpsComposer';
const MACOS_WPS_BRIDGE_RELATIVE_PATH = 'skills/WPSComposer/__init__.py';
const MACOS_WPS_EXECUTABLE_RELATIVE_PATH = 'Contents/MacOS/wpsoffice';

function windowsWpsExecutable(component = 'writer') {
  const explicit = process.env.SUPERWAGIE_WPS_EXECUTABLE;
  if (explicit && component === 'writer') return realpathSync(explicit);
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('LOCALAPPDATA_REQUIRED');
  const executableName = component === 'presentation' ? 'wpp.exe' : 'wps.exe';
  const candidates = readdirSync(local, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
    .map((entry) => join(local, entry.name, 'office6', executableName))
    .filter(existsSync)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (!candidates.length) throw new Error(`WPS_EXECUTABLE_MISSING:${executableName}`);
  return realpathSync(candidates[0]);
}

function defaults(repositoryRoot) {
  if (process.platform === 'win32') {
    return {
      wps_application: windowsWpsExecutable('writer'),
      wpscomposer_root: join(repositoryRoot, 'scripts', 'poc', 'solution-b-task7', 'src'),
      wps_bridge_relative_path: 'windows-wps-bridge.ps1',
      wps_executable_relative_path: 'wps.exe',
    };
  }
  return { wps_application: MACOS_WPS_APPLICATION, wpscomposer_root: MACOS_WPSCOMPOSER_ROOT,
    wps_bridge_relative_path: MACOS_WPS_BRIDGE_RELATIVE_PATH, wps_executable_relative_path: MACOS_WPS_EXECUTABLE_RELATIVE_PATH };
}

function spawnCapture(executable, args, { timeoutMs, env = process.env }) {
  return new Promise((resolveSpawn) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') spawnSync(join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
        else child.kill('SIGKILL');
      }
    }, timeoutMs);
  });
}

export function wpsEnvironmentDefaults(repositoryRoot = resolve(import.meta.dirname, '../../../..')) {
  return defaults(repositoryRoot);
}

async function windowsWpsMetadata(executables) {
  const powershell = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; $items=@(); foreach($path in ($env:SUPERWAGIE_WPS_METADATA_PATHS -split ';')) { $file=Get-Item -LiteralPath $path; $signature=Get-AuthenticodeSignature -LiteralPath $path; $items += [pscustomobject]@{ path=$file.FullName; version=$file.VersionInfo.FileVersion; product_version=$file.VersionInfo.ProductVersion; signature_status=$signature.Status.ToString(); signer=$signature.SignerCertificate.Subject; thumbprint=$signature.SignerCertificate.Thumbprint } }; $items | ConvertTo-Json -Compress`;
  const run = await spawnCapture(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 30_000, env: { ...process.env,
      PSModulePath: `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\WindowsPowerShell\\Modules;${process.env.WINDIR ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
      SUPERWAGIE_WPS_METADATA_PATHS: executables.join(';') },
  });
  if (run.kind !== 'exit' || run.code !== 0) throw new Error(`WPS_METADATA_PROBE_FAILED:${run.kind}:${run.code}:${run.stderr.slice(-1000)}`);
  const parsed = JSON.parse(run.stdout.trim());
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({ ...item,
    sha256: sha256(readFileSync(item.path)) }));
}

export async function measureWpsIdentity({
  repositoryRoot, timeoutMs = 120_000, wpsApplication,
} = {}) {
  const selected = defaults(repositoryRoot);
  wpsApplication ??= selected.wps_application;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = await spawnCapture(python, [
    join(repositoryRoot, 'scripts/poc/solution-b-task7/src/wps-identity-probe.py'),
    '--worker', join(repositoryRoot, 'scripts/poc/gate-3/wps-render-worker.py'),
    '--wps-application', wpsApplication,
    '--wpscomposer-root', selected.wpscomposer_root,
    '--wps-bridge-relative-path', selected.wps_bridge_relative_path,
    '--wps-executable-relative-path', selected.wps_executable_relative_path,
  ], { timeoutMs });
  if (result.kind !== 'exit' || result.code !== 0) {
    return { ok: false, code: 'WPS_IDENTITY_PROBE_FAILED', result };
  }
  try {
    const identity = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (identity.target_kind !== (process.platform === 'win32' ? 'windows-executable' : 'macos-app-bundle')
      || !/^[0-9a-f]{64}$/.test(identity.executable_sha256)
      || !/^[0-9a-f]{64}$/.test(identity.bundle_manifest_sha256)
      || !/^[0-9a-f]{64}$/.test(identity.bridge_sha256)) {
      return { ok: false, code: 'WPS_IDENTITY_INVALID', result };
    }
    const metadata = process.platform === 'win32'
      ? await windowsWpsMetadata([wpsApplication, windowsWpsExecutable('presentation')]) : [];
    if (process.platform === 'win32' && metadata.some((item) => item.signature_status !== 'Valid')) {
      return { ok: false, code: 'WPS_SIGNATURE_INVALID', identity, metadata, result };
    }
    return { ok: true, identity, metadata };
  } catch (error) {
    return { ok: false, code: 'WPS_IDENTITY_INVALID', error: error.message, result };
  }
}

export async function runWpsConversion({
  repositoryRoot, workRoot, jobId, sourcePath, sourceSha256, identity, deadlineMs = 180_000,
  wpsApplication,
}) {
  const selected = defaults(repositoryRoot);
  wpsApplication ??= selected.wps_application;
  if (sha256(readFileSync(resolve(sourcePath))) !== sourceSha256) {
    return { kind: 'wps-conversion', job_id: jobId, identity, source: { name: basename(sourcePath), sha256: sourceSha256 },
      receipt: { status: 'failed', code: 'SOURCE_HASH_MISMATCH' }, receipt_sha256: null, output: null,
      worker: { kind: 'not_started', code: null, signal: null, duration_ms: 0 }, ok: false, failure: 'SOURCE_HASH_MISMATCH' };
  }
  const beforeIdentity = await measureWpsIdentity({ repositoryRoot, timeoutMs: Math.min(deadlineMs, 120_000), wpsApplication });
  if (!beforeIdentity.ok || JSON.stringify(beforeIdentity.identity) !== JSON.stringify(identity)) {
    return { kind: 'wps-conversion', job_id: jobId, identity, source: { name: basename(sourcePath), sha256: sourceSha256 },
      receipt: { status: 'dependency_missing', code: 'WPS_IDENTITY_CHANGED' }, receipt_sha256: null, output: null,
      worker: { kind: 'not_started', code: null, signal: null, duration_ms: 0 }, ok: false, failure: 'WPS_IDENTITY_CHANGED' };
  }
  const outputDirectory = join(workRoot, jobId);
  const outputPath = join(outputDirectory, 'wps-authoritative.pdf');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const component = ['.ppt', '.pptx'].includes(sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase()) ? 'presentation' : 'writer';
  const result = process.platform === 'win32' ? await spawnCapture(
    join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(selected.wpscomposer_root, selected.wps_bridge_relative_path),
      '-Component', component, '-SourcePath', resolve(sourcePath), '-OutputPath', resolve(outputPath)],
    { timeoutMs: deadlineMs + 60_000, env: process.env },
  ) : await spawnCapture('python3', [
    join(repositoryRoot, 'scripts/poc/gate-3/wps-render-worker.py'),
    '--source', resolve(sourcePath),
    '--output', resolve(outputPath),
    '--wpscomposer-root', selected.wpscomposer_root,
    '--expected-source-sha256', sourceSha256,
    '--deadline-ms', String(deadlineMs),
    '--wps-application', wpsApplication,
    '--expected-wps-identity-json', JSON.stringify(identity),
    '--wps-bridge-relative-path', selected.wps_bridge_relative_path,
    '--wps-executable-relative-path', selected.wps_executable_relative_path,
  ], { timeoutMs: deadlineMs + 60_000 });
  const durationMs = Date.now() - startedAt;
  let receipt = null;
  if (process.platform === 'win32' && result.kind === 'exit' && result.code === 0) {
    try {
      const bytes = readFileSync(outputPath);
      receipt = { status: 'success', code: 'OK', component, output_sha256: sha256(bytes) };
    } catch { receipt = { status: 'failed', code: 'WPS_OUTPUT_MISSING', component }; }
  } else {
    try { receipt = JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch { receipt = null; }
  }
  const receiptBytes = receipt ? Buffer.from(JSON.stringify(receipt)) : null;
  const binding = {
    kind: 'wps-conversion',
    job_id: jobId,
    worker: { kind: result.kind, code: result.code, signal: result.signal, duration_ms: durationMs },
    identity,
    identity_metadata: beforeIdentity.metadata ?? [],
    source: { name: basename(sourcePath), sha256: sourceSha256 },
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
  if (binding.ok && process.platform === 'win32') {
    const afterIdentity = await measureWpsIdentity({ repositoryRoot, timeoutMs: Math.min(deadlineMs, 120_000), wpsApplication });
    binding.identity_stable = afterIdentity.ok && JSON.stringify(afterIdentity.identity) === JSON.stringify(identity);
    if (!binding.identity_stable) { binding.ok = false; binding.failure = 'WPS_IDENTITY_CHANGED_AFTER_CONVERSION'; binding.output = null; }
  }
  return binding;
}

export async function probePdfPageCount({ repositoryRoot, pdfPath }) {
  const pdfjs = await import(pathToFileURL(join(repositoryRoot,
    'scripts/poc/gate-3/node_modules/pdfjs-dist/legacy/build/pdf.min.mjs')).href);
  const data = new Uint8Array(readFileSync(pdfPath));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const doc = await task.promise;
  const pageCount = doc.numPages;
  await task.destroy();
  return pageCount;
}
