import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireFrozenCore } from '../acquire-frozen-core.mjs';
import { writeProvenance } from '../provenance.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('writes verified provenance without leaking any absolute path', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'superwagie-viewer-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '--quiet');
  git(upstream, 'config', 'user.name', 'Viewer PoC Test');
  git(upstream, 'config', 'user.email', 'viewer-poc@example.invalid');
  writeFileSync(path.join(upstream, 'core.txt'), 'pristine candidate\n');
  git(upstream, 'add', 'core.txt');
  git(upstream, 'commit', '--quiet', '-m', 'fixture');
  const commit = git(upstream, 'rev-parse', 'HEAD');
  const tree = git(upstream, 'rev-parse', 'HEAD^{tree}');
  const archive = path.join(root, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '--output', archive, commit], { cwd: upstream });
  const archiveHash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const sourceLock = {
    schema_id: 'superwagie.viewer-source-lock.v1',
    upstream: `file://${upstream}`,
    version: 'test-fixture',
    commit,
    source_tree_sha256: archiveHash,
    allowed_ref_kind: 'commit-only',
  };
  const cacheRoot = path.join(root, 'candidate-cache');
  const candidateRoot = path.join(cacheRoot, 'source');
  const outputPath = path.join(root, 'audit', 'source-provenance.json');
  acquireFrozenCore({ cacheRoot, sourceLock });

  const provenance = writeProvenance({ candidateRoot, outputPath, sourceLock });
  const serialized = readFileSync(outputPath, 'utf8');

  assert.equal(provenance.commit, commit);
  assert.equal(provenance.tree, tree);
  assert.equal(provenance.archive_sha256, archiveHash);
  assert.match(provenance.source_lock_sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.patch_ledger_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(provenance.patch_ledger, { schema_id: 'superwagie.viewer-patch-ledger.v1', patches: [] });
  assert.equal(provenance.toolchain.node, process.version);
  assert.ok(!serialized.includes(root), 'provenance must not contain its temporary absolute root');
  assert.ok(!serialized.includes(candidateRoot), 'provenance must not contain the candidate absolute path');
  assert.ok(!serialized.includes(outputPath), 'provenance must not contain the output absolute path');
});
