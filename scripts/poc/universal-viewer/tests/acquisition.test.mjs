import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

function appendTarEntry(archivePath, { name, type, linkName = '' }) {
  const archive = readFileSync(archivePath);
  let offset = 0;
  while (offset + 512 <= archive.length && !archive.subarray(offset, offset + 512).every((byte) => byte === 0)) {
    const sizeText = archive.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write('00000000000\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  writeFileSync(archivePath, Buffer.concat([archive.subarray(0, offset), header, Buffer.alloc(1024)]));
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
    writeFileSync(
      path.join(upstream, '.gitmodules'),
      '[submodule "vendor/nested-core"]\n\tpath = vendor/nested-core\n\turl = https://example.invalid/nested.git\n',
    );
    git(upstream, 'add', '.gitmodules');
    git(upstream, 'commit', '--quiet', '-m', 'add gitlink');
  }

  const commit = git(upstream, 'rev-parse', 'HEAD');
  const archive = path.join(root, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '--output', archive, commit], { cwd: upstream });
  const lock = {
    schema_id: 'superwagie.viewer-source-lock.v1',
    upstream: `file://${upstream}`,
    version: '0.0.0-test',
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

test('extracts authenticated offline bytes when the archive path is replaced after validation', {
  skip: process.platform === 'win32',
}, () => {
  const fixture = createFixtureRepository();
  const authoritativeTree = git(fixture.upstream, 'rev-parse', `${fixture.commit}^{tree}`);
  const replacementArchive = path.join(fixture.root, 'replacement.tar');
  writeFileSync(path.join(fixture.upstream, 'README.md'), 'swapped after validation\n');
  git(fixture.upstream, 'add', 'README.md');
  git(fixture.upstream, 'commit', '--quiet', '-m', 'replacement');
  execFileSync('git', ['archive', '--format=tar', '--output', replacementArchive, 'HEAD'], {
    cwd: fixture.upstream,
  });

  const shimRoot = path.join(fixture.root, 'shim');
  mkdirSync(shimRoot);
  const tarShim = path.join(shimRoot, 'tar');
  writeFileSync(tarShim, [
    '#!/bin/sh',
    'cp "$SUPERWAGIE_TEST_REPLACEMENT_ARCHIVE" "$SUPERWAGIE_TEST_OFFLINE_ARCHIVE"',
    'exec "$SUPERWAGIE_TEST_REAL_TAR" "$@"',
    '',
  ].join('\n'), { mode: 0o755 });

  const originalEnvironment = {
    PATH: process.env.PATH,
    replacement: process.env.SUPERWAGIE_TEST_REPLACEMENT_ARCHIVE,
    target: process.env.SUPERWAGIE_TEST_OFFLINE_ARCHIVE,
    realTar: process.env.SUPERWAGIE_TEST_REAL_TAR,
  };
  try {
    process.env.PATH = `${shimRoot}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.SUPERWAGIE_TEST_REPLACEMENT_ARCHIVE = replacementArchive;
    process.env.SUPERWAGIE_TEST_OFFLINE_ARCHIVE = fixture.archive;
    process.env.SUPERWAGIE_TEST_REAL_TAR = '/usr/bin/tar';

    const receipt = acquireFrozenCore({
      cacheRoot: fixture.cacheRoot,
      offlineArchive: fixture.archive,
      sourceLock: fixture.lock,
    });

    assert.equal(receipt.tree, authoritativeTree);
    assert.equal(readFileSync(path.join(fixture.cacheRoot, 'source', 'README.md'), 'utf8'), 'frozen core fixture\n');
  } finally {
    for (const [name, value] of [
      ['PATH', originalEnvironment.PATH],
      ['SUPERWAGIE_TEST_REPLACEMENT_ARCHIVE', originalEnvironment.replacement],
      ['SUPERWAGIE_TEST_OFFLINE_ARCHIVE', originalEnvironment.target],
      ['SUPERWAGIE_TEST_REAL_TAR', originalEnvironment.realTar],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('rejects an offline symlink from tar headers before extraction', () => {
  const fixture = createFixtureRepository({ symlink: true });

  assert.throws(
    () => acquireFrozenCore({
      cacheRoot: fixture.cacheRoot,
      offlineArchive: fixture.archive,
      sourceLock: fixture.lock,
    }),
    /archive header.*symbolic link.*before extraction/i,
  );
  assert.equal(existsSync(path.join(fixture.cacheRoot, 'source')), false);
});

test('rejects offline hardlinks and special entries from tar headers before extraction', () => {
  for (const entryKind of ['hardlink', 'fifo']) {
    const fixture = createFixtureRepository();
    if (entryKind === 'hardlink') {
      appendTarEntry(fixture.archive, { name: 'linked', type: '1', linkName: 'README.md' });
    } else {
      appendTarEntry(fixture.archive, { name: 'named-pipe', type: '6' });
    }
    fixture.lock.source_tree_sha256 = sha256File(fixture.archive);

    assert.throws(
      () => acquireFrozenCore({
        cacheRoot: fixture.cacheRoot,
        offlineArchive: fixture.archive,
        sourceLock: fixture.lock,
      }),
      /archive header.*(?:hard link|special).*before extraction/i,
    );
    assert.equal(existsSync(path.join(fixture.cacheRoot, 'source')), false);
  }
});

test('rejects an offline Git submodule marker before extraction', () => {
  const fixture = createFixtureRepository({ submodule: true });

  assert.throws(
    () => acquireFrozenCore({
      cacheRoot: fixture.cacheRoot,
      offlineArchive: fixture.archive,
      sourceLock: fixture.lock,
    }),
    /archive header.*submodule marker.*before extraction/i,
  );
  assert.equal(existsSync(path.join(fixture.cacheRoot, 'source')), false);
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
  const changedLock = { ...fixture.lock, version: '0.0.1' };

  assert.throws(
    () => acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: changedLock }),
    /source lock changed/i,
  );
});
