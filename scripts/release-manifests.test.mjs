import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildManifests } from './release-manifests.mjs';

const withDist = async (files) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sw-manifests-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
};

test('writes both manifests with hashes, sizes and release URLs', async () => {
  const dir = await withDist({
    'SuperWagie-9.9.9-mac-arm64.dmg': 'mac-bytes',
    'SuperWagie-9.9.9-win-x64.exe': 'win-bytes',
  });
  try {
    const { 'latest.yml': yml, 'latest.json': json } = await buildManifests({
      version: '9.9.9',
      distDir: dir,
      notes: '## Notes\n- one',
      publishedAt: '2026-10-24T10:00:00Z',
    });
    const feed = JSON.parse(json);
    assert.equal(feed.version, '9.9.9');
    assert.equal(feed.notes, '## Notes\n- one');
    assert.equal(feed.mac.size, 9);
    assert.equal(feed.win.size, 9);
    assert.match(feed.mac.sha256, /^[a-f0-9]{64}$/);
    assert.match(feed.mac.url, /releases\/download\/v9\.9\.9\/SuperWagie-9\.9\.9-mac-arm64\.dmg$/);
    assert.match(feed.win.url, /releases\/download\/v9\.9\.9\/SuperWagie-9\.9\.9-win-x64\.exe$/);
    assert.match(yml, /^version: 9\.9\.9$/m);
    assert.match(yml, /url: SuperWagie-9\.9\.9-win-x64\.exe/);
    assert.match(yml, /sha512: [A-Za-z0-9+/=]+/);
    assert.match(yml, /releaseDate: '2026-10-24T10:00:00Z'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses to publish without the Windows installer', async () => {
  const dir = await withDist({ 'SuperWagie-9.9.9-mac-arm64.dmg': 'mac-bytes' });
  try {
    await assert.rejects(buildManifests({ version: '9.9.9', distDir: dir }), /Missing release asset.*win-x64/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
