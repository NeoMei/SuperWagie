import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stagedResourceInventory } from './verify-intel-local.mjs';

test('staged resources omit only the empty source placeholder excluded by the packager', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-stage-inventory-'));
  try {
    fs.writeFileSync(path.join(root, '.gitkeep'), '');
    fs.writeFileSync(path.join(root, 'rg'), 'binary fixture', { mode: 0o755 });
    fs.writeFileSync(path.join(root, '.unexpected'), 'must remain visible to the comparison');
    const entries = stagedResourceInventory(root);
    assert.deepEqual(entries.map(entry => entry.path).sort(), ['.unexpected', 'rg']);
    assert.equal(entries.find(entry => entry.path === 'rg').mode, 0o755);
    assert.equal(entries.find(entry => entry.path === 'rg').size, 14);
    fs.writeFileSync(path.join(root, '.gitkeep'), 'nonempty');
    assert.throws(() => stagedResourceInventory(root), /placeholder must be empty/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
