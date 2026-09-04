import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findCandidateRoot } from '../src/candidate-discovery.mjs';
import { runtimePlatform } from '../src/runtime-platform.mjs';

function candidate(root, name, platform = runtimePlatform().id) {
  const candidateRoot = join(root, 'evidence', 'gate-0', name, 'candidate-root');
  mkdirSync(candidateRoot, { recursive: true });
  writeFileSync(join(candidateRoot, 'runtime-manifest.json'), JSON.stringify({ platform }));
  return candidateRoot;
}

test('candidate discovery selects only a real current-platform candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-discovery-'));
  candidate(root, 'solution-b-v1-wrong', 'wrong-platform');
  const expected = candidate(root, 'solution-b-v1-current');
  assert.equal(findCandidateRoot(root), expected);
  assert.equal(findCandidateRoot(root, expected), expected);
});

test('explicit candidate discovery rejects platform drift and linked roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-discovery-'));
  const wrong = candidate(root, 'solution-b-v1-wrong', 'wrong-platform');
  assert.throws(() => findCandidateRoot(root, wrong), /CANDIDATE_PLATFORM_MISMATCH/);
  const real = candidate(root, 'solution-b-v1-real');
  const linked = join(root, 'linked-candidate');
  try { symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => findCandidateRoot(root, linked), /CANDIDATE_ROOT_UNSAFE/);
});
