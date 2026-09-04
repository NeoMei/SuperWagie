import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePlatformApplicationState, probeRecord, runOwnedCapture, sampleWindowsOwnedTree } from './review-isolation-gate.mjs';

test('Windows isolation precondition uses the Windows application/process contract without macOS paths', async () => {
  const calls = [];
  const state = await capturePlatformApplicationState('windows-11-x64', {
    execute(program, args, options) {
      calls.push({ program, args, options });
      return { status: 0, stdout: JSON.stringify({ installed: ['Codex.exe'], codex_running: true }) };
    },
    environment: { WINDIR: 'C:\\attacker-root', PSModulePath: 'C:\\attacker-modules' }
  });
  assert.deepEqual(state.installed, ['Codex.exe']);
  assert.equal(state.codexRunning, true);
  assert.equal(calls[0].program, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(calls[0].options.env.WINDIR, 'C:\\Windows');
  assert.equal(calls[0].options.env.PSModulePath, undefined);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.match(String(calls[0].args.at(-1)), /^\$ErrorActionPreference="Stop";/);
  assert.doesNotMatch(JSON.stringify(calls), /\/Applications|system_profiler/);
});

test('unsupported isolation platforms fail closed instead of using macOS probes', async () => {
  await assert.rejects(capturePlatformApplicationState('linux-x64'), /unsupported/i);
});

test('Windows owned-tree probe is descendant-scoped and Windows forbidden paths are detected path-free', () => {
  const calls = [];
  const owned = new Set([202]);
  const captured = sampleWindowsOwnedTree(101, owned, (program, args, options) => {
    calls.push({ program, args, options });
    const script = String(args.at(-1));
    assert.doesNotMatch(script, /\$(?:id|pid)\b/i, 'PowerShell automatic $PID must never be shadowed');
    assert.match(script, /\$scopedProcessId\b/);
    assert.match(script, /CreationDate/);
    assert.match(script, /\$hasExpected/);
    return { status: 0, stdout: JSON.stringify({ pids: [101, 202], identities: ['101@133700000000000000', '202@133700000000000001'], process: ['wps.exe'], paths: ['C:\\Users\\private\\.codex\\held.txt'], network: [], probe_errors: [] }) };
  }, { WINDIR: 'C:\\attacker-root', SUPERWAGIE_OWNED_PIDS: '999' });
  assert.deepEqual([...owned], [202, 101]);
  assert.equal(calls[0].program, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(calls[0].args.join(' '), /ParentProcessId/);
  assert.equal(calls[0].options.env.SUPERWAGIE_OWNED_PIDS, '101,202');
  assert.equal(calls[0].options.env.WINDIR, 'C:\\Windows');
  assert.equal(calls[0].options.timeout, 15_000);
  const receipt = probeRecord(captured.paths);
  assert.ok(receipt.forbidden_matches.some((value) => value.includes('.codex')));
  assert.doesNotMatch(JSON.stringify(receipt), /Users\\private/);
});

test('Windows owned-tree probe fails closed when any module or network enumeration is incomplete', () => {
  for (const probeErrors of [['modules:101'], ['network:101']]) {
    assert.throws(() => sampleWindowsOwnedTree(101, new Set(), () => ({
      status: 0,
      stdout: JSON.stringify({ pids: [101], identities: ['101@133700000000000000'], process: ['worker.exe'], paths: [], network: [], probe_errors: probeErrors })
    }), { WINDIR: 'C:\\Windows' }), /PROBE_INCOMPLETE/);
  }
});

test('Windows owned-tree probe rejects legacy output without completeness evidence', () => {
  assert.throws(() => sampleWindowsOwnedTree(101, new Set(), () => ({
    status: 0,
    stdout: JSON.stringify({ pids: [101], process: ['worker.exe'], paths: [], network: [] })
  }), { WINDIR: 'C:\\Windows' }), /PROBE_INVALID/);
});

test('Windows owned-tree probe rejects PID-only output without creation identities', () => {
  assert.throws(() => sampleWindowsOwnedTree(101, new Set(), () => ({
    status: 0,
    stdout: JSON.stringify({ pids: [101], process: ['worker.exe'], paths: [], network: [], probe_errors: [] })
  })), /PROBE_INVALID/);
});

test('Windows CI executes the standard owned-tree capture without injected PowerShell output', {
  skip: process.platform !== 'win32'
}, async () => {
  const result = await runOwnedCapture(process.execPath, {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? ''
  }, 60_000);
  assert.equal(result.launchFailed, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.probeFailed, false);
  assert.ok(result.ownedPidCount >= 1);
});
