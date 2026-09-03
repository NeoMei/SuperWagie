import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireFrozenCore, sourceLockBytes } from '../acquire-frozen-core.mjs';
import * as provenanceModule from '../provenance.mjs';

const { writeProvenance } = provenanceModule;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createFixture(t, version = '0.0.0-test') {
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
    version,
    commit,
    source_tree_sha256: archiveHash,
    allowed_ref_kind: 'commit-only',
  };
  const cacheRoot = path.join(root, 'candidate-cache');
  const candidateRoot = path.join(cacheRoot, 'source');
  const outputPath = path.join(root, 'audit', 'source-provenance.json');
  return { root, commit, tree, archiveHash, sourceLock, cacheRoot, candidateRoot, outputPath };
}

test('writes verified provenance without leaking any absolute path', (t) => {
  const fixture = createFixture(t);
  acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.sourceLock });

  const provenance = writeProvenance({
    candidateRoot: fixture.candidateRoot,
    outputPath: fixture.outputPath,
    sourceLock: fixture.sourceLock,
  });
  const serialized = readFileSync(fixture.outputPath, 'utf8');

  assert.equal(provenance.commit, fixture.commit);
  assert.equal(provenance.tree, fixture.tree);
  assert.equal(provenance.archive_sha256, fixture.archiveHash);
  assert.match(provenance.source_lock_sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.patch_ledger_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(provenance.patch_ledger, { schema_id: 'superwagie.viewer-patch-ledger.v1', patches: [] });
  assert.equal(provenance.toolchain.node, process.version);
  assert.match(provenance.toolchain.npm, /^\d+\.\d+\.\d+$/);
  assert.equal(
    provenance.toolchain.npm_sbom_command,
    'npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx',
  );
  assert.ok(!serialized.includes(fixture.root), 'provenance must not contain its temporary absolute root');
  assert.ok(!serialized.includes(fixture.candidateRoot), 'provenance must not contain the candidate absolute path');
  assert.ok(!serialized.includes(fixture.outputPath), 'provenance must not contain the output absolute path');
});

test('rejects a supplied source lock that differs from authoritative lock bytes', (t) => {
  const fixture = createFixture(t);
  const lockBytes = sourceLockBytes(fixture.sourceLock);
  acquireFrozenCore({ cacheRoot: fixture.cacheRoot, sourceLock: fixture.sourceLock, lockBytes });

  assert.throws(
    () => writeProvenance({
      candidateRoot: fixture.candidateRoot,
      outputPath: fixture.outputPath,
      sourceLock: { ...fixture.sourceLock, version: '9.9.9' },
      lockBytes,
    }),
    /source lock object.*authoritative lock bytes/i,
  );
});

test('rejects POSIX, Windows drive, and UNC absolute paths in source lock version', (t) => {
  for (const version of ['/tmp/path', 'C:\\viewer\\path', '\\\\server\\share']) {
    const fixture = createFixture(t, version);

    assert.throws(
      () => acquireFrozenCore({
        cacheRoot: fixture.cacheRoot,
        sourceLock: fixture.sourceLock,
        lockBytes: sourceLockBytes(fixture.sourceLock),
      }),
      /version.*semantic version|absolute path/i,
    );
  }
});

test('recursively rejects cross-platform absolute paths anywhere in provenance', () => {
  for (const absolutePath of ['/tmp/path', 'C:\\viewer\\path', '\\\\server\\share']) {
    assert.throws(
      () => provenanceModule.assertNoAbsolutePaths({ nested: [{ value: absolutePath }] }),
      /absolute path/i,
    );
  }
});

test('uses the admitted built-in npm SBOM with an install-script-free lock', () => {
  const pocRoot = path.resolve(import.meta.dirname, '..');
  const packageLock = JSON.parse(readFileSync(path.join(pocRoot, 'package-lock.json'), 'utf8'));
  const installScriptPackages = Object.entries(packageLock.packages)
    .filter(([, metadata]) => metadata.hasInstallScript)
    .map(([name]) => name);
  assert.deepEqual(installScriptPackages, []);

  const sbom = JSON.parse(execFileSync(
    'npm',
    ['sbom', '--package-lock-only', '--omit=dev', '--omit=optional', '--sbom-format', 'cyclonedx'],
    { cwd: pocRoot, encoding: 'utf8' },
  ));
  assert.equal(sbom.bomFormat, 'CycloneDX');
});

test('accepts a deterministic npm audit fixture with zero moderate-or-higher findings', () => {
  const audit = {
    auditReportVersion: 2,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };

  assert.deepEqual(provenanceModule.assertNpmAuditPolicy(audit), {
    moderate: 0,
    high: 0,
    critical: 0,
    moderate_or_higher: 0,
  });
});

test('rejects deterministic npm audit fixtures with moderate-or-higher findings', () => {
  for (const severity of ['moderate', 'high', 'critical']) {
    const vulnerabilities = { moderate: 0, high: 0, critical: 0 };
    vulnerabilities[severity] = 1;

    assert.throws(
      () => provenanceModule.assertNpmAuditPolicy({ metadata: { vulnerabilities } }),
      /moderate-or-higher.*1/i,
    );
  }
});

test('rejects malformed or missing npm audit vulnerability metadata', () => {
  for (const audit of [
    {},
    { metadata: {} },
    { metadata: { vulnerabilities: { moderate: 0, high: 0 } } },
    { metadata: { vulnerabilities: { moderate: '0', high: 0, critical: 0 } } },
    { metadata: { vulnerabilities: { moderate: -1, high: 0, critical: 0 } } },
  ]) {
    assert.throws(
      () => provenanceModule.assertNpmAuditPolicy(audit),
      /audit.*metadata|vulnerability count/i,
    );
  }
});
