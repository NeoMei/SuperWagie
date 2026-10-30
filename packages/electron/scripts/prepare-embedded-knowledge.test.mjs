import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { memoryIndexOverlayDigest } from './embedded-knowledge-memory/apply.mjs';

test('staged backend cache requires current memory routes and the recorded executable bytes', async (t) => {
  const { canReuseStagedKnowledge, canReuseStagedKnowledgeBinary } = await import('./prepare-embedded-knowledge.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hy backend cache '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'config'));
  fs.mkdirSync(path.join(directory, 'migrations/sqlite'), { recursive: true });
  const binaryName = 'fixture-backend';
  const binary = path.join(directory, binaryName);
  fs.writeFileSync(binary, 'the compiled memory route');
  const manifest = { repository: 'fixture', ref: 'fixture', commit: 'abcdef123', tags: 'sqlite_fts5',
    binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    memoryIndexOverlay: { version: 1, sha256: memoryIndexOverlayDigest() } };
  const options = { manifest, directory, binaryName, repository: 'fixture', ref: 'fixture', pinnedCommit: 'abcdef', tags: 'sqlite_fts5', platform: 'darwin' };
  assert.equal(canReuseStagedKnowledgeBinary(options), true);
  assert.equal(canReuseStagedKnowledge(options), false, 'Legacy binary needs its portable dictionary resources');
  const overlay = manifest.memoryIndexOverlay;
  delete manifest.memoryIndexOverlay;
  assert.equal(canReuseStagedKnowledgeBinary(options), false);
  manifest.memoryIndexOverlay = { version: 1, sha256: '0'.repeat(64) };
  assert.equal(canReuseStagedKnowledgeBinary(options), false);
  manifest.memoryIndexOverlay = overlay;
  fs.writeFileSync(binary, 'older backend without the memory route');
  assert.equal(canReuseStagedKnowledgeBinary(options), false);
});
