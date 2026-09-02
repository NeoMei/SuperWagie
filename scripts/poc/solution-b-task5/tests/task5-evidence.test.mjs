import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildTask5Evidence } from '../src/build-evidence.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const candidateRoot = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/candidate-root');

test('Task 5 evidence publisher creates four hash-bound immutable child runs', async () => {
  const base = mkdtempSync(join(tmpdir(), 'superwagie-task5-evidence-test-'));
  const runners = {
    G0_DEPS_001_MACOS_CANDIDATE: async () => ({ pass: true, fixture: 'G0-DEPS-001-MACOS-CANDIDATE', secret_path: candidateRoot + '/x' }),
    G0_ISOLATION_001_MACOS_ZERO_DIFF: async () => ({ pass: true, fixture: 'G0-ISOLATION-001-MACOS-ZERO-DIFF', scenarios: [] }),
    G5_ATTACK_001_MACOS_ACTUAL_BOUNDARY: async () => ({ pass: true, fixture: 'G5-ATTACK-001-MACOS-ACTUAL-BOUNDARY' }),
    G5_EXT_001_MACOS_WORKER: async () => ({ pass: true, fixture: 'G5-EXT-001-MACOS-WORKER' }),
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
  const deps = readFileSync(join(publication.runs.G0_DEPS_001_MACOS_CANDIDATE.root, 'results.json'), 'utf8');
  assert.ok(!deps.includes(candidateRoot));
  assert.ok(deps.includes('<candidate>/x'));

  await assert.rejects(
    () => buildTask5Evidence({ candidateRoot, evidenceBase: base, runId: 'fixed-run', runners }),
    /EEXIST|TASK5_EVIDENCE_ROOT_EXISTS/,
  );
});
