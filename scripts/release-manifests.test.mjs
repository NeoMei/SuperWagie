import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

import { buildManifests } from './release-manifests.mjs';

const withDist = async (files) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sw-manifests-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
};

test('writes the dedicated x64 feed with hashes, sizes and release URLs', async () => {
  const dir = await withDist({
    'SuperWagie-9.9.9-mac-arm64.dmg': 'mac-bytes',
    'SuperWagie-9.9.9-mac-arm64.zip': 'mac-zip!',
    'SuperWagie-9.9.9-win-x64.exe': 'win-bytes',
  });
  try {
    const { 'latest-x64.yml': yml, 'latest.json': json, 'latest.yml': legacy } = await buildManifests({
      version: '9.9.9',
      distDir: dir,
      notes: '## Notes\n- one',
      publishedAt: '2026-10-24T10:00:00Z',
    });
    const feed = JSON.parse(json);
    assert.equal(feed.version, '9.9.9');
    assert.ok(feed.notes.includes('## Notes\n- one'));
    assert.ok(feed.notes.includes('manually install'));
    assert.equal(feed.mac.size, 9);
    assert.equal(feed.win.size, 9);
    assert.match(feed.mac.sha256, /^[a-f0-9]{64}$/);
    assert.match(feed.mac.url, /releases\/download\/v9\.9\.9\/SuperWagie-9\.9\.9-mac-arm64\.dmg$/);
    assert.match(feed.win.url, /releases\/download\/v9\.9\.9\/SuperWagie-9\.9\.9-win-x64\.exe$/);
    assert.match(yml, /^version: 9\.9\.9$/m);
    assert.match(yml, /url: SuperWagie-9\.9\.9-win-x64\.exe/);
    assert.match(yml, /sha512: [A-Za-z0-9+/=]+/);
    assert.match(yml, /releaseDate: '2026-10-24T10:00:00Z'/);
    assert.equal(parseYaml(yml).releaseNotes, feed.notes);
    assert.equal(parseYaml(legacy).version, '2.6.1');
    assert.equal(parseYaml(legacy).files[0].url, 'https://github.com/NeoMei/SuperWagie-Open/releases/download/v2.6.1/SuperWagie-2.6.1-win-x64.exe');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('preserves both language blocks as one releaseNotes string in the Windows feed', async () => {
  const dir = await withDist({
    'SuperWagie-9.9.9-mac-arm64.dmg': 'mac-bytes',
    'SuperWagie-9.9.9-mac-arm64.zip': 'mac-zip!',
    'SuperWagie-9.9.9-win-x64.exe': 'win-bytes',
  });
  const notes = '<!-- release-notes:zh-CN -->\r\n### 更新内容\r\n- 保留“中文”说明。\r\n<!-- /release-notes -->\r\n\r\n<!-- release-notes:en -->\r\n### What changed\r\n- Preserve "English" notes: C:\\Users\\Example.\r\n<!-- /release-notes -->\r\n';
  try {
    const manifests = await buildManifests({ version: '9.9.9', distDir: dir, notes });
    const windowsFeed = parseYaml(manifests['latest-x64.yml']);
    const macFeed = JSON.parse(manifests['latest.json']);
    assert.ok(windowsFeed.releaseNotes.includes('保留“中文”说明。'));
    assert.ok(windowsFeed.releaseNotes.includes('Preserve "English" notes: C:\\Users\\Example.'));
    assert.ok(windowsFeed.releaseNotes.includes('手动安装'));
    assert.ok(windowsFeed.releaseNotes.includes('manually install'));
    assert.equal(windowsFeed.releaseNotes, macFeed.notes);
    assert.equal(windowsFeed.files[0].url, 'SuperWagie-9.9.9-win-x64.exe');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a macOS-only release retains the retired Windows feed and no new x64 manifest', async () => {
  const dir = await withDist({
    'SuperWagie-9.9.9-mac-arm64.dmg': 'mac-bytes',
    'SuperWagie-9.9.9-mac-arm64.zip': 'mac-zip!',
  });
  try {
    const manifests = await buildManifests({ version: '9.9.9', distDir: dir });
    assert.deepEqual(Object.keys(manifests).sort(), ['latest.json', 'latest.yml']);
    assert.equal(parseYaml(manifests['latest.yml']).version, '2.6.1');
    const feed = JSON.parse(manifests['latest.json']);
    assert.equal(feed.version, '9.9.9');
    assert.equal(typeof feed.mac.url, 'string');
    assert.match(feed.mac.zip.url, /SuperWagie-9\.9\.9-mac-arm64\.zip$/);
    assert.equal(feed.mac.zip.size, 8);
    assert.equal(feed.win, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses to publish without a macOS disk image', async () => {
  const dir = await withDist({ 'SuperWagie-9.9.9-win-x64.exe': 'win-bytes' });
  try {
    await assert.rejects(buildManifests({ version: '9.9.9', distDir: dir }), /Missing release asset.*mac-arm64/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const manifestScript = fileURLToPath(new URL('./release-manifests.mjs', import.meta.url));

test('release CLI refuses missing or incomplete bilingual notes before writing feeds', async () => {
  const dir = await withDist({});
  const notesPath = path.join(dir, 'notes.md');
  const outDir = path.join(dir, 'feeds');
  const args = [manifestScript, '--version', '9.9.9', '--dist', dir, '--out', outDir];
  try {
    const missing = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--notes-file is required/);
    for (const notes of [
      'English-only legacy notes.',
      '<!-- release-notes:en -->English notes.<!-- /release-notes -->',
      '<!-- release-notes:zh-CN -->中文更新。<!-- /release-notes -->',
      '<!-- release-notes:zh-CN --> \n <!-- /release-notes -->\n<!-- release-notes:en -->English notes.<!-- /release-notes -->',
      '<!-- release-notes:zh-CN -->Unclosed block.',
    ]) {
      await writeFile(notesPath, notes);
      const result = spawnSync(process.execPath, [...args, '--notes-file', notesPath], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Release notes require a non-empty (?:zh-CN|en) block/);
    }
    await assert.rejects(readFile(path.join(outDir, 'latest.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(outDir, 'latest.yml')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(outDir, 'latest-x64.yml')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release CLI accepts complete bilingual notes and writes the same copy to both feeds', async () => {
  const notes = '<!-- release-notes:zh-CN -->中文更新。<!-- /release-notes -->\n<!-- release-notes:en -->English notes.<!-- /release-notes -->';
  const dir = await withDist({
    'SuperWagie-9.9.9-mac-arm64.dmg': 'mac-bytes',
    'SuperWagie-9.9.9-mac-arm64.zip': 'mac-zip!',
    'SuperWagie-9.9.9-win-x64.exe': 'win-bytes',
    'notes.md': notes,
  });
  try {
    const result = spawnSync(process.execPath, [
      manifestScript, '--version', '9.9.9', '--dist', dir, '--notes-file', path.join(dir, 'notes.md'),
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const generatedNotes = JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8')).notes;
    assert.ok(generatedNotes.includes('中文更新。'));
    assert.ok(generatedNotes.includes('English notes.'));
    assert.equal(parseYaml(await readFile(path.join(dir, 'latest-x64.yml'), 'utf8')).releaseNotes, generatedNotes);
    assert.equal(parseYaml(await readFile(path.join(dir, 'latest.yml'), 'utf8')).version, '2.6.1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
