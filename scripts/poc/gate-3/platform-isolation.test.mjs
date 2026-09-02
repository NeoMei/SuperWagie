import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePlatformApplicationState, probeRecord, runOwnedCapture, sampleWindowsOwnedTree } from './review-isolation-gate.mjs';

test('Windows isolation precondition uses the Windows application/process contract without macOS paths', async () => {
  const calls = [];
  const state = await capturePlatformApplicationState('windows-11-x64', {
    execute(program, args) {
      calls.push({ program, args });
      return { status: 0, stdout: JSON.stringify({ installed: ['Codex.exe'], codex_running: true }) };
    },
    environment: { WINDIR: 'C:\\Windows' }
  });
  assert.deepEqual(state.installed, ['Codex.exe']);
  assert.equal(state.codexRunning, true);
  assert.match(calls[0].program, /powershell\.exe$/i);
  assert.doesNotMatch(JSON.stringify(calls), /\/Applications|system_profiler/);
});

test('unsupported isolation platforms fail closed instead of using macOS probes', async () => {
  await assert.rejects(capturePlatformApplicationState('linux-x64'), /unsupported/i);
});

test('Windows owned-tree probe is descendant-scoped and Windows forbidden paths are detected path-free', () => {
  const calls = [];
  const owned = new Set([101]);
  const captured = sampleWindowsOwnedTree(101, owned, (program, args) => {
    calls.push({ program, args });
    const script = String(args[3]);
    assert.doesNotMatch(script, /\$(?:id|pid)\b/i, 'PowerShell automatic $PID must never be shadowed');
    assert.match(script, /\$scopedPid\b/);
    return { status: 0, stdout: JSON.stringify({ pids: [101, 202], process: ['wps.exe'], paths: ['C:\\Users\\private\\.codex\\held.txt'], network: [] }) };
  }, { WINDIR: 'C:\\Windows' });
  assert.deepEqual([...owned], [101, 202]);
  assert.match(calls[0].program, /powershell\.exe$/i);
  assert.match(calls[0].args.join(' '), /ParentProcessId/);
  const receipt = probeRecord(captured.paths);
  assert.ok(receipt.forbidden_matches.some((value) => value.includes('.codex')));
  assert.doesNotMatch(JSON.stringify(receipt), /Users\\private/);
});

test('Windows CI executes the standard owned-tree capture without injected PowerShell output', {
  skip: process.platform !== 'win32'
}, async () => {
  const result = await runOwnedCapture(process.execPath, {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? ''
  }, 10_000);
  assert.equal(result.launchFailed, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.probeFailed, false);
  assert.ok(result.ownedPidCount >= 1);
});
