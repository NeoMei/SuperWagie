import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { acquireFrozenCore } from '../acquire-frozen-core.mjs';

const cleanupRoots = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function createFixtureRepository({ symlink = false, submodule = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'superwagie-viewer-acquire-'));
  cleanupRoots.push(root);
  const upstream = path.join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '--quiet');
  git(upstream, 'config', 'user.name', 'Viewer PoC Test');
  git(upstream, 'config', 'user.email', 'viewer-poc@example.invalid');
  writeFileSync(path.join(upstream, 'README.md'), 'frozen core fixture\n');
  git(upstream, 'add', 'README.md');
  git(upstream, 'commit', '--quiet', '-m', 'fixture');

  if (symlink) {
    symlinkSync('README.md', path.join(upstream, 'linked-readme'));
    git(upstream, 'add', 'linked-readme');
    git(upstream, 'commit', '--quiet', '-m', 'add symlink');
  }

  if (submodule) {
    const target = git(upstream, 'rev-parse', 'HEAD');
    git(upstream, 'update-index', '--add', '--cacheinfo', `160000,${target},vendor/nested-core`);
    git(upstream, 'commit', '--quiet', '-m', 'add gitlink');
  }

  const commit = git(upstream, 'rev-parse', 'HEAD');
  const archive = path.join(root, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '--output', archive, commit], { cwd: upstream });
  const lock = {
    schema_id: 'superwagie.viewer-source-lock.v1',
    upstream: `file://${upstream}`,
    version: 'test-fixture',
    commit,
    source_tree_sha256: sha256File(archive),
    allowed_ref_kind: 'commit-only',
  };
  return { root, upstream, commit, archive, lock, cacheRoot: path.join(root, 'cache') };
}

test('acquires an exact commit and recomputes its deterministic archive hash', () => {
  const fixture = createFixtureRepository();

  const receipt = acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.lock });

  assert.equal(receipt.commit, fixture.commit);
  assert.equal(receipt.archive_sha256, fixture.lock.source_tree_sha256);
  assert.equal(git(path.join(fixture.cacheRoot, 'source'), 'rev-parse', 'HEAD'), fixture.commit);
  assert.equal(git(path.join(fixture.cacheRoot, 'source'), 'status', '--short'), '');
});

test('imports only an absolute offline archive with the locked hash', () => {
  const fixture = createFixtureRepository();

  const receipt = acquireFrozenCore({
    cacheRoot: fixture.cacheRoot,
    offlineArchive: fixture.archive,
    sourceLock: fixture.lock,
  });

  assert.equal(receipt.acquisition_mode, 'offline-archive');
  assert.equal(receipt.archive_sha256, fixture.lock.source_tree_sha256);
  assert.equal(readFileSync(path.join(fixture.cacheRoot, 'source', 'README.md'), 'utf8'), 'frozen core fixture\n');
});

test('rejects relative cache and offline archive paths', () => {
  const fixture = createFixtureRepository();

  assert.throws(
    () => acquireFrozenCore({ cacheRoot: 'relative-cache', sourceLock: fixture.lock }),
    /cache root.*absolute/i,
  );
  assert.throws(
    () => acquireFrozenCore({
      cacheRoot: fixture.cacheRoot,
      offlineArchive: 'relative-source.tar',
      sourceLock: fixture.lock,
    }),
    /offline archive.*absolute/i,
  );
});

test('rejects branch and tag names where an exact 40-character commit is required', () => {
  for (const sourceRef of ['main', 'v0.16.0']) {
    const fixture = createFixtureRepository();
    const lock = { ...fixture.lock, commit: sourceRef };

    assert.throws(
      () => acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: lock }),
      /commit-only.*40-character/i,
    );
  }
});

test('rejects an existing candidate whose remote URL changed', () => {
  const fixture = createFixtureRepository();
  acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.lock });
  git(path.join(fixture.cacheRoot, 'source'), 'remote', 'set-url', 'origin', 'https://example.invalid/wrong.git');

  assert.throws(
    () => acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.lock }),
    /remote URL/i,
  );
});

test('rejects a lock whose source tree archive hash is wrong', () => {
  const fixture = createFixtureRepository();
  const lock = { ...fixture.lock, source_tree_sha256: '0'.repeat(64) };

  assert.throws(
    () => acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: lock }),
    /archive SHA-256/i,
  );
});

test('rejects an existing candidate with a dirty source tree', () => {
  const fixture = createFixtureRepository();
  acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.lock });
  writeFileSync(path.join(fixture.cacheRoot, 'source', 'README.md'), 'locally changed\n');

  assert.throws(
    () => acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.lock }),
    /dirty source tree/i,
  );
});

test('rejects an upstream commit containing a symbolic link', () => {
  const fixture = createFixtureRepository({ symlink: true });

  assert.throws(
    () => acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.lock }),
    /symbolic link/i,
  );
});

test('rejects an upstream commit containing an unexpected Git submodule', () => {
  const fixture = createFixtureRepository({ submodule: true });

  assert.throws(
    () => acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.lock }),
    /submodule/i,
  );
});

test('rejects a second acquisition when the source lock changes', () => {
  const fixture = createFixtureRepository();
  acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.lock });
  const changedLock = { ...fixture.lock, version: 'changed-after-first-acquisition' };

  assert.throws(
    () => acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: changedLock }),
    /source lock changed/i,
  );
});
