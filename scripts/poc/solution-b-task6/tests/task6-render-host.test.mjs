import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { renderFrames } from '../src/task6-lib.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const candidateRoot = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/candidate-root');

test('the single bundled Chromium Render Host is deterministic across repeat jobs', { timeout: 90_000 }, async () => {
  const first = await renderFrames({
    fixture: 'G4-VIDEO-001', repositoryRoot, candidateRoot,
    workRoot: mkdtempSync(join(tmpdir(), 'superwagie-task6-render-a-')), frameCount: 3,
  });
  assert.equal(first.cleanExit, true);
  assert.equal(first.result.absoluteFrameDriven, true);
  assert.equal(first.result.executionManifestVerified, true);
  assert.equal(first.result.hashes.length, 3);
  assert.equal(new Set(first.result.hashes).size, 3);

  const second = await renderFrames({
    fixture: 'G4-VIDEO-001', repositoryRoot, candidateRoot,
    workRoot: mkdtempSync(join(tmpdir(), 'superwagie-task6-render-b-')), frameCount: 3,
  });
  assert.deepEqual(second.result.hashes, first.result.hashes);
});

test('a crashed render job resumes from its authenticated checkpoint', { timeout: 90_000 }, async () => {
  const outcome = await renderFrames({
    fixture: 'G4-VIDEO-002', repositoryRoot, candidateRoot,
    workRoot: mkdtempSync(join(tmpdir(), 'superwagie-task6-crash-')), frameCount: 5,
    crashAfterFrames: 2, crashMode: 'exit86',
  });
  assert.equal(outcome.cleanExit, true);
  assert.equal(outcome.recoveredFromCrash, true);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.result.hashes.length, 5);
  assert.equal(outcome.result.checkpointRootVerified, true);
  assert.equal(outcome.result.framesRenderedThisAttempt, 3);
});
