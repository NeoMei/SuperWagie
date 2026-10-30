import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const folder = 'packages/web/server/lib/hy-memory/vendor';

test('every pinned Hy source is present in Git with its exact manifest bytes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, folder, 'source-manifest.json'), 'utf8'));
  const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--', folder], { cwd: root, encoding: 'utf8' }).split('\0'));
  assert.equal(manifest.source_sha, '988667cd876fb80bee6d618482f78a2fe426402c');
  assert.equal(manifest.files.length, 120);
  for (const entry of manifest.files) {
    const name = `${folder}/hy_memory/${entry.path}`;
    assert.ok(tracked.has(name), `Missing pinned Git source: ${entry.path}`);
    const bytes = fs.readFileSync(path.join(root, name));
    assert.equal(bytes.length, entry.bytes, `Pinned source size: ${entry.path}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Pinned source digest: ${entry.path}`);
  }
});
