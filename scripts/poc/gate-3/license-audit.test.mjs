import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditDirectLicenses, cargoMetadataProjection, scanForbiddenCoupling } from './license-audit.mjs';

test('allows the exact reviewed direct-license policy from metadata and license files', async () => {
  const root = await fakeModules({
    'docx-preview': ['Apache-2.0'],
    'pdfjs-dist': ['Apache-2.0'],
    '@tauri-apps/api': ['MIT', 'Apache-2.0']
  });
  const result = await auditDirectLicenses(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.packages.map(({ name, licenses }) => ({ name, licenses })), [
    { name: '@tauri-apps/api', licenses: ['Apache-2.0', 'MIT'] },
    { name: 'docx-preview', licenses: ['Apache-2.0'] },
    { name: 'pdfjs-dist', licenses: ['Apache-2.0'] }
  ]);
});

test('fails closed on disallowed, absent, ambiguous, or missing license files', async () => {
  for (const licenses of [['GPL-3.0'], [], ['Apache-2.0', 'UNKNOWN']]) {
    const root = await fakeModules({
      'docx-preview': licenses,
      'pdfjs-dist': ['Apache-2.0'],
      '@tauri-apps/api': ['Apache-2.0', 'MIT']
    });
    assert.equal((await auditDirectLicenses(root)).ok, false);
  }
  const missingMetadata = await fakeModules({
    'docx-preview': ['Apache-2.0'], 'pdfjs-dist': ['Apache-2.0'],
    '@tauri-apps/api': ['Apache-2.0', 'MIT']
  });
  await rm(path.join(missingMetadata, 'docx-preview', 'package.json'));
  assert.equal((await auditDirectLicenses(missingMetadata)).ok, false);
});

test('forbidden coupling scan catches source and binary tokens but permits clean bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-license-scan-'));
  const clean = path.join(root, 'clean');
  await mkdir(clean);
  await writeFile(path.join(clean, 'app.js'), 'reviewasset://localhost');
  assert.equal((await scanForbiddenCoupling([clean])).ok, true);
  await writeFile(path.join(clean, 'app.js'), 'connect to Codex.app');
  assert.equal((await scanForbiddenCoupling([clean])).ok, false);
  await writeFile(path.join(clean, 'app.js'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('CODEX_HOME')]));
  assert.equal((await scanForbiddenCoupling([clean])).ok, false);

  await writeFile(path.join(clean, 'app.js'), 'reviewasset://localhost');
  await writeFile(path.join(clean, 'source.rs'), '#[cfg(test)]\nfn helper() {}\nconst PRODUCTION: &str = "CODEX_HOME";\n');
  assert.equal((await scanForbiddenCoupling([clean])).ok, false, 'production after an inline cfg(test) item must still be scanned');
  await writeFile(path.join(clean, 'app.js'), 'reviewasset://localhost');
  await writeFile(path.join(clean, 'source.rs'), 'const PRODUCTION: &str = "reviewasset";\n#[cfg(test)]\nmod tests { const PROBE: &str = "CODEX_HOME"; }\n');
  assert.equal((await scanForbiddenCoupling([clean])).ok, true, 'only the explicit Rust test module may be excluded');
});

test('locked Cargo projection is deterministic and contains no workspace paths', () => {
  const raw = {
    packages: [{ id: 'path+file:///Users/private/reviewer#superwagie@0.1.0', name: 'superwagie', version: '0.1.0', source: null, checksum: null, license: 'MIT' },
      { id: 'registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0', name: 'serde', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index', checksum: 'a'.repeat(64), license: 'MIT OR Apache-2.0' }],
    resolve: { root: 'path+file:///Users/private/reviewer#superwagie@0.1.0', nodes: [
      { id: 'path+file:///Users/private/reviewer#superwagie@0.1.0', deps: [{ pkg: 'registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0', name: 'serde', dep_kinds: [{ kind: null, target: null }] }], features: [] },
      { id: 'registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0', deps: [], features: ['derive'] }
    ] },
    workspace_members: ['path+file:///Users/private/reviewer#superwagie@0.1.0'],
    workspace_root: '/Users/private/reviewer', target_directory: '/Users/private/reviewer/target'
  };
  const first = cargoMetadataProjection(raw);
  const reordered = cargoMetadataProjection({ ...raw, packages: [...raw.packages].reverse(), resolve: { ...raw.resolve, nodes: [...raw.resolve.nodes].reverse() } });
  assert.deepEqual(first, reordered);
  assert.doesNotMatch(JSON.stringify(first), /\/Users\/|file:\/\/|workspace_root|target_directory|manifest_path/);
  assert.equal(first.schema_id, 'superwagie.cargo-locked-projection.v1');
  assert.equal(first.resolve.nodes[0].dependencies[0].package, 'serde@1.0.0#registry');
});

async function fakeModules(policy) {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-licenses-'));
  for (const [name, licenses] of Object.entries(policy)) {
    const packageRoot = path.join(root, ...name.split('/'));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: licenses.join(' OR ') }));
    for (const license of licenses.filter((value) => value !== 'UNKNOWN')) {
      await writeFile(path.join(packageRoot, `LICENSE_${license}`), `${license}\n`);
    }
  }
  return root;
}
