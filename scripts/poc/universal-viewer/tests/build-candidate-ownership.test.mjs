import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as candidateBuild from '../build-candidate.mjs';

const MARKER = '.superwagie-viewer-poc-owned';
const MARKER_CONTENT = 'superwagie-viewer-poc-owned-v1\n';

function sandbox(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'superwagie-viewer-owned-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function prepare(root, protectedRoots = []) {
  return candidateBuild.prepareOwnedRoot(root, 'test output root', {
    allowedRoot: root,
    protectedRoots,
  });
}

test('owned-root cleanup requires an exact regular versioned marker', (t) => {
  assert.equal(typeof candidateBuild.prepareOwnedRoot, 'function');
  for (const markerKind of ['wrong-content', 'directory', 'symlink']) {
    const parent = sandbox(t);
    const root = path.join(parent, markerKind);
    mkdirSync(root);
    writeFileSync(path.join(root, 'must-survive.txt'), markerKind);
    const marker = path.join(root, MARKER);
    if (markerKind === 'wrong-content') writeFileSync(marker, 'not-an-ownership-capability\n');
    if (markerKind === 'directory') mkdirSync(marker);
    if (markerKind === 'symlink') {
      const target = path.join(parent, `${markerKind}-target`);
      writeFileSync(target, MARKER_CONTENT);
      symlinkSync(target, marker);
    }

    assert.throws(() => prepare(root), /marker.*regular|marker.*content|marker-owned/iu, markerKind);
    assert.equal(readFileSync(path.join(root, 'must-survive.txt'), 'utf8'), markerKind);
  }
});

test('owned-root cleanup rejects root and parent symlinks before deletion', (t) => {
  assert.equal(typeof candidateBuild.prepareOwnedRoot, 'function');
  const parent = sandbox(t);
  const realRoot = path.join(parent, 'real-root');
  mkdirSync(realRoot);
  writeFileSync(path.join(realRoot, MARKER), MARKER_CONTENT);
  writeFileSync(path.join(realRoot, 'must-survive.txt'), 'root-target');
  const rootLink = path.join(parent, 'root-link');
  symlinkSync(realRoot, rootLink, 'dir');
  assert.throws(
    () => candidateBuild.prepareOwnedRoot(rootLink, 'test output root', { allowedRoot: rootLink, protectedRoots: [] }),
    /symlink|identity|real directory/iu,
  );
  assert.equal(readFileSync(path.join(realRoot, 'must-survive.txt'), 'utf8'), 'root-target');

  const realParent = path.join(parent, 'real-parent');
  mkdirSync(realParent);
  const parentLink = path.join(parent, 'parent-link');
  symlinkSync(realParent, parentLink, 'dir');
  const nested = path.join(parentLink, 'nested-output');
  assert.throws(
    () => candidateBuild.prepareOwnedRoot(nested, 'test output root', { allowedRoot: nested, protectedRoots: [] }),
    /parent.*symlink|safe boundary/iu,
  );
  assert.equal(existsSync(path.join(realParent, 'nested-output')), false);
});

test('owned-root cleanup rejects protected roots even when explicitly allowed', (t) => {
  assert.equal(typeof candidateBuild.prepareOwnedRoot, 'function');
  const root = sandbox(t);
  writeFileSync(path.join(root, MARKER), MARKER_CONTENT);
  writeFileSync(path.join(root, 'must-survive.txt'), 'protected');

  assert.throws(
    () => candidateBuild.prepareOwnedRoot(root, 'test output root', { allowedRoot: root, protectedRoots: [root] }),
    /protected/iu,
  );
  assert.equal(readFileSync(path.join(root, 'must-survive.txt'), 'utf8'), 'protected');
});

test('owned-root cleanup only resets the exact explicitly allowed root', (t) => {
  assert.equal(typeof candidateBuild.prepareOwnedRoot, 'function');
  const parent = sandbox(t);
  const allowed = path.join(parent, 'allowed');
  const other = path.join(parent, 'other');
  for (const root of [allowed, other]) {
    mkdirSync(root);
    writeFileSync(path.join(root, MARKER), MARKER_CONTENT);
    writeFileSync(path.join(root, 'old.txt'), path.basename(root));
  }

  assert.throws(
    () => candidateBuild.prepareOwnedRoot(other, 'test output root', { allowedRoot: allowed, protectedRoots: [] }),
    /safe boundary|allowed/iu,
  );
  assert.equal(readFileSync(path.join(other, 'old.txt'), 'utf8'), 'other');
  candidateBuild.prepareOwnedRoot(allowed, 'test output root', { allowedRoot: allowed, protectedRoots: [] });
  assert.equal(existsSync(path.join(allowed, 'old.txt')), false);
  assert.equal(readFileSync(path.join(allowed, MARKER), 'utf8'), MARKER_CONTENT);
});

test('candidate subprocess runner fails closed when a live command exceeds its bound', (t) => {
  const root = sandbox(t);
  assert.equal(typeof candidateBuild.runCandidateCommand, 'function');
  const started = Date.now();
  assert.throws(
    () => candidateBuild.runCandidateCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      root,
      { timeoutMs: 75 },
    ),
    /timed out after 75 ms/iu,
  );
  assert.ok(Date.now() - started < 2_000, 'the bounded child must not keep the build hung');
});
