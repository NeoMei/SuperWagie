import assert from 'node:assert/strict';
import fs from 'node:fs';
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
