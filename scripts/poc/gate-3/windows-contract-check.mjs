#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sampleWindowsOwnedTree } from './review-isolation-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = path.join(here, 'reviewer-shell');
const main = await readFile(path.join(shell, 'src/main.rs'), 'utf8');
const cargo = await readFile(path.join(shell, 'Cargo.toml'), 'utf8');
const isolation = await readFile(path.join(here, 'review-isolation-gate.mjs'), 'utf8');
const review = await readFile(path.join(here, 'review-gate.mjs'), 'utf8');
const runner = await readFile(path.join(here, '../run-gate.sh'), 'utf8');
const environmentGate = await readFile(path.join(here, '../environment-gate.mjs'), 'utf8');

const requirements = [
  [main, /#\[cfg\(windows\)\][\s\S]*GetProcessMemoryInfo/],
  [main, /PROCESS_MEMORY_COUNTERS/],
  [main, /GetCurrentProcess/],
  [main, /PeakWorkingSetSize/],
  [cargo, /\[target\.'cfg\(windows\)'\.dependencies\][\s\S]*windows-sys[\s\S]*Win32_System_ProcessStatus[\s\S]*Win32_System_Threading/],
  [isolation, /\$scopedProcessId/],
  [isolation, /\$ownedProcessId/],
  [isolation, /CreationDate/],
  [isolation, /WINDOWS_POWERSHELL/],
  [isolation, /OWNED_WINDOWS_PROCESS_PROBE_TIMEOUT/],
  [review, /macos-15-arm64\|windows-11-x64/],
  [runner, /--platform "\$PLATFORM"/],
  [runner, /G3-REVIEW-001\)[\s\S]*environment-gate\.mjs/],
  [runner, /G3-REVIEW-002\)[\s\S]*environment-gate\.mjs/],
  [environmentGate, /ELECTRON_ARTIFACT_PREVIEW_SURFACE_REQUIRED/],
  [environmentGate, /ELECTRON_PREVIEW_RECOVERY_HARNESS_REQUIRED/]
];
for (const [source, pattern] of requirements) {
  if (!pattern.test(source)) throw new Error(`Windows contract missing: ${pattern}`);
}
if (/\$(?:id|pid)\b/i.test(isolation)) throw new Error('PowerShell automatic-variable collision remains');
if (/win32-x64/.test(review)) throw new Error('non-canonical Windows platform remains');
if (/node "\$G3_DIR\/review-gate\.mjs"/.test(runner)) throw new Error('legacy reviewer is still reachable from the public runner');

if (process.platform === 'win32') {
  const owned = new Set([process.pid]);
  const probes = sampleWindowsOwnedTree(process.pid, owned);
  if (!owned.has(process.pid) || !Object.values(probes).every((value) => typeof value === 'string')) {
    throw new Error('generated PowerShell owned-tree probe did not execute');
  }
  const checked = spawnSync('cargo', ['check', '--locked'], { cwd: shell, encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(checked.stderr || checked.stdout || 'Windows cargo check failed');
  const tested = spawnSync('cargo', ['test', '--locked', 'windows_native_peak_rss_is_available_for_trusted_completion'], { cwd: shell, encoding: 'utf8' });
  if (tested.status !== 0) throw new Error(tested.stderr || tested.stdout || 'Windows trusted-completion RSS test failed');
  console.log('windows-contract: ok (historical native contract plus solution B public-route blocker)');
} else {
  console.log('windows-contract: static historical contract and solution B blocker ok; native execution skipped on non-Windows host');
}
