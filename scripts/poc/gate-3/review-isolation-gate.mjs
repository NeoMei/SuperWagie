#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attestIsolationResult, compareIsolationSnapshots, validateIsolationEvidence } from './isolation-evidence.mjs';
import {
  captureTrustedProvenance,
  privateWpsLaunchEnvironment,
  trustedWindowsProbeEnvironment,
  WINDOWS_POWERSHELL,
  WINDOWS_PROBE_TIMEOUT_MS
} from './review-provenance.mjs';

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
      '$ErrorActionPreference="Stop";',
      '$installed=@();',
      '$localApplicationData=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData);',
      '$programFiles=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles);',
      '$candidates=@(',
      '@("Codex.exe",(Join-Path $localApplicationData "Programs\\Codex\\Codex.exe")),',
      '@("ChatGPT.exe",(Join-Path $localApplicationData "Programs\\ChatGPT\\ChatGPT.exe")),',
      '@("ChatGPT.exe",(Join-Path $programFiles "ChatGPT\\ChatGPT.exe"))',
      '); foreach($entry in $candidates){if(Test-Path -LiteralPath $entry[1] -PathType Leaf){$installed+=$entry[0]}};',
      '$running=@(Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue).Count -gt 0;',
      '[pscustomobject]@{installed=@($installed|Sort-Object -Unique);codex_running=$running}|ConvertTo-Json -Compress'
    ].join(' ');
    const result = execute(WINDOWS_POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: trustedWindowsProbeEnvironment(),
      maxBuffer: 8 * 1024 * 1024,
      timeout: WINDOWS_PROBE_TIMEOUT_MS,
      windowsHide: true
    });
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

function windowsIdentityEnvironment(identities) {
  return [...identities]
    .sort(([left], [right]) => left - right)
    .map(([processId, creation]) => `${processId}@${creation}`)
    .join(',');
}

function windowsOwnedTreeInvocation(rootPid, owned, identities = new Map(), allowUnknownRoot = identities.size === 0) {
  const script = [
    '$ErrorActionPreference="Stop";',
    '$expected=@{}; foreach($rawIdentity in ([string]$env:SUPERWAGIE_OWNED_IDENTITIES).Split(",")){if($rawIdentity){$identityParts=$rawIdentity.Split("@");if($identityParts.Count -ne 2){throw "invalid owned identity"};$expected[[int]$identityParts[0]]=[int64]$identityParts[1]}};',
    '$ownedProcesses=@{};$ownedIdentities=@{};',
    '$queue=New-Object "System.Collections.Generic.Queue[int]";',
    '$queued=New-Object "System.Collections.Generic.HashSet[int]";',
    '$rootProcessId=[int]$env:SUPERWAGIE_ROOT_PID;$allowUnknownRoot=$env:SUPERWAGIE_ALLOW_UNKNOWN_ROOT -eq "1";',
    '$allProcesses=@(Get-CimInstance Win32_Process -ErrorAction Stop);',
    '$networkAvailable=$true;try{$allNetwork=@(Get-NetTCPConnection -ErrorAction Stop)}catch{$networkAvailable=$false;$allNetwork=@()};',
    'foreach($rawSeed in ([string]$env:SUPERWAGIE_OWNED_PIDS).Split(",")){if($rawSeed){$scopedProcessId=[int]$rawSeed;$hasExpected=$expected.ContainsKey($scopedProcessId);$seedProcess=$allProcesses|Where-Object{$_.ProcessId -eq $scopedProcessId}|Select-Object -First 1;if($seedProcess){$seedCreation=[int64]$seedProcess.CreationDate.ToUniversalTime().ToFileTimeUtc();if(($hasExpected -and $expected[$scopedProcessId] -eq $seedCreation) -or ((-not $hasExpected) -and $scopedProcessId -eq $rootProcessId -and $allowUnknownRoot)){$ownedProcesses[$scopedProcessId]=$seedProcess;$ownedIdentities[$scopedProcessId]=$seedCreation;if($queued.Add($scopedProcessId)){$queue.Enqueue($scopedProcessId)}}}elseif($hasExpected -or ($scopedProcessId -eq $rootProcessId -and $allowUnknownRoot)){if($queued.Add($scopedProcessId)){$queue.Enqueue($scopedProcessId)}}}};',
    'while($queue.Count -gt 0){$parentProcessId=$queue.Dequeue();$allProcesses|Where-Object{$_.ParentProcessId -eq $parentProcessId}|ForEach-Object{$descendantProcessId=[int]$_.ProcessId;$descendantCreation=[int64]$_.CreationDate.ToUniversalTime().ToFileTimeUtc();if((-not $expected.ContainsKey($descendantProcessId)) -or $expected[$descendantProcessId] -eq $descendantCreation){$ownedProcesses[$descendantProcessId]=$_;$ownedIdentities[$descendantProcessId]=$descendantCreation;if($queued.Add($descendantProcessId)){$queue.Enqueue($descendantProcessId)}}}};',
    '$process=@();$paths=@();$network=@();$probeErrors=@(); foreach($ownedEntry in $ownedProcesses.GetEnumerator()){$ownedProcessId=[int]$ownedEntry.Key;$ownedProcess=$ownedEntry.Value;$ownedCreation=[int64]$ownedIdentities[$ownedProcessId];',
    '$process+=@($ownedProcess.Name,$ownedProcess.ExecutablePath,$ownedProcess.CommandLine)|Where-Object{$_};',
    'try{$nativeProcess=Get-Process -Id $ownedProcessId -ErrorAction Stop;$nativeCreation=[int64]$nativeProcess.StartTime.ToUniversalTime().ToFileTimeUtc();if($nativeCreation -ne $ownedCreation){$probeErrors+="identity:$ownedProcessId"}else{$paths+=@($nativeProcess.Modules)|ForEach-Object{$_.FileName};if($networkAvailable){$network+=$allNetwork|Where-Object{$_.OwningProcess -eq $ownedProcessId}|ForEach-Object{"$($_.RemoteAddress):$($_.RemotePort)"}}else{$probeErrors+="network:$ownedProcessId"}}}catch{if(Get-Process -Id $ownedProcessId -ErrorAction SilentlyContinue){$probeErrors+="modules:$ownedProcessId"}};',
    '};$identityOutput=@($ownedIdentities.GetEnumerator()|ForEach-Object{"$($_.Key)@$($_.Value)"}|Sort-Object);[pscustomobject]@{pids=@($ownedIdentities.Keys|Sort-Object);identities=$identityOutput;process=@($process);paths=@($paths);network=@($network);probe_errors=@($probeErrors)}|ConvertTo-Json -Compress -Depth 4'
  ].join(' ');
  const seeds = [...new Set([rootPid, ...owned])].sort((left, right) => left - right).join(',');
  return {
    program: WINDOWS_POWERSHELL,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    options: {
    encoding: 'utf8',
    env: trustedWindowsProbeEnvironment({
      SUPERWAGIE_OWNED_PIDS: seeds,
      SUPERWAGIE_OWNED_IDENTITIES: windowsIdentityEnvironment(identities),
      SUPERWAGIE_ROOT_PID: String(rootPid),
      SUPERWAGIE_ALLOW_UNKNOWN_ROOT: allowUnknownRoot ? '1' : '0'
    }),
    maxBuffer: 16 * 1024 * 1024,
    timeout: WINDOWS_PROBE_TIMEOUT_MS,
    windowsHide: true
    }
  };
}

function acceptWindowsOwnedTreeResult(result, owned, identities = new Map(), live = new Set()) {
  if (result.status !== 0 || result.error) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_UNAVAILABLE');
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.pids) || !Array.isArray(value.identities)
    || !['process', 'paths', 'network', 'probe_errors'].every((key) => Array.isArray(value[key]))
    || value.pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
    || ['identities', 'process', 'paths', 'network', 'probe_errors'].some((key) => value[key].some((entry) => typeof entry !== 'string'))) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_INVALID');
  if (value.probe_errors.length > 0) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_INCOMPLETE');
  const captured = new Map();
  for (const entry of value.identities) {
    const match = entry.match(/^(\d+)@(\d+)$/u);
    if (!match) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_INVALID');
    const processId = Number(match[1]);
    const creation = match[2];
    if (!Number.isSafeInteger(processId) || processId <= 0 || captured.has(processId)) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_INVALID');
    captured.set(processId, creation);
  }
  if (value.pids.length !== captured.size || value.pids.some((processId) => !captured.has(processId))) throw new Error('OWNED_WINDOWS_PROCESS_PROBE_INVALID');
  live.clear();
  for (const [processId, creation] of captured) {
    const expected = identities.get(processId);
    if (expected !== undefined && expected !== creation) throw new Error('OWNED_WINDOWS_PROCESS_IDENTITY_CHANGED');
    owned.add(processId);
    identities.set(processId, creation);
    live.add(processId);
  }
  return Object.fromEntries(['process', 'paths', 'network'].map((key) => [key, `${value[key].join('\n')}\n`]));
}

function sampleWindowsOwnedTree(rootPid, owned, execute = spawnSync, _environment = process.env) {
  const invocation = windowsOwnedTreeInvocation(rootPid, owned);
  return acceptWindowsOwnedTreeResult(
    execute(invocation.program, invocation.args, invocation.options),
    owned
  );
}

async function sampleWindowsOwnedTreeAsync(rootPid, owned, identities, live, allowUnknownRoot) {
  const invocation = windowsOwnedTreeInvocation(rootPid, owned, identities, allowUnknownRoot);
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
    const timeout = setTimeout(() => {
      probe.kill();
      reject(new Error('OWNED_WINDOWS_PROCESS_PROBE_TIMEOUT'));
    }, WINDOWS_PROBE_TIMEOUT_MS);
    probe.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    probe.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    probe.once('error', (error) => { clearTimeout(timeout); reject(error); });
    probe.once('close', (status) => {
      clearTimeout(timeout);
      if (oversized) reject(new Error('OWNED_WINDOWS_PROCESS_PROBE_OVERSIZED'));
      else resolve({ status, stdout, stderr });
    });
  });
  return acceptWindowsOwnedTreeResult(result, owned, identities, live);
}

function windowsOwnedTreeTerminationInvocation(identities) {
  const script = [
    '$ErrorActionPreference="Stop";$failed=@();',
    'foreach($rawIdentity in ([string]$env:SUPERWAGIE_OWNED_IDENTITIES).Split(",")){if(-not $rawIdentity){continue};$identityParts=$rawIdentity.Split("@");if($identityParts.Count -ne 2){throw "invalid owned identity"};$ownedProcessId=[int]$identityParts[0];$ownedCreation=[int64]$identityParts[1];',
    '$ownedProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$ownedProcessId" -ErrorAction Stop|Select-Object -First 1;if(-not $ownedProcess){continue};$actualCreation=[int64]$ownedProcess.CreationDate.ToUniversalTime().ToFileTimeUtc();if($actualCreation -ne $ownedCreation){continue};',
    'try{$termination=Invoke-CimMethod -InputObject $ownedProcess -MethodName Terminate -Arguments @{Reason=1} -ErrorAction Stop;if([int]$termination.ReturnValue -ne 0){$failed+=$ownedProcessId}}catch{$failed+=$ownedProcessId}};',
    '[pscustomobject]@{failed=@($failed)}|ConvertTo-Json -Compress'
  ].join(' ');
  return {
    program: WINDOWS_POWERSHELL,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    options: {
      env: trustedWindowsProbeEnvironment({ SUPERWAGIE_OWNED_IDENTITIES: windowsIdentityEnvironment(identities) }),
      windowsHide: true
    }
  };
}

async function terminateWindowsOwnedTreeAsync(identities) {
  if (identities.size === 0) return;
  const invocation = windowsOwnedTreeTerminationInvocation(identities);
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
      if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) {
        oversized = true;
        probe.kill();
      }
      return value;
    };
    const timeout = setTimeout(() => {
      probe.kill();
      reject(new Error('OWNED_WINDOWS_PROCESS_TERMINATION_TIMEOUT'));
    }, WINDOWS_PROBE_TIMEOUT_MS);
    probe.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    probe.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    probe.once('error', (error) => { clearTimeout(timeout); reject(error); });
    probe.once('close', (status) => {
      clearTimeout(timeout);
      if (oversized) reject(new Error('OWNED_WINDOWS_PROCESS_TERMINATION_OVERSIZED'));
      else resolve({ status, stdout, stderr });
    });
  });
  if (result.status !== 0) throw new Error('OWNED_WINDOWS_PROCESS_TERMINATION_UNAVAILABLE');
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.failed) || value.failed.some((processId) => !Number.isSafeInteger(processId) || processId <= 0)) {
    throw new Error('OWNED_WINDOWS_PROCESS_TERMINATION_INVALID');
  }
  if (value.failed.length > 0) throw new Error('OWNED_WINDOWS_PROCESS_TERMINATION_INCOMPLETE');
}

async function runOwnedCapture(executable, environment, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(executable, [], { env: environment, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    const raw = { process: '', paths: '', network: '' };
    const owned = new Set();
    const unixProcessIdentities = new Map();
    const windowsProcessIdentities = new Map();
    const windowsLivePids = new Set();
    let windowsRootDiscoveryPending = true;
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
    const unixProcessRecord = (pid) => {
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'state=', '-o', 'lstart='], { encoding: 'utf8' });
      if (result.status === 1 || !result.stdout?.trim()) return null;
      if (result.status !== 0 || result.error) throw new Error('OWNED_PROCESS_IDENTITY_UNAVAILABLE');
      const match = result.stdout.trim().match(/^(\S+)\s+(.+)$/u);
      if (!match) throw new Error('OWNED_PROCESS_IDENTITY_INVALID');
      return { state: match[1], identity: match[2] };
    };
    const rememberUnixPid = (pid) => {
      if (owned.has(pid)) return;
      const record = unixProcessRecord(pid);
      if (!record) return;
      owned.add(pid);
      unixProcessIdentities.set(pid, record.identity);
    };
    const unixOwnedPidAlive = (pid) => {
      const expected = unixProcessIdentities.get(pid);
      if (!expected) return false;
      const record = unixProcessRecord(pid);
      return record !== null && record.identity === expected && !record.state.startsWith('Z');
    };
    const discoverOwnedTree = () => {
      if (child.pid) rememberUnixPid(child.pid);
      // A detached process remains the process-group leader even if it exits
      // before the first sample. Query the fixed group id during the bounded
      // drain window so surviving same-group descendants cannot disappear with
      // the leader. Per-PID start identities below still reject PID reuse.
      for (const member of child.pid ? discoverPids('-g', child.pid) : []) rememberUnixPid(member);
      let changed = true;
      for (let round = 0; round < 16 && changed; round += 1) {
        changed = false;
        for (const pid of [...owned]) {
          if (!unixOwnedPidAlive(pid)) continue;
          for (const descendant of discoverPids('-P', pid)) {
            if (!owned.has(descendant)) {
              rememberUnixPid(descendant);
              if (owned.has(descendant)) changed = true;
            }
          }
        }
      }
    };
    const sampleOnce = async () => {
      if (process.platform === 'win32') {
        try {
          if (child.pid) owned.add(child.pid);
          const captured = await sampleWindowsOwnedTreeAsync(
            child.pid,
            owned,
            windowsProcessIdentities,
            windowsLivePids,
            windowsRootDiscoveryPending
          );
          windowsRootDiscoveryPending = false;
          for (const key of Object.keys(raw)) raw[key] += captured[key];
        } catch { probeFailed = true; raw.process += 'owned-process-discovery-failed\n'; }
        return;
      }
      try { discoverOwnedTree(); } catch { probeFailed = true; raw.process += 'owned-process-discovery-failed\n'; }
      for (const pid of owned) {
        if (!unixOwnedPidAlive(pid)) continue;
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
    const ownedAliveCount = () => process.platform === 'win32'
      ? windowsLivePids.size
      : [...owned].filter(unixOwnedPidAlive).length;
    const terminateOwned = async (signal) => {
      await requestSample();
      if (process.platform === 'win32') {
        const liveIdentities = new Map([...windowsProcessIdentities].filter(([processId]) => windowsLivePids.has(processId)));
        try { await terminateWindowsOwnedTreeAsync(liveIdentities); } catch { probeFailed = true; raw.process += 'owned-process-termination-failed\n'; }
        return;
      }
      for (const pid of [...owned].reverse()) {
        if (!unixOwnedPidAlive(pid)) continue;
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
        hardTimer = setTimeout(() => {
          void terminateOwned('SIGKILL').finally(() => {
            void finish(exitResult ?? { code: null, launchFailed: false });
          });
        }, 1000);
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
    // Capture the leader identity and any fast-spawned descendants before the
    // first interval tick. This narrows the launch-to-observation race without
    // relying on the leader still being alive later.
    void requestSample();
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
