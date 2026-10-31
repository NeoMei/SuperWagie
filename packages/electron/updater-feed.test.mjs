import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js';
import { AppUpdater } from 'electron-updater/out/AppUpdater.js';
import { createFixtureServer, stageUpdaterFixture } from './scripts/updater-e2e-fixture.mjs';

import {
  PRODUCTION_UPDATER_FEED,
  parseLoopbackUpdaterUrl,
  resolveUpdaterFeed,
} from './updater-feed.mjs';

const overrideEnvironment = {
  OPENCHAMBER_E2E: '1',
  OPENCHAMBER_UPDATER_E2E_URL: 'http://127.0.0.1:49152/updates/',
};

test('production updater feed is immutable GitHub configuration', () => {
  assert.equal(Object.isFrozen(PRODUCTION_UPDATER_FEED), true);
  assert.deepEqual(PRODUCTION_UPDATER_FEED, {
    provider: 'generic',
    url: 'https://github.com/NeoMei/SuperWagie/releases/latest/download/',
  });
});

test('requires the complete E2E environment and embedded build-marker conjunction', () => {
  const cases = [
    {},
    { environment: overrideEnvironment },
    { environment: { OPENCHAMBER_E2E: '1' }, testBuild: true },
    {
      environment: { OPENCHAMBER_UPDATER_E2E_URL: overrideEnvironment.OPENCHAMBER_UPDATER_E2E_URL },
      testBuild: true,
    },
    { environment: overrideEnvironment, testBuild: false },
  ];
  for (const input of cases) assert.equal(resolveUpdaterFeed({ platform: 'darwin', ...input }), PRODUCTION_UPDATER_FEED);
});

test('accepts only credential-free loopback HTTP(S) URLs', () => {
  assert.equal(parseLoopbackUpdaterUrl('http://127.0.0.1:8080/feed'), 'http://127.0.0.1:8080/feed');
  assert.equal(parseLoopbackUpdaterUrl('https://127.255.0.1/feed/'), 'https://127.255.0.1/feed/');
  assert.equal(parseLoopbackUpdaterUrl('http://[::1]:8080/feed'), 'http://[::1]:8080/feed');

  for (const value of [
    'http://localhost:8080/feed',
    'http://0.0.0.0:8080/feed',
    'http://192.168.1.5:8080/feed',
    'https://example.com/feed',
    'file:///tmp/feed',
    'ftp://127.0.0.1/feed',
    'http://user:secret@127.0.0.1/feed',
    'http://127.0.0.1/feed?token=secret',
    'http://127.0.0.1/feed#fragment',
    'not-a-url',
  ]) assert.equal(parseLoopbackUpdaterUrl(value), null, value);
});

test('uses a generic feed only when every test-only gate is valid', () => {
  assert.deepEqual(resolveUpdaterFeed({
    platform: 'darwin',
    environment: overrideEnvironment,
    testBuild: true,
  }), {
    provider: 'generic',
    url: 'http://127.0.0.1:49152/updates/',
  });
});

test('invalid URLs fall back to the production feed even with both test gates', () => {
  for (const url of ['https://example.com/feed', 'http://localhost/feed', '']) {
    assert.equal(resolveUpdaterFeed({
      platform: 'darwin',
      environment: { ...overrideEnvironment, OPENCHAMBER_UPDATER_E2E_URL: url },
      testBuild: true,
    }), PRODUCTION_UPDATER_FEED);
  }
});

test('Windows x64 selects its dedicated channel for production and gated fixtures', () => {
  assert.equal(resolveUpdaterFeed({ platform: 'win32', architecture: 'x64' }).channel, 'latest-x64');
  assert.equal(resolveUpdaterFeed({
    platform: 'win32', architecture: 'x64', environment: overrideEnvironment, testBuild: true,
  }).channel, 'latest-x64');
  for (const platform of ['darwin', 'linux']) {
    assert.equal(resolveUpdaterFeed({ platform, architecture: 'arm64' }).channel, undefined);
  }
});

test('the installed GenericProvider isolates new x64 updates from every historical ARM64 release', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-windows-feed-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'SuperWagie-9.9.9-win-x64.exe');
  fs.writeFileSync(installer, 'fixture installer bytes');
  const directory = path.join(root, 'feed');
  stageUpdaterFixture({ platform: 'win32', architecture: 'x64', nextAppImage: installer, version: '9.9.9', directory });
  fs.copyFileSync(new URL('./scripts/windows-legacy-latest.yml', import.meta.url), path.join(directory, 'latest.yml'));
  const { server, url } = await createFixtureServer({ directory });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const requested = [];
  const executor = { request: async (options) => {
    requested.push(options.path);
    const response = await fetch(`${url.slice(0, -1)}${options.path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } };
  const newProvider = new GenericProvider(resolveUpdaterFeed({
    platform: 'win32', architecture: 'x64', environment: { OPENCHAMBER_E2E: '1', OPENCHAMBER_UPDATER_E2E_URL: url }, testBuild: true,
  }), {}, { platform: 'win32', executor });
  const current = await newProvider.getLatestVersion();
  assert.equal(current.version, '9.9.9');
  assert.equal(requested.at(-1), '/latest-x64.yml');
  assert.equal(await new AppUpdater(null, { version: '2.7.24' }).isUpdateAvailable(current), true);
  for (const version of ['2.7.2', '2.7.20', '2.7.23', '2.7.24']) {
    // The old generic provider has no architecture-aware channel or guard.
    const legacyProvider = new GenericProvider({ provider: 'generic', url }, {}, { platform: 'win32', executor });
    const legacy = await legacyProvider.getLatestVersion();
    assert.equal(legacy.version, '2.6.1');
    assert.equal(legacy.files[0].size, 322308048);
    assert.equal(legacy.files[0].sha512, '3wSty+ZY6vTmPN0XA5/hVysjJPbwiRZPrxQtswlWNdBG//s0ZTyCsXmFbt+ahbSZ/u5laEpozctGiDjg+uS7pQ==');
    assert.equal(requested.at(-1), '/latest.yml');
    const updater = new AppUpdater(null, { version });
    assert.equal(updater.allowDowngrade, false);
    assert.equal(await updater.isUpdateAvailable(legacy), false, version);
    assert.equal(legacyProvider.resolveFiles(legacy)[0].url.toString(), 'https://github.com/NeoMei/SuperWagie-Open/releases/download/v2.6.1/SuperWagie-2.6.1-win-x64.exe');
  }
});
