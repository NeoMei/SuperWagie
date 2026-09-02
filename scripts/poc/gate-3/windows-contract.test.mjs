import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Windows keeps historical native contracts but public review routing is solution B fail-closed', () => {
  const completed = spawnSync(process.execPath, [path.join(here, 'windows-contract-check.mjs')], {
    cwd: here,
    encoding: 'utf8'
  });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.match(completed.stdout, /windows-contract: .*ok/);
});
