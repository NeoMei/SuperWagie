import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildCandidate } from '../build-candidate.mjs';
import { runOfficeClosureSmoke } from '../office-closure-smoke.mjs';

const HERE = path.resolve(import.meta.dirname, '..');

test('builds executable DOCX and PPTX mounts that display deterministic non-placeholder content', async (t) => {
  const testRoot = mkdtempSync(path.join(HERE, '.office-closure-test-'));
  const outputRoot = path.join(testRoot, 'dist');
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  const result = await buildCandidate({
    candidateRoot: path.join(HERE, '.candidate', 'source'),
    outputRoot,
    allowedOutputRoot: outputRoot,
    writeBaseline: false,
  });
  const smoke = await runOfficeClosureSmoke({
    bundlePath: path.join(outputRoot, 'viewer-office', 'viewer-office.mjs'),
  });

  assert.equal(result.decision, 'NO_GO');
  assert.ok(result.module_graph.forbidden_runtime_edges > 0);
  assert.deepEqual(result.manifests.map((item) => item.chunk_id), ['viewer-base', 'viewer-office']);
  assert.equal(smoke.docx.status, 'ready');
  assert.match(smoke.docx.rendered_text, /Universal Viewer DOCX Smoke/);
  assert.equal(smoke.pptx.parse_status, 'ok');
  assert.equal(smoke.pptx.mount_mode, 'slides');
  assert.match(smoke.pptx.rendered_text, /Universal Viewer PPTX Smoke/);
  assert.equal(smoke.pptx.render_slide_text, 'Universal Viewer PPTX Smoke');
  assert.equal(smoke.placeholder_content, false);

  const officeEnvelope = JSON.parse(readFileSync(path.join(outputRoot, 'viewer-office', 'chunk-manifest.poc.json'), 'utf8'));
  const officeManifest = officeEnvelope.manifest_candidate;
  const inventoryRef = officeManifest.license_refs.find((item) => item.endsWith('-runtime-license-inventory.json'));
  const inventory = JSON.parse(readFileSync(path.join(outputRoot, 'viewer-office', inventoryRef), 'utf8'));
  assert.equal(inventory.packages.length, 17);
  assert.deepEqual(
    inventory.packages.map((item) => item.identity).sort(),
    [...officeManifest.direct_dependencies, ...officeManifest.transitive_dependencies].sort(),
  );
  for (const runtime of inventory.packages) {
    const expectedRef = `licenses/${runtime.identity.replace(/^npm:/, 'npm-').replaceAll(':', '-')}.txt`;
    assert.ok(officeManifest.license_refs.includes(expectedRef), runtime.identity);
    assert.ok(readFileSync(path.join(outputRoot, 'viewer-office', expectedRef)).length > 0, runtime.identity);
  }
});
