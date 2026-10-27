import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const powershellPath = path.join(scriptDirectory, 'collect-windows-diagnostics.ps1');
const commandPath = path.join(scriptDirectory, 'collect-windows-diagnostics.cmd');
const packagePath = path.resolve(scriptDirectory, '..', 'package.json');
const powershell = fs.readFileSync(powershellPath, 'utf8');
const command = fs.readFileSync(commandPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const powershellExecutable = process.env.SUPERWAGIE_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : null);
const powershellOnly = { skip: !powershellExecutable };

function runWindowsFixture(t, { compressionFails = false, outputIsFile = false, processQueryFails = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-collector-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  if (outputIsFile) fs.writeFileSync(output, 'Existing file');
  else fs.mkdirSync(output);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const fixture = `
$ErrorActionPreference = 'Stop'
$fixtureRoot = ${quote(root)}
$env:TEMP = $fixtureRoot
$env:TMP = $fixtureRoot
$env:OPENCHAMBER_DATA_DIR = Join-Path $fixtureRoot 'missing-data'

# Keep the fixture independent of the current user's application data.
function Test-Path {
  [CmdletBinding()]
  param([string]$LiteralPath, [string]$Path, [Alias('Type')][string]$PathType = 'Any')
  $candidate = if ($LiteralPath) { $LiteralPath } else { $Path }
  if ($candidate.StartsWith($fixtureRoot, [StringComparison]::OrdinalIgnoreCase)) {
    return Microsoft.PowerShell.Management\\Test-Path @PSBoundParameters
  }
  return $false
}
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName)
  if ($ClassName -eq 'Win32_OperatingSystem') {
    return [pscustomobject]@{ Caption = 'Fixture'; Version = '10.0'; BuildNumber = '26200'; OSArchitecture = '64-bit'; LastBootUpTime = Get-Date }
  }
  if ($ClassName -eq 'Win32_ComputerSystem') {
    return [pscustomobject]@{ Manufacturer = 'Fixture'; Model = 'Fixture'; SystemType = 'x64' }
  }
  ${processQueryFails ? "throw 'Synthetic process query failure'" : ''}
  return @()
}
function Get-Process { [CmdletBinding()] param($Name) return @() }
function Get-NetTCPConnection { [CmdletBinding()] param() return @() }
function Get-WinEvent { [CmdletBinding()] param($FilterHashtable, $MaxEvents) return @() }
${compressionFails ? `
function Compress-Archive {
  [CmdletBinding()]
  param($Path, $DestinationPath, $CompressionLevel, [switch]$Force)
  Write-Error 'Synthetic compression failure'
}` : ''}
& ${quote(powershellPath)} -OutputDirectory ${quote(output)}
${compressionFails || outputIsFile ? '' : `
$archive = Microsoft.PowerShell.Management\\Get-ChildItem -LiteralPath ${quote(output)} -Filter '*.zip'
Expand-Archive -LiteralPath $archive.FullName -DestinationPath (Join-Path $fixtureRoot 'expanded')
`}
`;
  const result = spawnSync(powershellExecutable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(fixture, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root },
  });
  assert.ifError(result.error);
  return { root, output, result };
}

test('Windows collector gathers bounded redacted lifecycle evidence', () => {
  assert.match(powershell, /Get-WinEvent/);
  assert.match(powershell, /Get-NetTCPConnection/);
  assert.match(powershell, /Compress-Archive/);
  assert.match(powershell, /-Tail 4000/);
  assert.match(powershell, /Redact-Text/);
  assert.match(powershell, /application-events\.json/);
  assert.match(powershell, /process-tree\.json/);
  assert.match(powershell, /manifest\.json/);
});

test('Windows PowerShell reads the collector as UTF-8 with its Chinese app name intact', () => {
  assert.deepEqual([...fs.readFileSync(powershellPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(powershell, /犇马/);
});

test('Windows collector does not copy high-risk user state', () => {
  assert.doesNotMatch(powershell, /CommandLine/);
  assert.doesNotMatch(powershell, /Get-Content\s+.*(?:auth|cookie|settings|config)/i);
  assert.doesNotMatch(powershell, /\.dmp/);
  assert.match(powershell, /Authorization/);
  assert.match(powershell, /pairing/);
  assert.match(powershell, /private\[_-\]\?key/);
});

test('double-click entry uses a process-local execution-policy override', () => {
  assert.match(command, /-NoProfile/);
  assert.match(command, /-ExecutionPolicy Bypass/);
  assert.match(command, /collect-windows-diagnostics\.ps1/);
});

test('the desktop package includes both collector files as Windows resources', () => {
  const resource = packageJson.build.extraResources.find((entry) => entry.to === 'windows-diagnostics');
  assert.deepEqual(resource?.filter, ['collect-windows-diagnostics.ps1', 'collect-windows-diagnostics.cmd']);
  assert.equal(resource?.from, 'scripts');
  assert.equal(fs.existsSync(powershellPath), true);
  assert.equal(fs.existsSync(commandPath), true);
});

test('PowerShell writes a complete manifest and empty JSON arrays', powershellOnly, (t) => {
  const { root, result } = runWindowsFixture(t);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const expanded = path.join(root, 'expanded');
  const manifest = JSON.parse(fs.readFileSync(path.join(expanded, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.files));
  assert.ok(Array.isArray(manifest.warnings));
  assert.equal(manifest.files.length, 6);
  assert.ok(manifest.files.every((file) => file.collected && file.bytes > 0));
  for (const name of ['processes.json', 'process-tree.json', 'network.json', 'application-events.json']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(expanded, name), 'utf8')), []);
  }
  assert.match(result.stdout, /diagnostics archive created/);
  assert.match(result.stdout + result.stderr, /warning\(s\)/);
  assert.equal(fs.readdirSync(root).filter((name) => name.startsWith('SuperWagie-diagnostics-')).length, 0);
});

test('PowerShell returns failure and retains evidence when compression fails', powershellOnly, (t) => {
  const { root, output, result } = runWindowsFixture(t, { compressionFails: true });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /diagnostics archive created/);
  assert.equal(fs.readdirSync(output).length, 0);
  const remaining = fs.readdirSync(root).filter((name) => name.startsWith('SuperWagie-diagnostics-'));
  assert.equal(remaining.length, 1);
  assert.ok(fs.existsSync(path.join(root, remaining[0], 'manifest.json')));
});

test('PowerShell stops when the output directory cannot be created', powershellOnly, (t) => {
  const { result } = runWindowsFixture(t, { outputIsFile: true });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /diagnostics archive created/);
});

test('PowerShell retains useful evidence and excludes fixture secrets', powershellOnly, () => {
  const result = spawnSync(powershellExecutable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scriptDirectory, 'collect-windows-diagnostics-evidence.test.ps1'),
  ], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /All \d+ evidence tests passed on PowerShell/);
});


test('PowerShell reports failed queries without authoritative empty snapshots', powershellOnly, (t) => {
  const { root, result } = runWindowsFixture(t, { processQueryFails: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const expanded = path.join(root, 'expanded');
  const manifest = JSON.parse(fs.readFileSync(path.join(expanded, 'manifest.json'), 'utf8'));
  assert.ok(manifest.warnings.includes('Could not collect process tree'));
  assert.ok(manifest.warnings.includes('Could not collect network connections'));
  assert.equal(fs.existsSync(path.join(expanded, 'process-tree.json')), false);
  assert.equal(fs.existsSync(path.join(expanded, 'network.json')), false);
});
