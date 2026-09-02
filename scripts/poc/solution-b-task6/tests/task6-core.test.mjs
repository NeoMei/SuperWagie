import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  PROFILE_BY_FIXTURE,
  buildCompositionBundle,
  prepareRenderJob,
  sha256,
} from '../src/task6-lib.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const candidateRoot = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/candidate-root');

test('Task 6 locks all five profiles to fixed auditable visual sources', () => {
  assert.deepEqual(Object.keys(PROFILE_BY_FIXTURE), [
    'G4-VIDEO-001', 'G4-VIDEO-002', 'G4-VIDEO-003', 'G4-VIDEO-004', 'G4-VIDEO-005',
  ]);
  for (const config of Object.values(PROFILE_BY_FIXTURE)) {
    assert.ok(existsSync(join(repositoryRoot, config.sourcePath)));
    assert.equal(sha256(readFileSync(join(repositoryRoot, config.sourcePath))), config.sourceSha256);
    assert.doesNotMatch(config.title, /^$/);
    assert.ok(config.narration.length >= 20);
  }
  const ppt = PROFILE_BY_FIXTURE['G4-VIDEO-003'];
  assert.equal(ppt.visualTruth, 'real_wps_render');
  assert.ok(existsSync(join(repositoryRoot, ppt.sourceProofPath)));
  assert.equal(sha256(readFileSync(join(repositoryRoot, ppt.sourceProofPath))), ppt.sourceProofSha256);
});

test('Task 6 composition is deterministic, profile-specific, and offline', async () => {
  const first = await buildCompositionBundle({ fixture: 'G4-VIDEO-001', repositoryRoot });
  const second = await buildCompositionBundle({ fixture: 'G4-VIDEO-001', repositoryRoot });
  assert.equal(first.htmlSha256, second.htmlSha256);
  assert.equal(first.scriptSha256, second.scriptSha256);
  assert.match(first.script, /renderAbsoluteFrame/);
  assert.match(first.script, new RegExp(PROFILE_BY_FIXTURE['G4-VIDEO-001'].profile));
  assert.doesNotMatch(first.html + first.script, /https?:\/\//);
  const other = await buildCompositionBundle({ fixture: 'G4-VIDEO-002', repositoryRoot });
  assert.notEqual(first.scriptSha256, other.scriptSha256);
});

test('Task 6 prepares one signed Render Host job with exact absolute frames', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'superwagie-task6-core-'));
  const job = await prepareRenderJob({
    fixture: 'G4-VIDEO-001', repositoryRoot, candidateRoot, workRoot, frameCount: 5,
  });
  const wrapper = JSON.parse(readFileSync(join(job.jobRoot, 'execution-manifest.json'), 'utf8'));
  assert.equal(wrapper.manifest.schema_version, 'solution-b-execution-v1');
  assert.equal(wrapper.manifest.audience, 'render_worker');
  assert.deepEqual(wrapper.manifest.frames, { start: 0, end: 4, indices: [0, 1, 2, 3, 4] });
  assert.equal(wrapper.manifest.runtime.electron_version, '44.1.0');
  assert.equal(wrapper.manifest.resource_limits.max_frames, 5);
  assert.equal(wrapper.manifest.checkpoint.initial_sha256, null);
  assert.equal(job.jobKey.length, 64);
  assert.equal(job.electron, join(candidateRoot, 'Electron.app/Contents/MacOS/Electron'));
  assert.equal(job.workerScript, join(candidateRoot, 'src/render-worker-host.mjs'));
  assert.equal(createHash('sha256').update(readFileSync(join(job.jobRoot, 'execution-manifest.json'))).digest('hex').length, 64);
});

test('Task 6 rejects unknown fixtures and non-positive frame counts', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'superwagie-task6-invalid-'));
  await assert.rejects(
    () => prepareRenderJob({ fixture: 'G4-VIDEO-006', repositoryRoot, candidateRoot, workRoot, frameCount: 2 }),
    /TASK6_PROFILE_REQUIRED/,
  );
  await assert.rejects(
    () => prepareRenderJob({ fixture: 'G4-VIDEO-001', repositoryRoot, candidateRoot, workRoot, frameCount: 0 }),
    /TASK6_FRAME_COUNT_INVALID/,
  );
});
