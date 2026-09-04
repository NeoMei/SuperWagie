#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attestIsolationResult, compareIsolationSnapshots, validateIsolationEvidence } from './isolation-evidence.mjs';
import { captureTrustedProvenance, privateWpsLaunchEnvironment } from './review-provenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const FIXED_EXECUTABLE = path.join(HERE, `reviewer-shell/target/debug/superwagie-reviewer-poc${process.platform === 'win32' ? '.exe' : ''}`);
const MANIFEST = path.join(REPO_ROOT, 'fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json');
const DEPENDENCY_LOCK = path.join(HERE, 'reviewer-shell/Cargo.lock');
const SCENARIOS = new Set(['codex-never-installed', 'codex-installed-not-running', 'codex-running', 'codex-config-mutated']);
const FORBIDDEN = /(?:ChatGPT(?:\.app|\.exe)|Codex(?:\.app|\.exe)|[\\/](?:Users[\\/][^\\/]+[\\/])?\.codex(?:[\\/]|$)|CODEX_HOME|codex[^\s\\/]*(?:socket|sock))/i;

function parse(argv) {
  const result = {};
  const known = new Map([
    ['--fixture', 'fixture'], ['--scenario', 'scenario'], ['--platform', 'platform'],
    ['--results-json', 'resultsJson'], ['--artifacts-dir', 'artifactsDir'],
    ['--wps-python', 'wpsPython'], ['--wpscomposer-root', 'wpscomposerRoot'], ['--wps-application', 'wpsApplication'],
    ['--wps-node', 'wpsNode'],
    ['--wps-home', 'wpsHome'],
    ['--machine-profile', 'machineProfile'], ['--scenario-attestation', 'scenarioAttestation'],
    ['--baseline-results', 'baselineResults'], ['--baseline-evidence-root', 'baselineEvidenceRoot'],
    ['--test-capture-json', 'testCaptureJson']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') return { help: true };
    const key = known.get(argv[index]);
    if (!key || index + 1 >= argv.length || result[key] !== undefined) throw new Error(`invalid argument: ${argv[index]}`);
    result[key] = argv[++index];
  }
  return result;
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.normalize(value);
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
async function shaFile(file) { return sha(await readFile(file)); }
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function blockedResult(args, reason) {
  return {
    schema_id: 'superwagie.g3-review-isolation-result.v1', schema_version: 1,
    gate: 'gate-3', fixture: args.fixture ?? null, scenario: args.scenario ?? null,
    platform: args.platform ?? null, run_id: `blocked-${randomBytes(8).toString('hex')}`,
    captured_at: new Date().toISOString(), pass: false, status: 'blocked',
    decision_hint: 'BLOCKED_ENVIRONMENT', reasons: [reason]
  };
}

async function preconditionEvidence(args, artifactsDir) {
  const platformState = await capturePlatformApplicationState(args.platform);
  const installed = platformState.installed;
  const codexRunning = platformState.codexRunning;
  const processEvidence = platformState.processEvidence;
  let attestation = { required: false, verified: false, digest_sha256: null };
  let mutation = { applied: false, digest_sha256: null };
  let state;
  if (args.scenario === 'codex-never-installed') {
    if (installed.length !== 0 || codexRunning || !args.scenarioAttestation) throw new Error('NEVER_INSTALLED_PRECONDITION_FAILED');
    const bytes = await readFile(args.scenarioAttestation);
    const value = JSON.parse(bytes);
    if (value.schema_id !== 'superwagie.codex-never-installed-attestation.v1' || value.platform !== args.platform
      || value.applications_absent !== true || typeof value.operator !== 'string'
      || !Number.isFinite(Date.parse(value.attested_at)) || Math.abs(Date.now() - Date.parse(value.attested_at)) > 24 * 60 * 60 * 1000) throw new Error('NEVER_INSTALLED_ATTESTATION_INVALID');
    attestation = { required: true, verified: true, digest_sha256: sha(bytes) };
    state = 'never-installed-attested';
  } else {
    if (installed.length === 0) throw new Error('INSTALLED_PRECONDITION_FAILED');
    if (args.scenario === 'codex-running' && !codexRunning) throw new Error('RUNNING_PRECONDITION_FAILED');
    if (args.scenario !== 'codex-running' && codexRunning) throw new Error('NOT_RUNNING_PRECONDITION_FAILED');
    state = args.scenario === 'codex-running' ? 'installed-running' : args.scenario === 'codex-config-mutated' ? 'installed-config-mutated' : 'installed-not-running';
    if (args.scenario === 'codex-config-mutated') {
      const bytes = Buffer.from('{"fixture_local_codex_mutation":true}\n');
      await writeFile(path.join(artifactsDir, 'fixture-local-config.json'), bytes, { mode: 0o600 });
      mutation = { applied: true, digest_sha256: sha(bytes) };
    }
  }
  return {
    kind: args.scenario, verified: true,
    application_inventory: { codex_state: state, digest_sha256: sha(platformState.inventoryEvidence) },
    process_state: { codex_running: codexRunning, digest_sha256: sha(processEvidence) },
    fixture_mutation: mutation, attestation
  };
}

async function capturePlatformApplicationState(platform, services = {}) {
  const execute = services.execute ?? spawnSync;
  const environment = services.environment ?? process.env;
  if (platform.startsWith('macos-')) {
  const userApplications = process.env.HOME ? path.join(process.env.HOME, 'Applications') : null;
  const applicationCandidates = [
    '/Applications/Codex.app', '/Applications/ChatGPT.app',
    ...(userApplications ? [path.join(userApplications, 'Codex.app'), path.join(userApplications, 'ChatGPT.app')] : [])
  ];
    const installed = [];
  for (const candidate of applicationCandidates) {
    try { if ((await lstat(candidate)).isDirectory()) installed.push(path.basename(candidate)); } catch {}
  }
    const ps = execute('/bin/ps', ['ax', '-o', 'command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (ps.status !== 0) throw new Error('PROCESS_INVENTORY_UNAVAILABLE');
  const codexRunning = ps.stdout.split('\n').some((line) => /(?:\/Codex(?:\.app)?\/|\bcodex\b)/i.test(line) && !line.includes('review-isolation-gate'));
    const ordered = installed.sort();
    return { installed: ordered, codexRunning, inventoryEvidence: JSON.stringify(ordered), processEvidence: ps.stdout };
  }
  if (platform === 'windows-11-x64') {
    const script = [
      '$ErrorActionPreference="Stop"',
      '$installed=@();',
      '$candidates=@(',
      '@("Codex.exe",(Join-Path $env:LOCALAPPDATA "Programs\\Codex\\Codex.exe")),',
      '@("ChatGPT.exe",(Join-Path $env:LOCALAPPDATA "Programs\\ChatGPT\\ChatGPT.exe")),',
      '@("ChatGPT.exe",(Join-Path $env:ProgramFiles "ChatGPT\\ChatGPT.exe"))',
      '); foreach($entry in $candidates){if(Test-Path -LiteralPath $entry[1] -PathType Leaf){$installed+=$entry[0]}};',
      '$running=@(Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue).Count -gt 0;',
      '[pscustomobject]@{installed=@($installed|Sort-Object -Unique);codex_running=$running}|ConvertTo-Json -Compress'
    ].join(' ');
    const windowsRoot = environment.WINDIR || 'C:\\Windows';
    const powershell = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('WINDOWS_APPLICATION_INVENTORY_UNAVAILABLE');
    const value = JSON.parse(result.stdout);
    if (!Array.isArray(value.installed) || typeof value.codex_running !== 'boolean'
      || value.installed.some((entry) => !['Codex.exe', 'ChatGPT.exe'].includes(entry))) throw new Error('WINDOWS_APPLICATION_INVENTORY_INVALID');
    const installed = [...new Set(value.installed)].sort();
    return { installed, codexRunning: value.codex_running, inventoryEvidence: JSON.stringify(installed), processEvidence: JSON.stringify({ codex_running: value.codex_running }) };
  }
  throw new Error('isolation platform probe unsupported');
}

function probeRecord(raw) {
  const matches = [...new Set((raw.match(new RegExp(FORBIDDEN.source, 'gi')) ?? []).map((value) => value.toLowerCase()))].sort();
  return { checked: true, sample_count: raw ? raw.split('\n').filter(Boolean).length : 0, evidence_sha256: sha(raw), forbidden_matches: matches };
}

function windowsOwnedTreeInvocation(rootPid, owned, environment = process.env) {
  const script = [
    '$ErrorActionPreference="Stop";',
    '$ownedPids=New-Object "System.Collections.Generic.HashSet[int]";',
    '$queue=New-Object "System.Collections.Generic.Queue[int]";',
    '$allProcesses=@(Get-CimInstance Win32_Process -ErrorAction Stop);',
    '$networkAvailable=$true;try{$allNetwork=@(Get-NetTCPConnection -ErrorAction Stop)}catch{$networkAvailable=$false;$allNetwork=@()};',
    'foreach($rawSeed in $env:SUPERWAGIE_OWNED_PIDS.Split(",")){if($rawSeed){$scopedPid=[int]$rawSeed;if($ownedPids.Add($scopedPid)){$queue.Enqueue($scopedPid)}}};',
    'while($queue.Count -gt 0){$parentPid=$queue.Dequeue(); $allProcesses|Where-Object{$_.ParentProcessId -eq $parentPid}|ForEach-Object{$descendantPid=[int]$_.ProcessId;if($ownedPids.Add($descendantPid)){$queue.Enqueue($descendantPid)}}};',
    '$process=@();$paths=@();$network=@();$probeErrors=@(); foreach($ownedPid in $ownedPids){',
    '$ownedProcess=$allProcesses|Where-Object{$_.ProcessId -eq $ownedPid}|Select-Object -First 1; if($ownedProcess){$process+=@($ownedProcess.Name,$ownedProcess.ExecutablePath,$ownedProcess.CommandLine)|Where-Object{$_};',
    'try{$paths+=@(Get-Process -Id $ownedPid -ErrorAction Stop).Modules|ForEach-Object{$_.FileName}}catch{if(Get-Process -Id $ownedPid -ErrorAction SilentlyContinue){$probeErrors+="modules:$ownedPid"}};',
    'if($networkAvailable){$network+=$allNetwork|Where-Object{$_.OwningProcess -eq $ownedPid}|ForEach-Object{"$($_.RemoteAddress):$($_.RemotePort)"}}else{$probeErrors+="network:$ownedPid"}}',
    '}; [pscustomobject]@{pids=@($ownedPids|Sort-Object);process=@($process);paths=@($paths);network=@($network);probe_errors=@($probeErrors)}|ConvertTo-Json -Compress -Depth 4'
  ].join(' ');
  const windowsRoot = environment.WINDIR || 'C:\\Windows';
  const powershell = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const seeds = [...new Set([rootPid, ...owned])].sort((left, right) => left - right).join(',');
  return {
    program: powershell,
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    options: {
    encoding: 'utf8',
    env: { ...environment, SUPERWAGIE_OWNED_PIDS: seeds },
    maxBuffer: 16 * 1024 * 1024
    }
  };
}

function acceptWindowsOwnedTreeResult(result, owned) {
  if (result.status !== 0) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_UNAVAILABLE');
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.pids) || !['process', 'paths', 'network', 'probe_errors'].every((key) => Array.isArray(value[key]))
    || value.pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
    || ['process', 'paths', 'network', 'probe_errors'].some((key) => value[key].some((entry) => typeof entry !== 'string'))) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_INVALID');
  if (value.probe_errors.length > 0) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_INCOMPLETE');
  for (const pid of value.pids) owned.add(pid);
  return Object.fromEntries(['process', 'paths', 'network'].map((key) => [key, `${value[key].join('\n')}\n`]));
}

function sampleWindowsOwnedTree(rootPid, owned, execute = spawnSync, environment = process.env) {
  const invocation = windowsOwnedTreeInvocation(rootPid, owned, environment);
  return acceptWindowsOwnedTreeResult(
    execute(invocation.program, invocation.args, invocation.options),
    owned
  );
}

async function sampleWindowsOwnedTreeAsync(rootPid, owned, environment = process.env) {
  const invocation = windowsOwnedTreeInvocation(rootPid, owned, environment);
  const result = await new Promise((resolve, reject) => {
    const probe = spawn(invocation.program, invocation.args, {
      env: invocation.options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let oversized = false;
    const append = (target, chunk) => {
      const value = target + chunk.toString('utf8');
      if (Buffer.byteLength(value, 'utf8') > invocation.options.maxBuffer) {
        oversized = true;
        probe.kill();
      }
      return value;
    };
    probe.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    probe.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    probe.once('error', reject);
    probe.once('close', (status) => {
      if (oversized) reject(new Error('OWNED_WINDOWS_PROCESS_PROBE_OVERSIZED'));
      else resolve({ status, stdout, stderr });
    });
  });
  return acceptWindowsOwnedTreeResult(result, owned);
}

async function runOwnedCapture(executable, environment, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(executable, [], { env: environment, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    const raw = { process: '', paths: '', network: '' };
    const owned = new Set();
    let probeFailed = false;
    let settled = false;
    let timedOut = false;
    let hardTimer = null;
    let exitResult = null;
    let emptyRounds = 0;
    let sampleInFlight = null;
    let finishing = false;
    const requiredEmptyRounds = process.platform === 'win32' ? 1 : 3;
    const discoverPids = (selector, pid) => {
      const result = spawnSync('/usr/bin/pgrep', [selector, String(pid)], { encoding: 'utf8' });
      if (![0, 1].includes(result.status)) throw new Error('OWNED_PROCESS_DISCOVERY_UNAVAILABLE');
      return (result.stdout ?? '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
    };
    const discoverOwnedTree = () => {
      if (child.pid) owned.add(child.pid);
      for (const member of child.pid ? discoverPids('-g', child.pid) : []) owned.add(member);
      let changed = true;
      for (let round = 0; round < 16 && changed; round += 1) {
        changed = false;
        for (const pid of [...owned]) {
          for (const descendant of discoverPids('-P', pid)) {
            if (!owned.has(descendant)) { owned.add(descendant); changed = true; }
          }
        }
      }
    };
    const sampleOnce = async () => {
      if (process.platform === 'win32') {
        try {
          if (child.pid) owned.add(child.pid);
          const captured = await sampleWindowsOwnedTreeAsync(child.pid, owned);
          for (const key of Object.keys(raw)) raw[key] += captured[key];
        } catch { probeFailed = true; raw.process += 'owned-process-discovery-failed\n'; }
        return;
      }
      try { discoverOwnedTree(); } catch { probeFailed = true; raw.process += 'owned-process-discovery-failed\n'; }
      for (const pid of owned) {
        const processProbe = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        const pathProbe = spawnSync('/usr/sbin/lsof', ['-p', String(pid)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        const networkProbe = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-i'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        if ([processProbe, pathProbe, networkProbe].some((probe) => probe.error || probe.status === null || ![0, 1].includes(probe.status))) probeFailed = true;
        raw.process += processProbe.stdout ?? '';
        raw.paths += pathProbe.stdout ?? '';
        raw.network += networkProbe.stdout ?? '';
      }
    };
    const requestSample = () => {
      if (!sampleInFlight) {
        sampleInFlight = sampleOnce().finally(() => { sampleInFlight = null; });
      }
      return sampleInFlight;
    };
    const ownedAliveCount = () => [...owned].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }).length;
    const terminateOwned = async (signal) => {
      await requestSample();
      for (const pid of [...owned].reverse()) {
        try { process.kill(pid, signal); } catch {}
      }
    };
    const checkFinished = () => {
      if (!exitResult || finishing) return;
      emptyRounds = ownedAliveCount() === 0 ? emptyRounds + 1 : 0;
      if (emptyRounds >= requiredEmptyRounds) void finish(exitResult);
    };
    const interval = setInterval(() => {
      void requestSample().then(checkFinished);
    }, 250);
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateOwned('SIGTERM').then(() => {
        hardTimer = setTimeout(() => { void terminateOwned('SIGKILL'); }, 1000);
      });
    }, timeoutMs);
    const finish = async (result) => {
      if (settled || finishing) return;
      finishing = true;
      clearInterval(interval); clearTimeout(timer); if (hardTimer) clearTimeout(hardTimer);
      await requestSample();
      settled = true;
      resolve({ ...result, timedOut, probeFailed, ownedPidCount: owned.size, probes: { process: probeRecord(raw.process), paths: probeRecord(raw.paths), network: probeRecord(raw.network) } });
    };
    child.once('error', () => { void finish({ code: null, launchFailed: true }); });
    child.once('exit', (code) => {
      exitResult = { code, launchFailed: false };
      void requestSample().then(checkFinished);
    });
  });
}

async function productionCapture(args, artifactsDir) {
  for (const [value, label] of [[args.wpsPython, '--wps-python'], [args.wpscomposerRoot, '--wpscomposer-root'], [args.wpsApplication, '--wps-application'], [args.wpsNode, '--wps-node'], [args.wpsHome, '--wps-home'], [args.machineProfile, '--machine-profile']]) if (value !== undefined) absolute(value, label);
  const provenance = await captureTrustedProvenance({ wpsPython: args.wpsPython, wpsComposerRoot: args.wpscomposerRoot, wpsApplication: args.wpsApplication, machineProfile: args.machineProfile, platform: args.platform });
  if (provenance.machine.representative !== true) throw new Error('MACHINE_NOT_REPRESENTATIVE');
  const privateWpsEnvironment = await privateWpsLaunchEnvironment({ wpsApplication: args.wpsApplication, machineProfile: args.machineProfile, provenance });
  const manifestHash = await shaFile(MANIFEST);
  const sessionId = randomBytes(16).toString('hex');
  const processResult = await runOwnedCapture(FIXED_EXECUTABLE, {
    PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8',
    SUPERWAGIE_REVIEW_AUTOMATION: '1', SUPERWAGIE_REVIEW_EVIDENCE_DIR: artifactsDir,
    SUPERWAGIE_REVIEW_FIXTURE_MANIFEST: MANIFEST, SUPERWAGIE_REVIEW_FIXTURE_MANIFEST_SHA256: manifestHash,
    SUPERWAGIE_REVIEW_AUTOMATION_SESSION_ID: sessionId, SUPERWAGIE_WPS_PYTHON: args.wpsPython,
    SUPERWAGIE_WPSCOMPOSER_ROOT: args.wpscomposerRoot, SUPERWAGIE_WPS_RENDERER_VERSION: provenance.wps.exact_version,
    ...(args.wpsNode ? { SUPERWAGIE_WPS_NODE: args.wpsNode } : {}),
    ...(args.wpsHome ? { SUPERWAGIE_WPS_CONTAINER_HOME_PROBE: 'required', SUPERWAGIE_WPS_PROBED_HOME: args.wpsHome } : {}),
    SUPERWAGIE_WPS_RENDERER_ENV_HASH: provenance.renderer_environment_sha256,
    SUPERWAGIE_WPS_FONT_ENV_HASH: provenance.font_manifest_sha256,
    SUPERWAGIE_REVIEW_PROVENANCE_SHA256: provenance.renderer_environment_sha256,
    SUPERWAGIE_REVIEW_MACHINE_REPRESENTATIVE: '1',
    ...privateWpsEnvironment
  });
  if (processResult.launchFailed || processResult.timedOut || processResult.probeFailed || processResult.code !== 0) throw new Error('AUTOMATION_CAPTURE_FAILED');
  if (Object.values(processResult.probes).some((probe) => probe.forbidden_matches.length > 0)) throw new Error('FORBIDDEN_COUPLING_DETECTED');
  const metrics = JSON.parse(await readFile(path.join(artifactsDir, 'review-automation-metrics.json'), 'utf8'));
  const complete = JSON.parse(await readFile(path.join(artifactsDir, 'automation-complete.json'), 'utf8'));
  if (complete.session_id !== sessionId || complete.fixture !== 'G3-REVIEW-001' || complete.manifest_sha256 !== manifestHash
    || complete.metrics_file !== 'review-automation-metrics.json' || !Number.isFinite(Date.parse(complete.completed_at))
    || complete.completed_at !== metrics?.provenance?.captured_at
    || !Array.isArray(complete.preview_hashes) || complete.preview_hashes.length === 0) throw new Error('AUTOMATION_CAPTURE_INCOMPLETE');
  return {
    provenance, metrics, complete, sessionId, manifestSha256: manifestHash,
    snapshot: {
      binary_sha256: await shaFile(FIXED_EXECUTABLE), dependency_manifest_sha256: await shaFile(DEPENDENCY_LOCK),
      renderer_manifest_sha256: provenance.renderer_environment_sha256,
      preview_hashes: complete.preview_hashes, probes: processResult.probes
    }
  };
}

function validateTestCapture(value, args) {
  if (value?.schema_id !== 'superwagie.g3-review-test-capture.v1' || value.platform !== args.platform
    || value.scenario !== args.scenario || !value.precondition?.verified || !value.snapshot
    || value.provenance?.schema_id !== 'superwagie.review-renderer-provenance.v1'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.session_id ?? '') || !/^[0-9a-f]{64}$/.test(value.manifest_sha256 ?? '')
    || value.metrics?.provenance?.session_id !== value.session_id
    || value.metrics?.provenance?.manifest_sha256 !== value.manifest_sha256
    || value.complete?.fixture !== 'G3-REVIEW-001' || value.complete?.session_id !== value.session_id
    || value.complete?.manifest_sha256 !== value.manifest_sha256 || value.complete?.metrics_file !== 'review-automation-metrics.json'
    || value.complete?.completed_at !== value.metrics?.provenance?.captured_at
    || !value.metrics || !value.complete) throw new Error('TEST_CAPTURE_INVALID');
  return value;
}

async function writePassingEvidence(args, resultsPath, artifactsDir, material, precondition) {
  const capturedAt = new Date().toISOString();
  const runId = `isolation-${randomBytes(12).toString('hex')}`;
  const binding = {
    fixture: 'G3-REVIEW-002', scenario: args.scenario, platform: args.platform,
    run_id: runId,
    session_id: material.sessionId ?? material.session_id,
    manifest_sha256: material.manifestSha256 ?? material.manifest_sha256
  };
  const documents = {
    capture: { schema_id: 'superwagie.g3-review-capture.v1', schema_version: 1, binding, captured_at: capturedAt, precondition, snapshot: material.snapshot },
    renderer_provenance: { ...material.provenance, binding },
    review_automation_metrics: {
      schema_id: 'superwagie.g3-review-metrics.v1', schema_version: 1, binding,
      renderer_environment_sha256: material.snapshot.renderer_manifest_sha256,
      metrics_document: material.metrics
    }
  };
  const filenames = { capture: 'capture.json', renderer_provenance: 'renderer-provenance.json', review_automation_metrics: 'review-automation-metrics.json', automation_complete: 'automation-complete.json' };
  const artifacts = {};
  for (const [key, document] of Object.entries(documents)) {
    const file = path.join(artifactsDir, filenames[key]);
    await writeJson(file, document);
    artifacts[key] = { relative_path: path.relative(path.dirname(resultsPath), file).split(path.sep).join('/'), sha256: await shaFile(file) };
  }
  documents.automation_complete = {
    schema_id: 'superwagie.g3-review-completion.v1', schema_version: 1, binding,
    captured_at: capturedAt, renderer_environment_sha256: material.snapshot.renderer_manifest_sha256,
    metrics_sha256: artifacts.review_automation_metrics.sha256,
    preview_hashes: material.snapshot.preview_hashes,
    completion: {
      fixture: material.complete.fixture, session_id: material.complete.session_id,
      manifest_sha256: material.complete.manifest_sha256, metrics_file: material.complete.metrics_file,
      completed_at: material.complete.completed_at
    },
    trusted: material.complete?.trusted !== false
  };
  const completionFile = path.join(artifactsDir, filenames.automation_complete);
  await writeJson(completionFile, documents.automation_complete);
  artifacts.automation_complete = {
    relative_path: path.relative(path.dirname(resultsPath), completionFile).split(path.sep).join('/'),
    sha256: await shaFile(completionFile)
  };
  let comparison = { equal: true, reasons: [] };
  if (args.scenario !== 'codex-never-installed') {
    const baseline = await validateIsolationEvidence(args.baselineResults, args.baselineEvidenceRoot, { scenario: 'codex-never-installed', platform: args.platform });
    comparison = compareIsolationSnapshots(baseline.snapshot, material.snapshot);
  }
  const result = attestIsolationResult({
    schema_id: 'superwagie.g3-review-isolation-result.v1', schema_version: 1,
    gate: 'gate-3', fixture: 'G3-REVIEW-002', scenario: args.scenario, platform: args.platform,
    run_id: runId, session_id: binding.session_id,
    manifest_sha256: binding.manifest_sha256, captured_at: capturedAt,
    pass: comparison.equal, status: comparison.equal ? 'passed' : 'failed', decision_hint: comparison.equal ? 'GO' : 'NO_GO', reasons: comparison.reasons,
    precondition, snapshot: material.snapshot, artifacts
  });
  await writeJson(resultsPath, result);
  if (comparison.equal) await validateIsolationEvidence(resultsPath, path.dirname(resultsPath), { scenario: args.scenario, platform: args.platform });
  return comparison.equal ? 0 : 1;
}

async function main(argv) {
  let args;
  try { args = parse(argv); } catch (error) { console.error(error.message); return 2; }
  if (args.help) { console.log('review-isolation-gate.mjs --fixture G3-REVIEW-002 --scenario ID --platform ID --results-json ABS --artifacts-dir ABS --wps-python ABS --wpscomposer-root ABS --wps-application ABS --machine-profile ABS'); return 0; }
  let resultsPath;
  let artifactsDir;
  for (const key of ['wpsPython', 'wpscomposerRoot', 'wpsApplication', 'wpsNode', 'wpsHome', 'machineProfile', 'scenarioAttestation', 'baselineResults', 'baselineEvidenceRoot', 'testCaptureJson']) if (args[key] === '') delete args[key];
  try {
    resultsPath = absolute(args.resultsJson, '--results-json');
    artifactsDir = absolute(args.artifactsDir, '--artifacts-dir');
    for (const [value, label] of [[args.testCaptureJson, '--test-capture-json'], [args.scenarioAttestation, '--scenario-attestation'], [args.baselineResults, '--baseline-results'], [args.baselineEvidenceRoot, '--baseline-evidence-root']]) if (value !== undefined) absolute(value, label);
  } catch (error) { console.error(error.message); return 2; }
  await mkdir(artifactsDir, { recursive: true });
  const blocked = async (reason) => { await writeJson(resultsPath, blockedResult(args, reason)); return 2; };
  if (args.fixture !== 'G3-REVIEW-002') return blocked('UNKNOWN_FIXTURE');
  if (!SCENARIOS.has(args.scenario)) return blocked('UNKNOWN_SCENARIO');
  if (!/^(?:macos-15-arm64|windows-11-x64)$/.test(args.platform ?? '')) return blocked('PLATFORM_INVALID');
  if (args.scenario !== 'codex-never-installed' && (!args.baselineResults || !args.baselineEvidenceRoot)) return blocked('BASELINE_EVIDENCE_REQUIRED');
  try {
    if (args.testCaptureJson) {
      const fake = validateTestCapture(JSON.parse(await readFile(args.testCaptureJson, 'utf8')), args);
      return await writePassingEvidence(args, resultsPath, artifactsDir, fake, fake.precondition);
    }
    const precondition = await preconditionEvidence(args, artifactsDir);
    return await writePassingEvidence(args, resultsPath, artifactsDir, await productionCapture(args, artifactsDir), precondition);
  } catch (error) {
    await writeJson(resultsPath, blockedResult(args, error.message || 'CAPTURE_FAILED'));
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
export { capturePlatformApplicationState, FIXED_EXECUTABLE, main, probeRecord, runOwnedCapture, sampleWindowsOwnedTree, SCENARIOS };
