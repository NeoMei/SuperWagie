import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publisher = path.join(root, 'site/deploy/product-help.sh');
const authorSource = path.join(root, 'packages/web/server/lib/product-help/content.json');

const setup = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sw-help-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const remote = path.join(directory, "remote ' website");
  const helpDirectory = path.join(remote, 'product-help');
  const contentDirectory = path.join(helpDirectory, 'v1');
  const v2Directory = path.join(helpDirectory, 'v2');
  const log = path.join(directory, 'transport.json');
  await mkdir(bin);
  for (const directory of [contentDirectory, v2Directory]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'catalog.json'), 'previous help');
    await writeFile(path.join(directory, 'catalog.previous.json'), 'older help');
  }
  await writeFile(path.join(remote, 'index.html'), 'unrelated website');
  // Replace only SSH transport; run the actual remote shell and filesystem writes locally.
  const transport = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.TRANSPORT_LOG, JSON.stringify(args));
let input = fs.readFileSync(0);
if (process.env.TRUNCATE_UPLOAD === '1' || process.env.TRUNCATE_VERSION) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-help-transport-'));
  try {
    const unpacked = spawnSync('tar', ['-xf', '-', '-C', stage], { input });
    if (unpacked.status !== 0) process.exit(1);
    const version = process.env.TRUNCATE_VERSION || 'v1';
    const file = path.join(stage, version, 'catalog.json');
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, bytes.subarray(0, bytes.length - 1));
    const packed = spawnSync('tar', ['-cf', '-', '-C', stage, 'v1/catalog.json', 'v2/catalog.json']);
    if (packed.status !== 0) process.exit(1);
    input = packed.stdout;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
const result = spawnSync('/bin/sh', ['-c', args.at(-1)], { input, env: process.env });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`;
  await writeFile(path.join(bin, 'ssh'), transport);
  await chmod(path.join(bin, 'ssh'), 0o755);
  await writeFile(path.join(bin, 'mv'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.FAIL_SECOND_REPLACE === '1' && args.at(-1).endsWith('/v2/catalog.json')) process.exit(42);
if (process.env.FAIL_PREVIOUS_SAVE === '1' && args.at(-1).endsWith('/v2/catalog.previous.json')) process.exit(42);
const result = spawnSync('/bin/mv', args, { stdio: 'inherit' });
if (result.status === 0 && process.env.SIGNAL_AFTER_CURRENT === '1' && args.at(-1).endsWith('/v2/catalog.json')) process.kill(process.ppid, 'SIGTERM');
process.exit(result.status ?? 1);
`);
  await chmod(path.join(bin, 'mv'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    DEPLOY_HOST: 'fixture.invalid', DEPLOY_USER: 'publisher', DEPLOY_PORT: '2222', DEPLOY_DIR: remote,
    TRANSPORT_LOG: log,
  };
  return { bin, remote, helpDirectory, contentDirectory, v2Directory, log, env };
};

test('help publisher replaces only its catalog, retaining the previous version and readable permissions', async (t) => {
  const state = await setup(t);
  const result = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const source = JSON.parse(await readFile(authorSource, 'utf8'));
  for (const [directory, version] of [[state.contentDirectory, 1], [state.v2Directory, 2]]) {
    const published = JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8'));
    assert.equal(published.schemaVersion, version);
    assert.deepEqual(published.articles, version === 1 ? source.articles.map(({ target: _target, ...article }) => article) : source.articles);
    assert.equal(await readFile(path.join(directory, 'catalog.previous.json'), 'utf8'), 'previous help');
    assert.deepEqual((await readdir(directory)).sort(), ['catalog.json', 'catalog.previous.json']);
    assert.equal((await stat(path.join(directory, 'catalog.json'))).mode & 0o777, 0o644);
  }
  assert.equal(await readFile(path.join(state.remote, 'index.html'), 'utf8'), 'unrelated website');
  assert.deepEqual((await readdir(state.helpDirectory)).sort(), ['v1', 'v2']);
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
  assert.equal(await readFile(path.join(state.v2Directory, 'catalog.json'), 'utf8'), 'previous help');
  assert.deepEqual((await readdir(state.helpDirectory)).sort(), ['v1', 'v2']);
});

test('repeating the same publication preserves the previous distinct version', async (t) => {
  const state = await setup(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.previous.json'), 'utf8'), 'previous help');
    assert.equal(await readFile(path.join(state.v2Directory, 'catalog.previous.json'), 'utf8'), 'previous help');
  }
});

test('help publisher refuses concurrent publication without deleting another publisher lock', async (t) => {
  const state = await setup(t);
  await mkdir(path.join(state.helpDirectory, '.publish-lock'));
  const result = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another product help publication holds the lock/);
  assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.json'), 'utf8'), 'previous help');
  assert.equal((await stat(path.join(state.helpDirectory, '.publish-lock'))).isDirectory(), true);
});

test('a corrupt second-format upload is refused before either channel changes', async (t) => {
  const state = await setup(t);
  const failed = spawnSync('bash', [publisher], { env: { ...state.env, TRUNCATE_VERSION: 'v2' }, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /v2 upload checksum mismatch/);
  assert.match(failed.stderr, /completed: none/);
  for (const directory of [state.contentDirectory, state.v2Directory]) {
    assert.equal(await readFile(path.join(directory, 'catalog.json'), 'utf8'), 'previous help');
    assert.equal(await readFile(path.join(directory, 'catalog.previous.json'), 'utf8'), 'older help');
  }
});

test('a second-format replacement failure reports the first publication and a same-source retry preserves last-good backups', async (t) => {
  const state = await setup(t);
  const failed = spawnSync('bash', [publisher], { env: { ...state.env, FAIL_SECOND_REPLACE: '1' }, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /completed: v1/);
  assert.match(failed.stderr, /same author snapshot/i);
  const v1Bytes = await readFile(path.join(state.contentDirectory, 'catalog.json'));
  assert.equal(JSON.parse(v1Bytes).schemaVersion, 1);
  assert.equal(await readFile(path.join(state.contentDirectory, 'catalog.previous.json'), 'utf8'), 'previous help');
  assert.equal(await readFile(path.join(state.v2Directory, 'catalog.json'), 'utf8'), 'previous help');
  assert.equal(await readFile(path.join(state.v2Directory, 'catalog.previous.json'), 'utf8'), 'older help');
  assert.deepEqual((await readdir(state.helpDirectory)).sort(), ['v1', 'v2']);
  const retry = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(await readFile(path.join(state.contentDirectory, 'catalog.json')), v1Bytes);
  for (const directory of [state.contentDirectory, state.v2Directory]) {
    assert.equal(await readFile(path.join(directory, 'catalog.previous.json'), 'utf8'), 'previous help');
  }
});

test('help publisher never starts transport when local validation fails', async (t) => {
  const state = await setup(t);
  const invalidSource = path.join(state.remote, 'invalid-author.json');
  const builderUrl = pathToFileURL(path.join(root, 'scripts/product-help-content.mjs')).href;
  // Exercise the real validator with invalid input, leaving the shared author source untouched.
  await writeFile(path.join(state.bin, 'node'), `#!${process.execPath}
(async () => {
  const { buildProductHelpContent } = await import(${JSON.stringify(builderUrl)});
  await buildProductHelpContent({ sourcePath: ${JSON.stringify(invalidSource)}, outputDir: process.argv.at(-1) });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`);
  await chmod(path.join(state.bin, 'node'), 0o755);
  const source = JSON.parse(await readFile(authorSource, 'utf8'));
  for (const content of [{ ...source, schemaVersion: 99 },
    { ...source, articles: [{ ...source.articles[0], target: 'execute-shell' }] }]) {
    await writeFile(invalidSource, JSON.stringify(content));
    const result = spawnSync('bash', [publisher], { env: state.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(state.log), { code: 'ENOENT' });
    for (const directory of [state.contentDirectory, state.v2Directory]) {
      assert.equal(await readFile(path.join(directory, 'catalog.json'), 'utf8'), 'previous help');
      assert.equal(await readFile(path.join(directory, 'catalog.previous.json'), 'utf8'), 'older help');
    }
  }
});

test('a failed previous-file replacement retains the old current bytes for recovery', async (t) => {
  const state = await setup(t);
  const result = spawnSync('bash', [publisher], { env: { ...state.env, FAIL_PREVIOUS_SAVE: '1' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous catalog retained for recovery/);
  assert.match(result.stderr, /completed: v1 v2/);
  assert.equal(JSON.parse(await readFile(path.join(state.v2Directory, 'catalog.json'), 'utf8')).schemaVersion, 2);
  const entries = await readdir(state.helpDirectory);
  const staging = entries.find(name => name.startsWith('.publication.'));
  assert.ok(staging);
  assert.equal(await readFile(path.join(state.helpDirectory, staging, 'v2/catalog.previous.json'), 'utf8'), 'previous help');
  assert.equal(await readFile(path.join(state.v2Directory, 'catalog.previous.json'), 'utf8'), 'older help');
  assert.equal(entries.includes('.publish-lock'), false);
});

test('termination after current replacement retains the previous bytes until their public rename completes', async (t) => {
  const state = await setup(t);
  const result = spawnSync('bash', [publisher], { env: { ...state.env, SIGNAL_AFTER_CURRENT: '1' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(await readFile(path.join(state.v2Directory, 'catalog.json'), 'utf8')).schemaVersion, 2);
  const entries = await readdir(state.helpDirectory);
  const staging = entries.find(name => name.startsWith('.publication.'));
  assert.ok(staging, result.stderr);
  assert.equal(await readFile(path.join(state.helpDirectory, staging, 'v2/catalog.previous.json'), 'utf8'), 'previous help');
  assert.equal(await readFile(path.join(state.v2Directory, 'catalog.previous.json'), 'utf8'), 'older help');
  assert.match(result.stderr, /previous catalog retained for recovery/);
  assert.equal(entries.includes('.publish-lock'), false);
});
