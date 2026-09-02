import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { blankPng, makePng, variedPng } from './helpers.mjs';
import { validatePageImage } from '../src/task7-lib.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('fake image with PNG magic but broken structure is rejected', () => {
  const fake = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('not a real png payload at all'),
  ]);
  const result = validatePageImage({ bytes: fake, declared_sha256: sha256(fake) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAGE_IMAGE_STRUCTURE_INVALID');
});

test('arbitrary bytes cannot masquerade as a page image', () => {
  const bytes = Buffer.from('definitely not image bytes, just attacker data');
  const result = validatePageImage({ bytes, declared_sha256: sha256(bytes) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAGE_IMAGE_MAGIC_INVALID');
});

test('zero-dimension image is rejected', () => {
  const zeroDimension = makePng(0, 0, () => [1, 2, 3, 255]);
  const result = validatePageImage({ bytes: zeroDimension, declared_sha256: sha256(zeroDimension) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAGE_IMAGE_DIMENSION_INVALID');
});

test('uniform blank page is rejected as non-visual truth', () => {
  const blank = blankPng();
  const result = validatePageImage({ bytes: blank, declared_sha256: sha256(blank) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAGE_IMAGE_BLANK');
});

test('declared hash must match actual bytes', () => {
  const png = variedPng();
  const result = validatePageImage({ bytes: png, declared_sha256: '0'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAGE_IMAGE_HASH_MISMATCH');
});

test('a real varied page image is accepted with decoded geometry', () => {
  const png = variedPng(6, 4);
  const result = validatePageImage({ bytes: png, declared_sha256: sha256(png) });
  assert.equal(result.ok, true);
  assert.equal(result.width, 6);
  assert.equal(result.height, 4);
  assert.equal(result.sha256, sha256(png));
});
