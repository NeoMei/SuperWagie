import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

function fixture(t, installExit = 0) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'superweb stage & spaces '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'packages/electron/scripts/prepare-superweb-resource.mjs');
  const source = path.join(root, 'packages/web/server/builtin-skills/skills/superweb');
  const destination = path.join(root, 'packages/electron/resources/superweb');
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(source, { recursive: true });
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(repository, 'packages/electron/scripts/prepare-superweb-resource.mjs'), script);
  cpSync(path.join(repository, 'scripts/lib'), path.join(root, 'scripts/lib'), { recursive: true });
  const helper = 'packages/web/server/lib/builtin-skills/managed-tree.js';
  mkdirSync(path.dirname(path.join(root, helper)), { recursive: true });
  cpSync(path.join(repository, helper), path.join(root, helper));
  symlinkSync(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(path.join(source, 'README.md'), 'fixture skill');
  writeFileSync(path.join(destination, 'previous.txt'), 'previous valid resource');
  const cli = path.join(root, 'npm tools/node_modules/npm/bin/npm-cli.js');
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    assert.deepEqual(process.argv.slice(2), ['ci', '--omit=dev', '--ignore-scripts']);
    if (${installExit}) process.exit(${installExit});
    fs.mkdirSync('node_modules/fixture', { recursive: true });
    fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = 42;');
  `);
  const env = { ...process.env, npm_execpath: cli };
  return { script, source, destination, env };
}

test('Windows staging launches npm CLI with Node and stages the installed resources', {
  skip: process.platform !== 'win32',
}, (t) => {
  const { script, destination, env } = fixture(t);
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(destination, 'README.md'), 'utf8'), 'fixture skill');
  assert.equal(readFileSync(path.join(destination, 'vendor/node_modules/fixture/index.js'), 'utf8'), 'module.exports = 42;');
  assert.equal(existsSync(path.join(destination, 'previous.txt')), false);
});

test('a failed npm install leaves the previously staged resources intact', {
  skip: process.platform !== 'win32',
}, (t) => {
  const { script, destination, env } = fixture(t, 23);
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm ci failed.*23/);
  assert.equal(readFileSync(path.join(destination, 'previous.txt'), 'utf8'), 'previous valid resource');
});

test('existing dependencies are staged without invoking npm', (t) => {
  const { script, source, destination, env } = fixture(t, 23);
  mkdirSync(path.join(source, 'node_modules/fixture'), { recursive: true });
  writeFileSync(path.join(source, 'node_modules/fixture/index.js'), 'already installed');
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(destination, 'vendor/node_modules/fixture/index.js'), 'utf8'), 'already installed');
  const first = JSON.parse(readFileSync(path.join(destination, '.superwagie-bundle.json'), 'utf8'));
  writeFileSync(path.join(source, 'node_modules/fixture/index.js'), 'changed dependency');
  const rerun = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.notEqual(JSON.parse(readFileSync(path.join(destination, '.superwagie-bundle.json'), 'utf8')).id, first.id);
});
