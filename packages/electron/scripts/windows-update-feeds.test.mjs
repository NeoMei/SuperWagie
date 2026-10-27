import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { readLegacyWindowsManifest, stageWindowsUpdateFeeds } from './windows-update-feeds.mjs';

const installerName = 'SuperWagie-9.9.9-win-x64.exe';
const installerBytes = Buffer.from('NSIS installer fixture\0actual bytes');
const installerHash = createHash('sha512').update(installerBytes).digest('base64');

test('Windows packaging generates its dedicated feed without an electron-builder manifest', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sw-windows-update-feeds-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, installerName), installerBytes);
  await stageWindowsUpdateFeeds(directory, '9.9.9');
  const future = parse(await readFile(path.join(directory, 'latest-x64.yml'), 'utf8'));
  assert.equal(future.version, '9.9.9');
  assert.deepEqual(future.files, [{ url: installerName, sha512: installerHash, size: installerBytes.length }]);
  assert.equal(future.path, installerName);
  assert.equal(future.sha512, installerHash);
  assert.ok(Number.isFinite(Date.parse(future.releaseDate)));
  assert.equal(await readFile(path.join(directory, 'latest.yml'), 'utf8'), await readLegacyWindowsManifest());
});

test('Windows packaging publishes the new x64 offer only in its dedicated feed', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sw-windows-update-feeds-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, installerName), installerBytes);
  await writeFile(path.join(directory, 'latest.yml'), `version: 9.9.9
files:
  - url: SuperWagie-9.9.9-win-x64.exe
    sha512: fixture-checksum
    size: 123
releaseNotes: |
  <!-- release-notes:en -->Existing details.<!-- /release-notes -->
`);
  await stageWindowsUpdateFeeds(directory, '9.9.9');
  const future = parse(await readFile(path.join(directory, 'latest-x64.yml'), 'utf8'));
  const legacy = parse(await readFile(path.join(directory, 'latest.yml'), 'utf8'));
  assert.equal(future.version, '9.9.9');
  assert.deepEqual(future.files, [{ url: installerName, sha512: installerHash, size: installerBytes.length }]);
  assert.ok(future.releaseNotes.includes('Existing details.'));
  assert.ok(future.releaseNotes.includes('manually install'));
  assert.ok(future.releaseNotes.includes('手动安装'));
  assert.equal(legacy.version, '2.6.1');
  assert.equal(legacy.files[0].url, 'https://github.com/NeoMei/SuperWagie-Open/releases/download/v2.6.1/SuperWagie-2.6.1-win-x64.exe');
});

for (const [label, installers] of [
  ['missing installer', []],
  ['unexpected version', ['SuperWagie-9.9.8-win-x64.exe']],
  ['ambiguous versions', [installerName, 'SuperWagie-9.9.8-win-x64.exe']],
  ['extra ARM64 installer', [installerName, 'SuperWagie-9.9.9-win-arm64.exe']],
]) {
  test(`Windows packaging refuses ${label} before changing either feed`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sw-windows-update-feeds-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    for (const name of installers) await writeFile(path.join(directory, name), installerBytes);
    const original = 'version: 9.9.9\nreleaseNotes: Existing details.\n';
    await writeFile(path.join(directory, 'latest.yml'), original);
    await assert.rejects(stageWindowsUpdateFeeds(directory, '9.9.9'), /exactly one Windows x64 installer/);
    assert.equal(await readFile(path.join(directory, 'latest.yml'), 'utf8'), original);
    await assert.rejects(readFile(path.join(directory, 'latest-x64.yml')), { code: 'ENOENT' });
  });
}

test('Windows packaging uses the current Electron package version by default', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sw-windows-update-feeds-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(path.join(directory, `SuperWagie-${version}-win-x64.exe`), installerBytes);
  await stageWindowsUpdateFeeds(directory);
  assert.equal(parse(await readFile(path.join(directory, 'latest-x64.yml'), 'utf8')).version, version);
});
