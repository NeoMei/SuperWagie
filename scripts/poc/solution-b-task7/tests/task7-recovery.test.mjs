import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reanchorAnnotations, ReviewStateStore } from '../src/task7-lib.mjs';

const ANNOTATION = {
  annotationId: 'annotation-0f0e0d0c-1111-4222-8333-444455556666',
  pageId: 'page-2',
  contextDigest: 'sha256:' + 'a'.repeat(64),
  bbox: [0.1, 0.2, 0.3, 0.4],
  status: 'active',
};

function stateStore() {
  const directory = mkdtempSync(join(tmpdir(), 'superwagie-task7-state-'));
  return new ReviewStateStore({ journalPath: join(directory, 'review-state.json'), key: 'f'.repeat(64) });
}

test('revision and annotations survive a simulated crash', () => {
  const store = stateStore();
  const journalPath = store.journalPath;
  store.checkpoint({
    revision: 7,
    preview_revision_id: 'preview-sha256:' + '1'.repeat(64),
    accepted_revision: 7,
    annotations: [ANNOTATION],
    effects: { accepted: 1, published: 1 },
  });
  const recovered = new ReviewStateStore({ journalPath, key: 'f'.repeat(64) });
  const loaded = recovered.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.revision, 7);
  assert.deepEqual(loaded.state.annotations, [ANNOTATION]);
  assert.equal(loaded.state.effects.accepted, 1);
});

test('a tampered checkpoint fails closed instead of returning empty state', () => {
  const store = stateStore();
  store.checkpoint({ revision: 3, annotations: [ANNOTATION], effects: { accepted: 1 } });
  const raw = JSON.parse(readFileSync(store.journalPath, 'utf8'));
  raw.state.revision = 99;
  writeFileSync(store.journalPath, JSON.stringify(raw, null, 2) + '\n');
  const tampered = new ReviewStateStore({ journalPath: store.journalPath, key: 'f'.repeat(64) });
  const loaded = tampered.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'CHECKPOINT_ROOT_MISMATCH');
});

test('recovery replay must not duplicate side effects', () => {
  const store = stateStore();
  const journalPath = store.journalPath;
  store.checkpoint({
    revision: 5,
    annotations: [],
    effects: { accepted: 1, published: 1, applied: ['accept:revision-5'] },
  });
  const recovered = new ReviewStateStore({ journalPath, key: 'f'.repeat(64) });
  const loaded = recovered.load();
  assert.equal(loaded.ok, true);
  const firstReplay = recovered.recordEffect(loaded.state, 'accept:revision-5');
  const secondReplay = recovered.recordEffect(loaded.state, 'accept:revision-5');
  assert.equal(firstReplay.applied, false);
  assert.equal(secondReplay.applied, false);
  assert.equal(loaded.state.effects.accepted, 1);
});

test('a fresh accept effect is applied exactly once', () => {
  const store = stateStore();
  const state = { revision: 2, annotations: [], effects: { accepted: 0 } };
  const first = store.recordEffect(state, 'accept:revision-2');
  const replay = store.recordEffect(state, 'accept:revision-2');
  assert.equal(first.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(state.effects.accepted, 1);
});

test('annotations reanchor by context digest and never move silently', () => {
  const annotation = { ...ANNOTATION };
  const relocated = reanchorAnnotations({
    annotations: [annotation],
    old_manifest: { pages: [{ pageId: 'page-2', contextDigests: [annotation.contextDigest] }] },
    new_manifest: { pages: [{ pageId: 'page-5', contextDigests: [annotation.contextDigest] }] },
  });
  assert.equal(relocated.resolved.length, 1);
  assert.equal(relocated.resolved[0].pageId, 'page-5');
  assert.equal(relocated.silent_misplaced, 0);

  const vanished = reanchorAnnotations({
    annotations: [annotation],
    old_manifest: { pages: [{ pageId: 'page-2', contextDigests: [annotation.contextDigest] }] },
    new_manifest: { pages: [{ pageId: 'page-2', contextDigests: ['sha256:' + 'b'.repeat(64)] }] },
  });
  assert.equal(vanished.resolved.length, 0);
  assert.equal(vanished.unresolved.length, 1);
  assert.equal(vanished.unresolved[0].annotationId, annotation.annotationId);
  assert.equal(vanished.silent_misplaced, 0);
});
