import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

import { createPresentation } from '../src/presentation-service.mjs';

const sourceImage = fileURLToPath(new URL(
  '../../../../../fixtures/gate-3/G3-PPT-001/fixtures/presentation-visual-1920x1080.png',
  import.meta.url,
));
const lowResolutionImage = fileURLToPath(new URL(
  '../../../../../fixtures/gate-1/G1-MARKDOWN-001/fixtures/%E5%9B%BE%E7%89%87%E7%B4%A0%E6%9D%90.png',
  import.meta.url,
));

test('owned adapter builds a three-page image/editable/regenerated PPTX without Codex runtime coupling', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superwagie-presentation-service-'));
  const output = join(directory, 'three-slide.pptx');
  const manifest = await createPresentation({
    presentation_id: 'presentation-spike-001',
    slides: [
      {
        slide_id: 'slide-image-001', mode: 'image', image_path: sourceImage,
        alt_text: 'High fidelity image slide fixture',
      },
      {
        slide_id: 'slide-editable-002', mode: 'editable', background_path: sourceImage,
        elements: [{
          kind: 'text', object_id: 'title-editable-002', text: 'TITLE EDIT',
          x: 0.8, y: 0.7, w: 6.4, h: 0.8, font_size_pt: 32,
          color: '17324D', bold: true,
        }],
      },
      {
        slide_id: 'slide-regenerated-003', mode: 'image', image_path: sourceImage,
        alt_text: 'Regenerated complex visual slide fixture',
      },
    ],
  }, output);

  const bytes = readFileSync(output);
  assert.equal(manifest.output_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manifest.slide_count, 3);
  assert.deepEqual(manifest.slide_modes, ['image', 'editable', 'image']);

  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name))
    .sort();
  assert.equal(slideFiles.length, 3);
  const slides = await Promise.all(slideFiles.map((name) => zip.file(name).async('string')));
  assert.doesNotMatch(slides[0], /TITLE EDIT/);
  assert.match(slides[1], /TITLE EDIT/);
  assert.doesNotMatch(slides[2], /TITLE EDIT/);
  assert.match(slides[0], /slide-image-001/);
  assert.match(slides[1], /title-editable-002/);
  assert.match(slides[2], /slide-regenerated-003/);
  assert.ok(Object.keys(zip.files).some((name) => /^ppt\/media\/image[^/]+\./.test(name)));
});

test('spike source and lock remain independent from Codex artifact runtime', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/presentation-service.mjs', import.meta.url)), 'utf8');
  const packageDocument = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
  const lock = readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8');
  for (const text of [source, packageDocument, lock]) {
    assert.doesNotMatch(text, /@oai\/artifact-tool|codex-primary-runtime|codex-runtimes/);
  }
  assert.doesNotMatch(source, /RUNTIME_NODE|RUNTIME_NODE_MODULES|RUNTIME_BIN_DIR/);
});

test('unsafe inputs fail closed before PPTX publication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superwagie-presentation-service-'));
  await assert.rejects(
    createPresentation({ presentation_id: 'invalid', slides: [] }, join(directory, 'empty.pptx')),
    /at least one slide/,
  );
  await assert.rejects(
    createPresentation({
      presentation_id: 'invalid',
      slides: [{ slide_id: '../escape', mode: 'image', image_path: sourceImage, alt_text: 'invalid' }],
    }, join(directory, 'unsafe.pptx')),
    /slide_id/,
  );
});

test('full-slide raster rejects resolution below 1920x1080 before publication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superwagie-presentation-service-'));
  const output = join(directory, 'blurry.pptx');
  await assert.rejects(
    createPresentation({
      presentation_id: 'blurry-slide-rejected',
      slides: [{
        slide_id: 'slide-blurry-001',
        mode: 'image',
        image_path: lowResolutionImage,
        alt_text: 'must not be stretched',
      }],
    }, output),
    /full-slide image must be at least 1920x1080 with a 16:9 aspect ratio/,
  );
  assert.equal(existsSync(output), false);
});

test('full-slide raster rejects a high-resolution non-16:9 image before publication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superwagie-presentation-service-'));
  const wrongAspectImage = join(directory, 'wrong-aspect.png');
  const bytes = Buffer.from(readFileSync(sourceImage));
  bytes.writeUInt32BE(1920, 16);
  bytes.writeUInt32BE(1200, 20);
  writeFileSync(wrongAspectImage, bytes);
  await assert.rejects(
    createPresentation({
      presentation_id: 'wrong-aspect-rejected',
      slides: [{
        slide_id: 'slide-wrong-aspect-001',
        mode: 'image',
        image_path: wrongAspectImage,
        alt_text: 'must remain proportional',
      }],
    }, join(directory, 'wrong-aspect.pptx')),
    /full-slide image must be at least 1920x1080 with a 16:9 aspect ratio/,
  );
});

test('runner publishes hash-bound conditional evidence without upgrading G3-PPT-001', () => {
  const directory = mkdtempSync(join(tmpdir(), 'superwagie-presentation-evidence-'));
  const runner = fileURLToPath(new URL('../scripts/run-spike.mjs', import.meta.url));
  const completed = spawnSync(process.execPath, [runner, '--output-dir', directory], {
    encoding: 'utf8',
  });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const result = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
  const deck = readFileSync(join(directory, 'artifacts/three-slide.pptx'));
  assert.equal(result.pass, true);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.equal(result.metrics.direct_codex_runtime_coupling, false);
  assert.equal(result.metrics.real_three_slide_structural_flow_executed, true);
  assert.deepEqual(result.metrics.full_slide_source_pixels, { width: 1920, height: 1080 });
  assert.equal(result.metrics.real_wps_smoke_executed, false);
  assert.equal(result.metrics.dependency_security_admission, false);
  assert.equal(result.dependency_security.package, 'image-size@1.2.1');
  assert.deepEqual(result.dependency_security.unpatched_high_advisories, [
    'GHSA-5p2g-fcmc-qvqq',
    'GHSA-w3rx-r6r6-pgpr',
  ]);
  assert.equal(result.artifacts.deck.sha256, `sha256:${createHash('sha256').update(deck).digest('hex')}`);
  assert.ok(result.limitations.some((value) => /G3-PPT-001 remains NO_GO/.test(value)));
  assert.ok(result.limitations.some((value) => /Signed Runtime dependency admission is blocked/.test(value)));
  assert.match(result.sources.slide_image.sha256, /^sha256:[0-9a-f]{64}$/);
});

test('Signed Runtime candidate bundle runs without node_modules and excludes image-size', async () => {
  const buildDirectory = mkdtempSync(join(tmpdir(), 'superwagie-presentation-bundle-'));
  const builder = fileURLToPath(new URL('../scripts/build-runtime-bundle.mjs', import.meta.url));
  const built = spawnSync(process.execPath, [builder, '--output-dir', buildDirectory], {
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const bundle = join(buildDirectory, 'presentation-runtime.mjs');
  const bundleBytes = readFileSync(bundle);
  const metafile = JSON.parse(readFileSync(join(buildDirectory, 'runtime-metafile.json'), 'utf8'));
  const sbom = JSON.parse(readFileSync(join(buildDirectory, 'runtime-sbom.json'), 'utf8'));
  const notices = readFileSync(join(buildDirectory, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const value of [bundleBytes.toString('utf8'), JSON.stringify(metafile), notices]) {
    assert.doesNotMatch(value, /image-size|@oai\/artifact-tool|codex-primary-runtime|codex-runtimes/);
  }
  assert.doesNotMatch(JSON.stringify(sbom), /@oai\/artifact-tool|codex-primary-runtime|codex-runtimes/);
  assert.equal(sbom.blocked_dependency_absent, 'image-size');
  assert.equal(sbom.components.some(({ name }) => name === 'image-size'), false);
  assert.ok(sbom.components.some(({ name, version }) => name === 'pptxgenjs' && version === '4.0.1'));
  assert.ok(sbom.components.some(({ name, version }) => name === 'jszip' && version === '3.10.1'));

  const cleanDirectory = mkdtempSync(join(tmpdir(), 'superwagie-presentation-clean-runtime-'));
  const cleanBundle = join(cleanDirectory, 'presentation-runtime.mjs');
  const cleanImage = join(cleanDirectory, 'fixture.png');
  const cleanSpec = join(cleanDirectory, 'spec.json');
  const cleanOutput = join(cleanDirectory, 'three-slide.pptx');
  const cleanCache = join(cleanDirectory, 'cache');
  copyFileSync(bundle, cleanBundle);
  copyFileSync(sourceImage, cleanImage);
  mkdirSync(cleanCache, { mode: 0o700 });
  writeFileSync(cleanSpec, JSON.stringify({
    presentation_id: 'presentation-clean-runtime-001',
    slides: [
      { slide_id: 'slide-image-001', mode: 'image', image_path: cleanImage, alt_text: 'image' },
      {
        slide_id: 'slide-editable-002', mode: 'editable', background_path: cleanImage,
        elements: [{
          kind: 'text', object_id: 'title-editable-002', text: 'TITLE EDIT',
          x: 0.8, y: 0.7, w: 6.4, h: 0.8, font_size_pt: 32, color: '17324D', bold: true,
        }],
      },
      { slide_id: 'slide-regenerated-003', mode: 'image', image_path: cleanImage, alt_text: 'regenerated' },
    ],
  }));
  assert.equal(existsSync(join(cleanDirectory, 'node_modules')), false);
  const executed = spawnSync(process.execPath, [
    cleanBundle, '--spec-file', cleanSpec, '--output', cleanOutput,
  ], {
    cwd: cleanDirectory,
    encoding: 'utf8',
    env: {
      HOME: cleanDirectory,
      XDG_CACHE_HOME: cleanCache,
      PATH: '/usr/bin:/bin',
    },
  });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  assert.equal(existsSync(join(cleanDirectory, 'node_modules')), false);
  const outputBytes = readFileSync(cleanOutput);
  const zip = await JSZip.loadAsync(outputBytes);
  assert.equal(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name)).length, 3);
  assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /TITLE EDIT/);
});

test('runtime bundle runner publishes hash-bound clean-directory evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'superwagie-presentation-runtime-evidence-'));
  const runner = fileURLToPath(new URL('../scripts/run-runtime-bundle-spike.mjs', import.meta.url));
  const completed = spawnSync(process.execPath, [runner, '--output-dir', directory], {
    encoding: 'utf8',
  });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const result = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
  assert.equal(result.fixture, 'G3-PPT-RUNTIME-BUNDLE-SPIKE-001');
  assert.equal(result.pass, true);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.equal(result.metrics.executed_without_node_modules, true);
  assert.equal(result.metrics.blocked_dependency_reachable, false);
  assert.deepEqual(result.metrics.full_slide_source_pixels, { width: 1920, height: 1080 });
  assert.equal(result.metrics.signed_runtime_executed, false);
  assert.equal(result.metrics.real_wps_smoke_executed, false);
  assert.equal(result.reachable_sbom.blocked_dependency_absent, 'image-size');
  assert.match(result.sources.slide_image.sha256, /^sha256:[0-9a-f]{64}$/);
  const bundle = readFileSync(join(directory, result.artifacts.runtime_bundle.path));
  const deck = readFileSync(join(directory, result.artifacts.deck.path));
  assert.equal(result.artifacts.runtime_bundle.sha256, `sha256:${createHash('sha256').update(bundle).digest('hex')}`);
  assert.equal(result.artifacts.deck.sha256, `sha256:${createHash('sha256').update(deck).digest('hex')}`);
});
