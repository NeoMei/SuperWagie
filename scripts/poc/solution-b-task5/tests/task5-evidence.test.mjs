import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildTask5Evidence, task5RunnerKey } from '../src/build-evidence.mjs';
import { task5Fixture } from '../src/task5-lib.mjs';
import { findCandidateRoot } from '../../solution-b-spike/src/candidate-discovery.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const candidateRoot = findCandidateRoot(repositoryRoot);

test('Task 5 evidence publisher creates four hash-bound immutable child runs', async () => {
  const base = mkdtempSync(join(tmpdir(), 'superwagie-task5-evidence-test-'));
  const runners = {
    [task5RunnerKey('G0-DEPS-001', 'CANDIDATE')]: async () => ({ pass: true, fixture: task5Fixture('G0-DEPS-001', 'CANDIDATE'), secret_path: candidateRoot + '/x' }),
    [task5RunnerKey('G0-ISOLATION-001', 'ZERO-DIFF')]: async () => ({ pass: true, fixture: task5Fixture('G0-ISOLATION-001', 'ZERO-DIFF'), scenarios: [] }),
    [task5RunnerKey('G5-ATTACK-001', 'ACTUAL-BOUNDARY')]: async () => ({ pass: true, fixture: task5Fixture('G5-ATTACK-001', 'ACTUAL-BOUNDARY') }),
    [task5RunnerKey('G5-EXT-001', 'WORKER')]: async () => ({ pass: true, fixture: task5Fixture('G5-EXT-001', 'WORKER') }),
  };
  const publication = await buildTask5Evidence({ candidateRoot, evidenceBase: base, runId: 'fixed-run', runners });
  assert.equal(Object.keys(publication.runs).length, 4);
  for (const run of Object.values(publication.runs)) {
    assert.equal(run.pass, true);
    assert.ok(existsSync(join(run.root, 'results.json')));
    assert.ok(existsSync(join(run.root, 'artifacts/execution-context.json')));
    const decision = readFileSync(join(run.root, 'decision.md'), 'utf8');
    const digest = createHash('sha256').update(readFileSync(join(run.root, 'results.json'))).digest('hex');
    assert.match(decision, new RegExp(`evidence_sha256: sha256:${digest}`));
    assert.match(decision, /draft decision/);
    assert.doesNotMatch(decision, /signed decision/);
  }
  const depsKey = task5RunnerKey('G0-DEPS-001', 'CANDIDATE');
  const deps = readFileSync(join(publication.runs[depsKey].root, 'results.json'), 'utf8');
  assert.ok(!deps.includes(candidateRoot));
  assert.ok(deps.includes('<candidate>/x'));

  await assert.rejects(
    () => buildTask5Evidence({ candidateRoot, evidenceBase: base, runId: 'fixed-run', runners }),
    /EEXIST|TASK5_EVIDENCE_ROOT_EXISTS/,
  );
});
