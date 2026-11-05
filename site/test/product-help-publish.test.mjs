import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publisher = path.join(root, 'site/deploy/product-help.sh');
const authorSource = path.join(root, 'packages/web/server/lib/product-help/content.json');

const setup = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sw-help-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const remote = path.join(directory, "remote ' website");
  const contentDirectory = path.join(remote, 'product-help/v1');
  const log = path.join(directory, 'transport.json');
  await mkdir(bin);
  await mkdir(contentDirectory, { recursive: true });
  await writeFile(path.join(contentDirectory, 'catalog.json'), 'previous help');
  await writeFile(path.join(contentDirectory, 'catalog.previous.json'), 'older help');
  await writeFile(path.join(remote, 'index.html'), 'unrelated website');
  // Replace only SSH transport; run the actual remote shell and filesystem writes locally.
  const transport = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.TRANSPORT_LOG, JSON.stringify(args));
let input = fs.readFileSync(0);
if (process.env.TRUNCATE_UPLOAD === '1') input = input.subarray(0, input.length - 1);
const result = spawnSync('/bin/sh', ['-c', args.at(-1)], { input, env: process.env });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`;
  await writeFile(path.join(bin, 'ssh'), transport);
  await chmod(path.join(bin, 'ssh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DEPLOY_HOST: 'fixture.invalid', DEPLOY_USER: 'publisher', DEPLOY_PORT: '2222', DEPLOY_DIR: remote,
    TRANSPORT_LOG: log,
  };
  return { bin, remote, contentDirectory, log, env };
};

test('help publisher replaces only its catalog, retaining the previous version and readable permissions', async (t) => {
  const state = await setup(t);
  const result = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(path.join(state.contentDirectory, 'catalog.json')), await readFile(authorSource));
  assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.previous.json'), 'utf8'), 'previous help');
  assert.equal(await readFile(path.join(state.remote, 'index.html'), 'utf8'), 'unrelated website');
  assert.deepEqual((await readdir(state.contentDirectory)).sort(), ['catalog.json', 'catalog.previous.json']);
  assert.equal((await stat(path.join(state.contentDirectory, 'catalog.json'))).mode & 0o777, 0o644);
  const transport = JSON.parse(await readFile(state.log, 'utf8'));
  assert.deepEqual(transport.slice(0, -1), ['-p', '2222', '--', 'publisher@fixture.invalid']);
});

test('help publisher leaves current and rollback files untouched after a truncated upload', async (t) => {
  const state = await setup(t);
  const result = spawnSync('bash', [publisher], { env: { ...state.env, TRUNCATE_UPLOAD: '1' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum/i);
  assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.json'), 'utf8'), 'previous help');
  assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.previous.json'), 'utf8'), 'older help');
  assert.deepEqual((await readdir(state.contentDirectory)).sort(), ['catalog.json', 'catalog.previous.json']);
});

test('repeating the same publication preserves the previous distinct version', async (t) => {
  const state = await setup(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.previous.json'), 'utf8'), 'previous help');
  }
});

test('help publisher refuses concurrent publication without deleting another publisher lock', async (t) => {
  const state = await setup(t);
  await mkdir(path.join(state.contentDirectory, '.publish-lock'));
  const result = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another product help publication holds the lock/);
  assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.json'), 'utf8'), 'previous help');
  assert.equal((await stat(path.join(state.contentDirectory, '.publish-lock'))).isDirectory(), true);
});

test('help publisher never starts transport when local validation fails', async (t) => {
  const state = await setup(t);
  await writeFile(path.join(state.bin, 'node'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(state.bin, 'node'), 0o755);
  const result = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(state.log), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.json'), 'utf8'), 'previous help');
});
