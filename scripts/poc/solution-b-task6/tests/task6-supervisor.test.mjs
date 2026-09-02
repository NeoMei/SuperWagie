import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { prepareRenderJob, runPreparedRenderJob } from '../src/task6-lib.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const candidateRoot = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/candidate-root');

async function prepared(frameCount = 3) {
  return prepareRenderJob({
    fixture: 'G4-VIDEO-001', repositoryRoot, candidateRoot,
    workRoot: mkdtempSync(join(tmpdir(), 'superwagie-task6-supervisor-')), frameCount,
  });
}

test('authenticated progress receipts are required for render completion', async () => {
  const job = await prepared();
  const receipt = { checkpoint_sha256: 'a'.repeat(64), completed: { '0': 'b'.repeat(64) } };
  const result = await runPreparedRenderJob({
    ...job, spawnWorker: async () => ({ kind: 'exit', code: 0, signal: null, stdout: '', stderr: '' }),
  });
  assert.equal(result.cleanExit, false);
  assert.equal(result.authenticatedProgressReceiptVerified, false);
  assert.equal(result.error, 'AUTHENTICATED_PROGRESS_RECEIPT_REQUIRED');
});

test('tampered progress receipt cannot authorize a completed render', async () => {
  const job = await prepared();
  const { makeProgressLine } = await import('../src/task6-lib.mjs');
  const line = makeProgressLine({ jobKey: job.jobKey, manifest: job.manifest, completed: { '0': 'b'.repeat(64) }, checkpointSha256: 'a'.repeat(64) });
  line.mac = `0${line.mac.slice(1)}`;
  const result = await runPreparedRenderJob({
    ...job, spawnWorker: async () => ({ kind: 'exit', code: 0, signal: null, stdout: `${JSON.stringify(line)}\n`, stderr: '' }),
  });
  assert.equal(result.cleanExit, false);
  assert.equal(result.error, 'AUTHENTICATED_PROGRESS_RECEIPT_REQUIRED');
});

test('worker crash recovers only from the last authenticated checkpoint', async () => {
  const job = await prepared(3);
  const { makeProgressLine } = await import('../src/task6-lib.mjs');
  const checkpointHash = 'c'.repeat(64);
  const firstLine = makeProgressLine({
    jobKey: job.jobKey, manifest: job.manifest, completed: { '0': 'b'.repeat(64), '1': 'd'.repeat(64) },
    checkpointSha256: checkpointHash,
  });
  const seenAttempts = [];
  const result = await runPreparedRenderJob({
    ...job,
    maxRestarts: 1,
    spawnWorker: async ({ manifest }) => {
      seenAttempts.push(manifest.attempt);
      if (manifest.attempt === 1) {
        return { kind: 'exit', code: 86, signal: null, stdout: `${JSON.stringify(firstLine)}\n`, stderr: 'crash' };
      }
      assert.equal(manifest.attempt, 2);
      assert.equal(manifest.checkpoint.initial_sha256, checkpointHash);
      assert.equal(manifest.crash_injection_after_frames, 0);
      return { kind: 'exit', code: 0, signal: null, stdout: `${JSON.stringify(makeProgressLine({
        jobKey: job.jobKey, manifest, completed: { '0': 'b'.repeat(64), '1': 'd'.repeat(64), '2': 'e'.repeat(64) },
        checkpointSha256: 'f'.repeat(64),
      }))}\n`, stderr: '' };
    },
  });
  assert.deepEqual(seenAttempts, [1, 2]);
  assert.equal(result.cleanExit, true);
  assert.equal(result.recoveredFromCrash, true);
  assert.equal(result.authenticatedProgressReceiptVerified, true);
  assert.equal(result.trustedCheckpointSha256, 'f'.repeat(64));
});

test('pre-cancelled worker is not retried', async () => {
  const job = await prepared();
  let calls = 0;
  const result = await runPreparedRenderJob({
    ...job,
    maxRestarts: 2,
    spawnWorker: async () => {
      calls += 1;
      return { kind: 'cancelled', code: null, signal: null, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.cleanExit, false);
  assert.equal(result.cancelled, true);
});
