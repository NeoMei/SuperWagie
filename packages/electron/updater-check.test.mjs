import assert from 'node:assert/strict';
import test from 'node:test';

import { checkForDesktopUpdate, fetchDesktopUpdateNotes } from './updater-check.mjs';

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
    /E_UPDATE:checkFailed:feed unavailable/,
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
    pendingUpdate: null,
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

test('desktop notes fallback reads the offered SuperWagie version and preserves both locales', async () => {
  const notes = '<!-- release-notes:zh-CN -->中文更新。<!-- /release-notes -->\n<!-- release-notes:en -->English notes.<!-- /release-notes -->';
  const requestedUrls = [];
  const result = await fetchDesktopUpdateNotes({
    version: '2.7.22',
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return { ok: true, json: async () => ({ version: '2.7.22', notes }) };
    },
  });
  assert.equal(result, notes);
  assert.deepEqual(requestedUrls, [
    'https://github.com/NeoMei/SuperWagie-Open/releases/download/v2.7.22/latest.json',
  ]);
});

test('desktop notes fallback rejects another version, empty notes, and malformed feeds', async () => {
  for (const feed of [
    { version: '2.7.23', notes: 'Wrong version.' },
    { version: '2.7.22', notes: '  ' },
    { version: '2.7.22', notes: ['Wrong shape.'] },
    { notes: 'Version is missing.' },
    null,
  ]) {
    assert.equal(await fetchDesktopUpdateNotes({
      version: '2.7.22',
      fetchImpl: async () => ({ ok: true, json: async () => feed }),
    }), null);
  }
});

test('unavailable desktop notes stay absent without blocking the updater', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 404 }),
    async () => { throw new Error('offline'); },
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
  ]) {
    assert.equal(await fetchDesktopUpdateNotes({ version: '2.7.22', fetchImpl }), null);
  }
});

test('desktop notes do not request a malformed version', async () => {
  let requests = 0;
  assert.equal(await fetchDesktopUpdateNotes({
    version: '../latest',
    fetchImpl: async () => { requests += 1; throw new Error('unexpected request'); },
  }), null);
  assert.equal(requests, 0);
});

import { checkForMacUpdate } from './updater-check.mjs';

const macFeed = (overrides = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    version: '2.8.0',
    notes: '## What changed\n- Faster indexing.',
    publishedAt: '2026-10-24T10:00:00Z',
    mac: {
      url: 'https://example.com/SuperWagie-2.8.0.dmg',
      zip: { url: 'https://example.com/SuperWagie-2.8.0.zip', sha256: 'b'.repeat(64), size: 1234 },
    },
    ...overrides,
  }),
});

test('macOS check returns a manual install for a newer version', async () => {
  const result = await checkForMacUpdate({
    architecture: 'arm64',
    currentVersion: '2.7.2',
    compareVersions,
    fetchImpl: async () => macFeed(),
  });
  assert.equal(result.available, true);
  assert.equal(result.version, '2.8.0');
  assert.equal(result.installBlocked, undefined);
  assert.equal(result.downloadUrl, 'https://example.com/SuperWagie-2.8.0.dmg');
  assert.equal(result.zipUrl, 'https://example.com/SuperWagie-2.8.0.zip');
  assert.equal(result.zipSha256, 'b'.repeat(64));
  assert.equal(result.zipSize, 1234);
  assert.equal(result.body?.includes('Faster indexing'), true);
  assert.equal(result.releaseUrl.endsWith('/tag/v2.8.0'), true);
});

test('macOS check reports no update for the same version', async () => {
  const result = await checkForMacUpdate({
    architecture: 'arm64',
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
    architecture: 'arm64',
    currentVersion: '2.7.2',
    compareVersions,
    fetchImpl: async () => ({ status: 404, ok: false, json: async () => null }),
  });
  assert.equal(result.available, false);
});

test('macOS check rejects a malformed feed', async () => {
  await assert.rejects(
    checkForMacUpdate({
      architecture: 'arm64',
      currentVersion: '2.7.2',
      compareVersions,
      fetchImpl: async () => macFeed({ version: 'not-a-version', mac: null }),
    }),
    /E_UPDATE:feedInvalid/,
  );
});

test('a macOS feed without a ZIP falls back to the manual DMG install', async () => {
  const result = await checkForMacUpdate({
    architecture: 'arm64',
    currentVersion: '2.7.2',
    compareVersions,
    fetchImpl: async () => macFeed({ mac: { url: 'https://example.com/SuperWagie-2.8.0.dmg' } }),
  });
  assert.equal(result.available, true);
  assert.equal(result.installBlocked, 'manual-install');
  assert.equal(result.zipUrl, null);
});

test('Intel macOS stays on manual releases without requesting the ARM64 update feed', async () => {
  let requests = 0;
  const result = await checkForMacUpdate({
    architecture: 'x64',
    currentVersion: '2.7.39-intel',
    compareVersions,
    fetchImpl: async () => {
      requests += 1;
      return macFeed();
    },
  });

  assert.deepEqual(result, {
    available: false,
    currentVersion: '2.7.39-intel',
    version: null,
    body: null,
    date: null,
    releaseUrl: null,
    downloadUrl: null,
  });
  assert.equal(requests, 0);
});

for (const message of ['ENOTFOUND', 'HttpError: 404 Not Found']) {
  test(`preserves downloaded update on feed failure: ${message}`, async () => {
    const pendingUpdate = { version: '2.0.0', downloaded: true, downloadedFile: '/cache/A' };
    await assert.rejects(checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error(message); } },
      currentVersion: '1.0.0', pendingUpdate, compareVersions,
    }), /E_UPDATE:checkFailed/);
    assert.equal(pendingUpdate.downloadedFile, '/cache/A');
  });
}

test('same-version checks preserve payload readiness', async () => {
  const pendingUpdate = { version: '2.0.0', downloaded: true, downloadedFile: '/cache/A' };
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '2.0.0' } }) },
    currentVersion: '1.0.0', pendingUpdate, compareVersions,
  });
  assert.equal(result.pendingUpdate.downloaded, true);
  assert.equal(result.pendingUpdate.downloadedFile, '/cache/A');
});

import { downloadPendingDesktopUpdate, markDesktopUpdateDownloaded, pendingMacDesktopUpdate, runDesktopUpdateDownload } from './updater-check.mjs';

test('download A cannot mark B ready and blocks another version until settlement', async () => {
  const finished = Promise.withResolvers();
  let calls = 0;
  const autoUpdater = { downloadUpdate: () => { calls += 1; return finished.promise; } };
  const state = { pendingUpdate: { version: '2.0.0', electronUpdate: {} } };
  const first = downloadPendingDesktopUpdate({ autoUpdater, state });
  const duplicate = downloadPendingDesktopUpdate({ autoUpdater, state });
  state.pendingUpdate = { version: '3.0.0', electronUpdate: {} };
  await assert.rejects(downloadPendingDesktopUpdate({ autoUpdater, state }), /already in progress/);
  markDesktopUpdateDownloaded(state.pendingUpdate, { version: '2.0.0', downloadedFile: '/cache/A' });
  finished.resolve(['/cache/A']);
  await Promise.all([first, duplicate]);
  assert.equal(calls, 1);
  assert.equal(state.pendingUpdate.downloaded, undefined);
  assert.equal(state.pendingUpdate.downloadedFile, undefined);
  assert.equal(state.updateDownloadPromise, null);
  assert.equal(state.updateDownloadVersion, null);
});

test('cached downloads become ready without events and failed downloads can retry', async () => {
  const state = { pendingUpdate: { version: '2.0.0', electronUpdate: {} } };
  await assert.rejects(downloadPendingDesktopUpdate({ state, autoUpdater: {
    downloadUpdate: () => { throw new Error('offline'); },
  } }), /offline/);
  assert.equal(state.updateDownloadPromise, null);
  await downloadPendingDesktopUpdate({ state, autoUpdater: { downloadUpdate: async () => ['/cache/A'] } });
  assert.equal(state.pendingUpdate.downloaded, true);
  assert.equal(state.pendingUpdate.downloadedFile, '/cache/A');
});

test('macOS keeps the staged same-version package and clears it for a new offer', async () => {
  const pending = { version: '2.0.0', downloaded: true, macStagedApp: '/cache/A.app', macStagingDir: '/cache/A' };
  const same = pendingMacDesktopUpdate(pending, { available: true, version: '2.0.0', zipUrl: '/zip' });
  assert.equal(same.macStagedApp, pending.macStagedApp);
  assert.equal(same.downloaded, true);
  const newer = pendingMacDesktopUpdate(pending, { available: true, version: '3.0.0' });
  assert.equal(newer.downloaded, undefined);
  assert.equal(newer.macStagedApp, undefined);
  assert.equal(pendingMacDesktopUpdate(pending, { available: false }), null);
  await assert.rejects(checkForMacUpdate({
    architecture: 'arm64', currentVersion: '1.0.0', pendingUpdate: pending, compareVersions,
    fetchImpl: async () => ({ status: 404, ok: false }),
  }), /E_UPDATE:checkFailed:HTTP 404/);
});

test('macOS staging shares its download and cannot replace a newer offer', async () => {
  const finished = Promise.withResolvers();
  let calls = 0;
  const state = { pendingUpdate: { version: '2.0.0', zipUrl: '/zip' } };
  const download = () => { calls += 1; return finished.promise; };
  const first = runDesktopUpdateDownload({ state, download });
  const duplicate = runDesktopUpdateDownload({ state, download });
  state.pendingUpdate = { version: '3.0.0', zipUrl: '/new.zip' };
  finished.resolve({ macStagedApp: '/cache/A.app', macStagingDir: '/cache/A' });
  await Promise.all([first, duplicate]);
  assert.equal(calls, 1);
  assert.deepEqual(state.pendingUpdate, { version: '3.0.0', zipUrl: '/new.zip' });
});
