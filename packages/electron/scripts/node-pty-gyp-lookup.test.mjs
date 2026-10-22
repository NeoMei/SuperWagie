import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { useDirectNodePtyTargetLookup } from './node-pty-gyp-lookup.mjs';

const require = createRequire(import.meta.url);
const rebuildRequire = createRequire(require.resolve('@electron/rebuild'));
const gypRoot = path.dirname(rebuildRequire.resolve('node-gyp/package.json'));
const original = Buffer.from(String.raw`{"dependencies":["<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"]}`);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native lookup & spaces '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binding = path.join(root, 'binding.gyp');
  await fs.writeFile(binding, original);
  const api = path.join(root, 'node_modules/node-addon-api');
  await fs.mkdir(api, { recursive: true });
  await fs.writeFile(path.join(api, 'index.js'), `exports.targets = ${JSON.stringify(path.join(api, 'node_addon_api.gyp'))};`);
  await fs.writeFile(path.join(api, 'node_addon_api.gyp'), '{"targets":[]}');
  return { root, binding, target: path.join(api, 'node_addon_api.gyp') + ':node_addon_api_except' };
}

test('gyp resolves the real Node lookup without invoking CMD and restores its input', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, binding, target } = await fixture(t);
  const restore = await useDirectNodePtyTargetLookup(binding);
  try {
    const result = spawnSync('python', ['-c',
      'import ast,gyp.input; data=ast.literal_eval(open("binding.gyp").read()); print(gyp.input.ExpandVariables(data["dependencies"][0],0,{},"binding.gyp"))',
    ], { cwd: root, encoding: 'utf8', windowsHide: true, env: {
      ...process.env, PYTHONPATH: path.join(gypRoot, 'gyp/pylib'),
      // A direct argv expansion must work even when CMD cannot start.
      ComSpec: path.join(root, 'unavailable-cmd.exe'),
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), target);
  } finally { await restore(); }
  assert.deepEqual(await fs.readFile(binding), original);
});

test('failed build cleanup restores byte-identical dependency sources', async (t) => {
  const { binding } = await fixture(t);
  const restore = await useDirectNodePtyTargetLookup(binding);
  await assert.rejects(async () => {
    try { throw new Error('native compiler failed'); } finally { await restore(); }
  }, /native compiler failed/);
  assert.deepEqual(await fs.readFile(binding), original);
});

test('unknown dependency syntax is refused without changing it', async (t) => {
  const { binding } = await fixture(t);
  await fs.writeFile(binding, 'custom binding');
  await assert.rejects(useDirectNodePtyTargetLookup(binding), /node-addon-api lookup/);
  assert.equal(await fs.readFile(binding, 'utf8'), 'custom binding');
});

test('partial setup writes are restored even before a cleanup callback exists', async (t) => {
  const { binding } = await fixture(t);
  await assert.rejects(useDirectNodePtyTargetLookup(binding, async (file, content) => {
    await fs.writeFile(file, content.slice(0, 12));
    throw new Error('interrupted setup write');
  }), /interrupted setup write/);
  assert.deepEqual(await fs.readFile(binding), original);
});
