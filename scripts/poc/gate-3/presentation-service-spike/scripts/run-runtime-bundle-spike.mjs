#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const outputDirectory = argument('--output-dir');
if (!isAbsolute(outputDirectory)) {
  console.error('usage: run-runtime-bundle-spike.mjs --output-dir ABSOLUTE');
  process.exit(2);
}
const outputMetadata = lstatSync(outputDirectory);
if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
  console.error('output directory must be a regular non-symlink directory');
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(outputDirectory, 'artifacts');
const runtimeArtifacts = join(artifacts, 'runtime');
mkdirSync(artifacts, { mode: 0o700 });
mkdirSync(runtimeArtifacts, { mode: 0o700 });

const builder = join(root, 'scripts', 'build-runtime-bundle.mjs');
const built = spawnSync(process.execPath, [builder, '--output-dir', runtimeArtifacts], {
  encoding: 'utf8',
});
if (built.status !== 0) {
  console.error(built.stderr || built.stdout || 'runtime bundle build failed');
  process.exit(1);
}

const bundle = join(runtimeArtifacts, 'presentation-runtime.mjs');
const sbomPath = join(runtimeArtifacts, 'runtime-sbom.json');
const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
if (sbom.blocked_dependency_absent !== 'image-size'
    || sbom.components.some(({ name }) => name === 'image-size')) {
  console.error('blocked dependency remains reachable in runtime bundle');
  process.exit(1);
}

const sourceImage = fileURLToPath(new URL(
  '../../../../../fixtures/gate-3/G3-PPT-001/fixtures/presentation-visual-1920x1080.png',
  import.meta.url,
));
const sourceImageBytes = readFileSync(sourceImage);
const cleanRoot = mkdtempSync(join(tmpdir(), 'superwagie-presentation-runtime-spike-'));
try {
  const cleanBundle = join(cleanRoot, 'presentation-runtime.mjs');
  const cleanImage = join(cleanRoot, 'fixture.png');
  const cleanSpec = join(cleanRoot, 'spec.json');
  const cleanDeck = join(cleanRoot, 'three-slide.pptx');
  const cleanCache = join(cleanRoot, 'cache');
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
  }), { mode: 0o600 });
  if (existsSync(join(cleanRoot, 'node_modules'))) throw new Error('clean runtime unexpectedly contains node_modules');

  const executed = spawnSync(process.execPath, [
    cleanBundle, '--spec-file', cleanSpec, '--output', cleanDeck,
  ], {
    cwd: cleanRoot,
    encoding: 'utf8',
    env: {
      HOME: cleanRoot,
      XDG_CACHE_HOME: cleanCache,
      PATH: '/usr/bin:/bin',
    },
  });
  if (executed.status !== 0) throw new Error(executed.stderr || executed.stdout || 'clean runtime execution failed');
  if (existsSync(join(cleanRoot, 'node_modules'))) throw new Error('runtime created node_modules dynamically');

  const deck = join(artifacts, 'three-slide-bundled.pptx');
  copyFileSync(cleanDeck, deck);
  const bundleBytes = readFileSync(bundle);
  const deckBytes = readFileSync(deck);
  const result = {
    schema_id: 'superwagie.presentation-runtime-bundle-spike-evidence.v1',
    schema_version: 1,
    gate: 'gate-3-subprobe',
    fixture: 'G3-PPT-RUNTIME-BUNDLE-SPIKE-001',
    pass: true,
    decision_hint: 'CONDITIONAL_GO',
    limitations: [
      'The bundle is not a signed SuperWagie Runtime Image and was executed with a development-host Node binary.',
      'The actual SuperPPT candidate is not adapted to consume this bundle.',
      'The seven-stage workflow, Human Gates, cross-platform execution, and real WPS/PowerPoint smoke remain unexecuted.',
      'Reachability exclusion does not replace release-time SBOM, vulnerability review, code signing, notarization, and clean-machine verification.',
    ],
    metrics: {
      executed_without_node_modules: true,
      dynamic_installation_observed: false,
      blocked_dependency_reachable: false,
      full_slide_source_pixels: {
        width: sourceImageBytes.readUInt32BE(16),
        height: sourceImageBytes.readUInt32BE(20),
      },
      reachable_notice_generated: true,
      signed_runtime_executed: false,
      real_wps_smoke_executed: false,
      windows_executed: false,
    },
    runtime_execution: {
      node_version: process.version,
      provenance: 'development-host-node-not-signed-product-runtime',
      sanitized_home: true,
      sanitized_xdg_cache: true,
      sanitized_path: true,
    },
    reachable_sbom: sbom,
    sources: Object.fromEntries([
      ['presentation_service', join(root, 'src', 'presentation-service.mjs')],
      ['runtime_entry', join(root, 'src', 'runtime-entry.mjs')],
      ['bundle_builder', builder],
      ['package_lock', join(root, 'package-lock.json')],
    ].map(([name, path]) => [name, { sha256: digest(readFileSync(path)) }])),
    artifacts: {
      runtime_bundle: {
        path: 'artifacts/runtime/presentation-runtime.mjs',
        sha256: digest(bundleBytes),
        bytes: bundleBytes.length,
      },
      runtime_sbom: {
        path: 'artifacts/runtime/runtime-sbom.json',
        sha256: digest(readFileSync(sbomPath)),
      },
      third_party_notices: {
        path: 'artifacts/runtime/THIRD_PARTY_NOTICES.txt',
        sha256: digest(readFileSync(join(runtimeArtifacts, 'THIRD_PARTY_NOTICES.txt'))),
      },
      deck: {
        path: 'artifacts/three-slide-bundled.pptx',
        sha256: digest(deckBytes),
        bytes: deckBytes.length,
      },
    },
  };
  result.sources.slide_image = { sha256: digest(sourceImageBytes) };
  writeFileSync(join(outputDirectory, 'results.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  rmSync(cleanRoot, { recursive: true, force: true });
}
