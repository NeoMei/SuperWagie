import assert from 'node:assert/strict';
import { test } from 'node:test';

import { missingReleaseTags } from './release-site-check.mjs';

test('a site borrowing an unpublished download version is rejected', () => {
  const missing = missingReleaseTags({
    htmlFiles: ['index.html'],
    readFile: () => '<a href="https://github.com/NeoMei/SuperWagie/releases/download/v2.7.94/x.exe">download</a>',
    tagExists: (tag) => tag === 'v2.7.93',
  });
  assert.deepEqual(missing, ['index.html: v2.7.94']);
});

test('a site referencing only published tags passes', () => {
  assert.deepEqual(missingReleaseTags({
    htmlFiles: ['index.html'],
    readFile: () => '<a href="https://github.com/NeoMei/SuperWagie/releases/download/v2.7.93/x.exe">download</a>',
    tagExists: (tag) => tag === 'v2.7.93',
  }), []);
});
