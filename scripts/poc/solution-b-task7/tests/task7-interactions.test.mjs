import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makePng, variedPng } from './helpers.mjs';
import {
  buildContextDigest, classifyArtifact, comparePageImages, searchTextLayer,
} from '../src/task7-lib.mjs';

test('search finds hits across pages with bboxes', () => {
  const pages = [
    { page: 1, items: [{ text: 'SuperWagie Review', bbox: [0.1, 0.1, 0.2, 0.05] }] },
    { page: 3, items: [{ text: 'reviewer torture', bbox: [0.5, 0.2, 0.3, 0.05] }] },
  ];
  const result = searchTextLayer(pages, 'review');
  assert.equal(result.total_hits, 2);
  assert.equal(result.hits[0].page, 1);
  assert.equal(result.hits[1].page, 3);
  assert.equal(searchTextLayer(pages, 'missing-term').total_hits, 0);
});

test('context digest binds page text content', () => {
  const items = [{ text: 'Alpha', bbox: [0, 0, 0.1, 0.1] }, { text: 'Beta', bbox: [0, 0.1, 0.1, 0.1] }];
  const digest = buildContextDigest(items);
  assert.equal(digest, 'sha256:' + createHash('sha256').update('Alpha Beta').digest('hex'));
});

test('truncated pdf and unknown binaries are rejected before rendering', () => {
  const truncated = Buffer.concat([Buffer.from('%PDF-1.7 stub'), Buffer.alloc(64, 1)]);
  assert.equal(classifyArtifact({ name: 'corrupt-tail.pdf', bytes: truncated }).code, 'ARTIFACT_PDF_TRUNCATED');
  const placeholder = Buffer.alloc(1024, 7);
  const unsupported = classifyArtifact({ name: 'oversize-placeholder.bin', bytes: placeholder });
  assert.equal(unsupported.kind, 'unsupported');
  assert.equal(unsupported.code, 'ARTIFACT_TYPE_UNSUPPORTED');
  const oversize = classifyArtifact({ name: 'huge.pdf', bytes: Buffer.alloc(16), maxBytes: 8 });
  assert.equal(oversize.code, 'ARTIFACT_OVERSIZE');
});

test('valid documents classify into renderable kinds', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7 ok'), Buffer.alloc(32, 3), Buffer.from('%%EOF')]);
  assert.equal(classifyArtifact({ name: 'a.pdf', bytes: pdf }).kind, 'pdf');
  const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
  assert.equal(classifyArtifact({ name: 'a.docx', bytes: docx }).kind, 'docx');
});

test('page image compare detects identity and divergence', () => {
  const a = variedPng(8, 8);
  const same = comparePageImages({ baseline: a, candidate: Buffer.from(a) });
  assert.equal(same.identical, true);
  assert.equal(same.visual_diff_ratio, 0);
  const differentImage = makePng(8, 8, (x, y) => [255 - x * 20, 255 - y * 20, 9, 255]);
  const different = comparePageImages({ baseline: a, candidate: differentImage });
  assert.equal(different.identical, false);
  assert.ok(different.visual_diff_ratio > 0);
  const geometryMismatch = comparePageImages({ baseline: a, candidate: variedPng(6, 6) });
  assert.equal(geometryMismatch.geometry_match, false);
  assert.equal(geometryMismatch.visual_diff_ratio, 1);
});
