import assert from 'node:assert/strict';
import test from 'node:test';
import { variedPng } from './helpers.mjs';
import { ReviewPageCache } from '../src/task7-lib.mjs';

test('cached pages verify on read', () => {
  const cache = new ReviewPageCache();
  const pageA = variedPng(4, 4);
  const pageB = variedPng(5, 5);
  cache.put('doc/pdf:page-1', { bytes: pageA });
  cache.put('doc/pdf:page-2', { bytes: pageB });
  assert.equal(cache.get('doc/pdf:page-1').ok, true);
  assert.equal(cache.get('doc/pdf:page-2').ok, true);
});

test('a corrupt entry is rejected while its clean neighbor survives', () => {
  const cache = new ReviewPageCache();
  const pageA = variedPng(4, 4);
  const pageB = variedPng(6, 6);
  cache.put('doc/pdf:page-1', { bytes: pageA });
  cache.put('doc/pdf:page-2', { bytes: pageB });
  cache.corruptForTest('doc/pdf:page-1');
  const rejected = cache.get('doc/pdf:page-1');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'CACHE_ENTRY_CORRUPT');
  assert.equal(cache.get('doc/pdf:page-2').ok, true);
  assert.equal(cache.stats().corrupt_rejected, 1);
});

test('a corrupted page can be repaired exactly once by re-render', () => {
  const cache = new ReviewPageCache();
  cache.put('doc/pdf:page-1', { bytes: variedPng(4, 4) });
  cache.corruptForTest('doc/pdf:page-1');
  assert.equal(cache.get('doc/pdf:page-1').ok, false);
  const rerendered = variedPng(4, 4);
  cache.putAfterRerender('doc/pdf:page-1', { bytes: rerendered });
  assert.equal(cache.get('doc/pdf:page-1').ok, true);
  assert.equal(cache.stats().rerendered, 1);
});

test('replacing cached bytes with a different valid page is rejected', () => {
  const cache = new ReviewPageCache();
  cache.put('doc/pdf:page-1', { bytes: variedPng(4, 4) });
  const attack = variedPng(7, 7);
  cache.replaceBytesForTest('doc/pdf:page-1', attack);
  const result = cache.get('doc/pdf:page-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CACHE_ENTRY_CORRUPT');
});
