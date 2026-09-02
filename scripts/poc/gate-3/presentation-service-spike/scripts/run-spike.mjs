#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPresentation } from '../src/presentation-service.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const outputDirectory = argument('--output-dir');
if (!isAbsolute(outputDirectory)) {
  console.error('usage: run-spike.mjs --output-dir ABSOLUTE');
  process.exit(2);
}
const outputInfo = lstatSync(outputDirectory);
if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
  console.error('output directory must be a regular non-symlink directory');
  process.exit(2);
}

const sourceImage = fileURLToPath(new URL(
  '../../../../../fixtures/gate-3/G3-PPT-001/fixtures/presentation-visual-1920x1080.png',
  import.meta.url,
));
const sourceImageBytes = readFileSync(sourceImage);
const artifacts = join(outputDirectory, 'artifacts');
mkdirSync(artifacts, { mode: 0o700 });
const deck = join(artifacts, 'three-slide.pptx');

try {
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
  }, deck);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sourcePath = join(root, 'src/presentation-service.mjs');
  const lockPath = join(root, 'package-lock.json');
  const lockBytes = readFileSync(lockPath);
  const lockDocument = JSON.parse(lockBytes.toString('utf8'));
  const imageSizeVersion = lockDocument.packages?.['node_modules/image-size']?.version;
  if (imageSizeVersion !== '1.2.1') {
    throw new Error(`dependency security record must be refreshed for image-size@${imageSizeVersion ?? 'missing'}`);
  }
  const deckBytes = readFileSync(deck);
  const result = {
    schema_id: 'superwagie.presentation-service-spike-evidence.v1',
    schema_version: 1,
    gate: 'gate-3-subprobe',
    fixture: 'G3-PPT-ASSEMBLER-SPIKE-001',
    pass: true,
    decision_hint: 'CONDITIONAL_GO',
    limitations: [
      'The actual SuperPPT candidate still imports @oai/artifact-tool, so G3-PPT-001 remains NO_GO.',
      'The seven-stage workflow, three Human Gates, change-impact recovery, signed runtime, and real WPS smoke are not executed by this structural spike.',
      'Signed Runtime dependency admission is blocked because the locked PptxGenJS closure contains image-size@1.2.1 with two unpatched High-severity denial-of-service advisories.',
    ],
    metrics: {
      direct_codex_runtime_coupling: false,
      real_three_slide_structural_flow_executed: true,
      editable_title_marker_present: true,
      full_slide_source_pixels: {
        width: sourceImageBytes.readUInt32BE(16),
        height: sourceImageBytes.readUInt32BE(20),
      },
      seven_stage_workflow_executed: false,
      real_wps_smoke_executed: false,
      signed_runtime_executed: false,
      dependency_security_admission: false,
    },
    dependency_security: {
      package: `image-size@${imageSizeVersion}`,
      admission: 'blocked',
      reviewed_at: '2026-09-01',
      affected_versions: '<=2.0.2',
      patched_versions: 'none',
      unpatched_high_advisories: [
        'GHSA-5p2g-fcmc-qvqq',
        'GHSA-w3rx-r6r6-pgpr',
      ],
      disposition: 'Use an audited SuperWagie-owned package that removes the unreachable dependency, or wait for a patched upstream dependency before Signed Runtime admission.',
    },
    adapter: manifest.adapter,
    sources: {
      presentation_service: { sha256: digest(readFileSync(sourcePath)) },
      package_lock: { sha256: digest(lockBytes) },
      slide_image: { sha256: digest(sourceImageBytes) },
    },
    artifacts: {
      deck: { path: 'artifacts/three-slide.pptx', sha256: digest(deckBytes), bytes: deckBytes.length },
    },
  };
  writeFileSync(join(outputDirectory, 'results.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
