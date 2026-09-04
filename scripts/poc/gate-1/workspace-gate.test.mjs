import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const gatePath = path.join(import.meta.dirname, 'workspace-gate.mjs');

test('workspace gate rejects linked ancestors and never follows a symlink leaf during mutation', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-workspace-gate-test-'));
  const resultsPath = path.join(temp, 'results.json');

  try {
    const result = spawnSync(process.execPath, [
      gatePath,
      '--fixture', 'G1-WORKSPACE-001',
      '--results-json', resultsPath
    ], {
      encoding: 'utf8',
      timeout: 180_000
    });

    assert.notEqual(result.error?.code, 'ETIMEDOUT', result.stderr || result.stdout);
    assert.equal(fs.existsSync(resultsPath), true, result.stderr || result.stdout);

    const report = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    assert.equal(report.pass, false, 'blocked environment evidence must never claim a passing result');
    assert.equal(report.decision_hint, 'BLOCKED_ENVIRONMENT');
    assert.match(report.limitation, /handle-relative no-follow publish/i);
    const byId = new Map(report.checks.map((check) => [check.id, check]));

    assert.equal(
      byId.get('ws:linked-ancestor-nonexistent-leaf-rejected')?.passed,
      true,
      'a symlink or Windows junction ancestor must not create a missing leaf outside the workspace'
    );
    assert.equal(
      byId.get('ws:symlink-leaf-replaced-not-followed')?.passed,
      true,
      'a final symlink must be replaced as a directory entry without modifying its target'
    );
    assert.equal(
      byId.get('ws:ancestor-swap-toctou-guard')?.passed,
      true,
      'an ancestor swapped to a link after the first check must fail closed before publish'
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
