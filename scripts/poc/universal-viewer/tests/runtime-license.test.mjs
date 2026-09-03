import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as candidateBuild from '../build-candidate.mjs';

function licenseFixture(t, packageName) {
  const root = mkdtempSync(path.join(tmpdir(), 'viewer-runtime-license-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'runtime', 'node_modules', packageName);
  const chunkRoot = path.join(root, 'chunk');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(path.join(chunkRoot, 'licenses'), { recursive: true });
  return { root, packageRoot, chunkRoot };
}

test('extracts a reviewable embedded README license for a shipped runtime package', (t) => {
  assert.equal(typeof candidateBuild.materializeRuntimeLicenses, 'function');
  const { root, packageRoot, chunkRoot } = licenseFixture(t, 'isarray');
  writeFileSync(path.join(packageRoot, 'README.md'), `# isarray

Usage instructions that are not license text.

## License

(MIT)

Copyright (c) 2013 Julian Gruber

Permission is hereby granted, free of charge, to any person obtaining a copy.
`);

  const refs = candidateBuild.materializeRuntimeLicenses({
    chunkRoot,
    runtimeRoot: path.join(root, 'runtime'),
    runtimePackages: [{ lockPath: 'node_modules/isarray', name: 'isarray', version: '1.0.0' }],
  });

  assert.deepEqual(refs, ['licenses/npm-isarray-1.0.0.txt']);
  const copied = readFileSync(path.join(chunkRoot, refs[0]), 'utf8');
  assert.match(copied, /^\(MIT\)\n/);
  assert.match(copied, /Copyright \(c\) 2013 Julian Gruber/);
  assert.match(copied, /Permission is hereby granted/);
  assert.doesNotMatch(copied, /Usage instructions/);
});

test('rejects a shipped runtime package without a reviewable license artifact', (t) => {
  for (const { name, emptyLicense } of [
    { name: 'no-license', emptyLicense: false },
    { name: 'empty-license', emptyLicense: true },
  ]) {
    const { root, packageRoot, chunkRoot } = licenseFixture(t, name);
    if (emptyLicense) writeFileSync(path.join(packageRoot, 'LICENSE'), ' \n');

    assert.throws(
      () => candidateBuild.materializeRuntimeLicenses({
        chunkRoot,
        runtimeRoot: path.join(root, 'runtime'),
        runtimePackages: [{ lockPath: `node_modules/${name}`, name, version: '1.0.0' }],
      }),
      new RegExp(`${name}@1\\.0\\.0 has no reviewable license artifact`),
    );
  }
});
