import assert from 'node:assert/strict';
import test from 'node:test';

import { checkForDesktopUpdate } from './updater-check.mjs';

const compareVersions = (left, right) => left.localeCompare(right, undefined, { numeric: true });

test('signals failed checks without replacing an existing pending update', async () => {
  const pendingUpdate = { version: '2.0.0', electronUpdate: { id: 'existing' } };
  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error('feed unavailable'); } },
      currentVersion: '1.0.0',
      pendingUpdate,
      compareVersions,
    }),
    /Unable to check for updates: feed unavailable.*network connection/,
  );
  assert.deepEqual(pendingUpdate, { version: '2.0.0', electronUpdate: { id: 'existing' } });
});

test('treats missing update feed (404) as no update available', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => {
        throw new Error('HttpError: 404 Not Found "https://github.com/.../latest-linux.yml"');
      },
    },
    currentVersion: '1.15.0',
    pendingUpdate: { version: '1.16.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.15.0');
});

test('authoritative no-update result clears pending update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '1.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
});

import { checkForMacUpdate } from './updater-check.mjs';

const macFeed = (overrides = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    version: '2.8.0',
    notes: '## What changed\n- Faster indexing.',
    publishedAt: '2026-10-24T10:00:00Z',
    mac: { url: 'https://example.com/SuperWagie-2.8.0.dmg' },
    ...overrides,
  }),
});

test('macOS check returns a manual install for a newer version', async () => {
  const result = await checkForMacUpdate({
    currentVersion: '2.7.2',
    compareVersions,
    fetchImpl: async () => macFeed(),
  });
  assert.equal(result.available, true);
  assert.equal(result.version, '2.8.0');
  assert.equal(result.installBlocked, 'manual-install');
  assert.equal(result.downloadUrl, 'https://example.com/SuperWagie-2.8.0.dmg');
  assert.equal(result.body?.includes('Faster indexing'), true);
  assert.equal(result.releaseUrl.endsWith('/tag/v2.8.0'), true);
});

test('macOS check reports no update for the same version', async () => {
  const result = await checkForMacUpdate({
    currentVersion: '2.8.0',
    compareVersions,
    fetchImpl: async () => macFeed(),
  });
  assert.equal(result.available, false);
  assert.equal(result.version, null);
  assert.equal(result.installBlocked, undefined);
});

test('macOS check treats a missing feed as no update', async () => {
  const result = await checkForMacUpdate({
    currentVersion: '2.7.2',
    compareVersions,
    fetchImpl: async () => ({ status: 404, ok: false, json: async () => null }),
  });
  assert.equal(result.available, false);
});

test('macOS check rejects a malformed feed', async () => {
  await assert.rejects(
    checkForMacUpdate({
      currentVersion: '2.7.2',
      compareVersions,
      fetchImpl: async () => macFeed({ version: 'not-a-version', mac: null }),
    }),
    /malformed/,
  );
});
