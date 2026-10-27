import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from '../../packages/ui/node_modules/happy-dom/lib/index.js';

import { configureDownloadLinks, detectDownloadPlatform } from '../src/download-platform.mjs';

const windowsUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const windowsBrowser = (hints) => ({
  userAgent: windowsUA,
  platform: 'Win32',
  userAgentData: {
    platform: 'Windows', mobile: false,
    async getHighEntropyValues(requested) {
      assert.deepEqual(requested, ['architecture', 'bitness']);
      return hints;
    },
  },
});
const page = async (locale = 'zh', name = 'home') => {
  const window = new Window({ url: `https://www.superwagie.com/${locale === 'en' ? 'en/' : ''}${name === 'home' ? '' : 'download/'}` });
  window.document.body.innerHTML = await readFile(new URL(`../src/pages/${locale}/${name}.html`, import.meta.url), 'utf8');
  return window;
};

test('keeps macOS selection and excludes mobile or unknown platforms', () => {
  assert.equal(detectDownloadPlatform({ userAgentDataPlatform: 'macOS' }), 'mac');
  assert.equal(detectDownloadPlatform({ platform: 'MacIntel', maxTouchPoints: 0 }), 'mac');
  assert.equal(detectDownloadPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }), 'unknown');
  assert.equal(detectDownloadPlatform({ userAgent: 'Macintosh; Intel Mac OS X 10_15; Mobile/15E148', platform: 'MacIntel' }), 'unknown');
  assert.equal(detectDownloadPlatform({ userAgentDataPlatform: 'Windows', userAgentDataMobile: true }), 'unknown');
  assert.equal(detectDownloadPlatform({ userAgent: windowsUA, userAgentDataPlatform: 'Linux' }), 'unknown');
});

for (const [architecture, target] of [['arm', 'arm64'], ['x86', 'x64']]) {
  test(`selects Windows ${target} from 64-bit client hints in both languages`, async () => {
    for (const locale of ['zh', 'en']) {
      const window = await page(locale);
      try {
        assert.equal(await configureDownloadLinks(window.document, windowsBrowser({ architecture, bitness: '64' })), `windows-${target}`);
        const link = window.document.querySelector('[data-download-link]');
        assert.match(link.href, new RegExp(`-win-${target}\\.exe$`));
        assert.match(link.textContent, new RegExp(target === 'arm64' ? 'ARM64' : 'x64'));
      } finally {
        await window.happyDOM.close();
      }
    }
  });
}

test('does not infer x64 or ARM64 from the user-agent string without the hints API', async () => {
  for (const userAgent of [windowsUA, 'Mozilla/5.0 (Windows NT 10.0; ARM64)', 'Mozilla/5.0 (Windows NT 10.0; WOW64)']) {
    const window = await page();
    try {
      await configureDownloadLinks(window.document, { userAgent, platform: 'Win32' });
      assert.equal(window.document.querySelector('[data-download-link]').getAttribute('href'), '/download/#windows');
    } finally {
      await window.happyDOM.close();
    }
  }
});

test('keeps the Windows chooser for rejected, withheld, unknown or 32-bit hints', async () => {
  const browsers = [
    windowsBrowser({}),
    windowsBrowser({ architecture: 'x86', bitness: '32' }),
    windowsBrowser({ architecture: 'arm', bitness: '32' }),
    windowsBrowser({ architecture: 'unknown', bitness: '64' }),
    windowsBrowser({ architecture: 'x86' }),
    { userAgent: windowsUA, userAgentData: { platform: 'Windows', getHighEntropyValues: async () => { throw new Error('denied'); } } },
  ];
  for (const browser of browsers) {
    const window = await page('en');
    try {
      await configureDownloadLinks(window.document, browser);
      assert.equal(window.document.querySelector('[data-download-link]').getAttribute('href'), '/en/download/#windows');
      assert.equal(window.document.querySelector('[data-download-link]').textContent, 'Choose a Windows installer');
    } finally {
      await window.happyDOM.close();
    }
  }
});

test('keeps the chooser usable while hints are pending', async () => {
  const window = await page('zh', 'download');
  let resolveHints;
  try {
    const browser = windowsBrowser({});
    browser.userAgentData.getHighEntropyValues = () => new Promise((resolve) => { resolveHints = resolve; });
    const configured = configureDownloadLinks(window.document, browser);
    assert.equal(window.document.querySelector('[data-download-link]').getAttribute('href'), '#windows');
    resolveHints({ architecture: 'arm', bitness: '64' });
    await configured;
    assert.match(window.document.querySelector('[data-download-link]').href, /-win-arm64\.exe$/);
  } finally {
    await window.happyDOM.close();
  }
});

test('leaves both explicit Windows installer buttons unchanged', async () => {
  for (const locale of ['zh', 'en']) {
    const window = await page(locale, 'download');
    try {
      const manual = [...window.document.querySelectorAll('a:not([data-download-link])')].filter((link) => /-win-(x64|arm64)\.exe$/.test(link.href));
      assert.equal(manual.length, 2);
      const before = manual.map((link) => [link.href, link.textContent]);
      await configureDownloadLinks(window.document, windowsBrowser({ architecture: 'arm', bitness: '64' }));
      assert.deepEqual(manual.map((link) => [link.href, link.textContent]), before);
      assert.equal(window.document.querySelector('#windows')?.tagName, 'H2');
    } finally {
      await window.happyDOM.close();
    }
  }
});

test('keeps mobile and unknown OS fallbacks and does not request architecture there', async () => {
  for (const browser of [
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15E148', platform: 'MacIntel' },
    { userAgent: 'Macintosh; Intel Mac OS X 10_15', platform: 'MacIntel', maxTouchPoints: 5 },
    { userAgent: 'Android', userAgentData: { platform: 'Android', mobile: true } },
    { userAgent: 'Linux', platform: 'Linux' },
    { userAgent: windowsUA, userAgentData: { platform: 'Linux', getHighEntropyValues() { throw new Error('must not call'); } } },
  ]) {
    const window = await page();
    try {
      await configureDownloadLinks(window.document, browser);
      assert.equal(window.document.querySelector('[data-download-link]').getAttribute('href'), '/download/');
    } finally {
      await window.happyDOM.close();
    }
  }
});

test('macOS still links directly to its DMG', async () => {
  const window = await page('en');
  try {
    await configureDownloadLinks(window.document, { userAgentData: { platform: 'macOS' } });
    assert.match(window.document.querySelector('[data-download-link]').href, /-mac-arm64\.dmg$/);
  } finally {
    await window.happyDOM.close();
  }
});
