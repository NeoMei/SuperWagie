import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('Task 7 CLI derives the repository root from its own location, not the caller cwd', async () => {
  const source = await readFile(join(import.meta.dirname, '../src/build-evidence.mjs'), 'utf8');
  const cli = source.slice(source.indexOf("if (process.argv[1]"));
  assert.match(cli, /import\.meta\.dirname, '\.\.\/\.\.\/\.\.\/\.\.'/);
  assert.doesNotMatch(cli, /process\.cwd\(\)/);
});
