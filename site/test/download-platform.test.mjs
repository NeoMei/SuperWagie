import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDownloadPlatform, detectDownloadPlatform } from '../src/download-platform.mjs';

test('detects Windows from a browser user agent', () => {
  assert.equal(detectDownloadPlatform({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    platform: 'Win32',
  }), 'windows');
});

test('uses the User-Agent Client Hint when the user agent is reduced', () => {
  assert.equal(detectDownloadPlatform({
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/140 Safari/537.36',
    userAgentDataPlatform: 'macOS',
  }), 'mac');
});

test('does not treat iPad desktop mode as macOS', () => {
  assert.equal(detectDownloadPlatform({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'MacIntel',
  }), 'unknown');
});

test('updates platform links and keeps the fallback for unknown platforms', () => {
  const links = [
    {
      dataset: {
        fallbackUrl: '/download/',
        fallbackLabel: 'Download',
        macUrl: '/downloads/mac.dmg',
        windowsUrl: '/downloads/windows.exe',
        macLabel: 'Download for macOS',
        windowsLabel: 'Download for Windows',
      },
      href: '/download/',
      textContent: 'Download',
    },
    {
      dataset: {
        fallbackUrl: '/download/',
        fallbackLabel: 'Download',
        macUrl: '/downloads/mac.dmg',
        windowsUrl: '/downloads/windows.exe',
        macLabel: 'Download for macOS',
        windowsLabel: 'Download for Windows',
      },
      href: '/download/',
      textContent: 'Download',
    },
  ];
  const root = {
    querySelectorAll: () => links,
    documentElement: { dataset: {} },
  };

  applyDownloadPlatform(root, 'windows');
  assert.equal(links[0].href, '/downloads/windows.exe');
  assert.equal(links[0].textContent, 'Download for Windows');
  assert.equal(root.documentElement.dataset.downloadPlatform, 'windows');

  const fallback = {
    dataset: {
      fallbackUrl: '/download/',
      fallbackLabel: 'Download',
      macUrl: '/downloads/mac.dmg',
      windowsUrl: '/downloads/windows.exe',
      macLabel: 'Download for macOS',
      windowsLabel: 'Download for Windows',
    },
    href: '/download/',
    textContent: 'Download',
  };
  applyDownloadPlatform({
    querySelectorAll: () => [fallback],
    documentElement: { dataset: {} },
  }, 'unknown');
  assert.equal(fallback.href, '/download/');
  assert.equal(fallback.textContent, 'Download');
});
