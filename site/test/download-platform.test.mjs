import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('selects Windows x64 from 64-bit x86 client hints in both languages', async () => {
  for (const locale of ['zh', 'en']) {
    const window = await page(locale);
    try {
      assert.equal(await configureDownloadLinks(window.document, windowsBrowser({ architecture: 'x86', bitness: '64' })), 'windows-x64');
      const link = window.document.querySelector('[data-download-link]');
      assert.match(link.href, /-win-x64\.exe$/);
      assert.match(link.textContent, /x64/);
    } finally {
      await window.happyDOM.close();
    }
  }
});

test('Windows ARM devices reach the page that states the x64-only support boundary', async () => {
  for (const locale of ['zh', 'en']) {
    const window = await page(locale, 'download');
    try {
      assert.equal(await configureDownloadLinks(window.document, windowsBrowser({ architecture: 'arm', bitness: '64' })), 'windows');
      assert.equal(window.document.querySelector('[data-download-link]').getAttribute('href'), '#windows');
      const windowsSection = window.document.querySelector('#windows').closest('section');
      assert.match(windowsSection.textContent, locale === 'zh' ? /暂不支持 Windows ARM/ : /Windows ARM is currently unsupported/);
      assert.equal(window.document.querySelectorAll('a[href$="-win-arm64.exe"]').length, 0);
      assert.equal(window.document.querySelectorAll('[data-windows-arm64-url], [data-windows-arm64-label]').length, 0);
    } finally {
      await window.happyDOM.close();
    }
  }
});

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

test('keeps the Windows download page for rejected, withheld, unknown or 32-bit hints', async () => {
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
      assert.equal(window.document.querySelector('[data-download-link]').textContent, 'View Windows download');
    } finally {
      await window.happyDOM.close();
    }
  }
});

test('keeps the download page reachable while hints are pending', async () => {
  const window = await page('zh', 'download');
  let resolveHints;
  try {
    const browser = windowsBrowser({});
    browser.userAgentData.getHighEntropyValues = () => new Promise((resolve) => { resolveHints = resolve; });
    const configured = configureDownloadLinks(window.document, browser);
    assert.equal(window.document.querySelector('[data-download-link]').getAttribute('href'), '#windows');
    resolveHints({ architecture: 'arm', bitness: '64' });
    await configured;
    assert.equal(window.document.querySelector('[data-download-link]').getAttribute('href'), '#windows');
  } finally {
    await window.happyDOM.close();
  }
});

test('leaves the explicit Windows x64 installer button unchanged', async () => {
  for (const locale of ['zh', 'en']) {
    const window = await page(locale, 'download');
    try {
      const manual = [...window.document.querySelectorAll('a:not([data-download-link])')].filter((link) => /-win-(x64|arm64)\.exe$/.test(link.href));
      assert.equal(manual.length, 1);
      assert.match(manual[0].href, /-win-x64\.exe$/);
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

test('built navigation and download pages offer macOS ARM64 and Windows x64 only', async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../build.mjs', import.meta.url))], { stdio: 'pipe' });
  for (const locale of ['zh', 'en']) {
    const prefix = locale === 'en' ? 'en/' : '';
    for (const name of ['index.html', 'download/index.html']) {
      const window = new Window({ url: `https://www.superwagie.com/${prefix}${name === 'index.html' ? '' : 'download/'}` });
      try {
        window.document.write(await readFile(new URL(`../dist/${prefix}${name}`, import.meta.url), 'utf8'));
        assert.equal(window.document.querySelectorAll('a[href$="-win-arm64.exe"], [data-windows-arm64-url], [data-windows-arm64-label]').length, 0);
        assert.ok(window.document.querySelector('a[href$="-mac-arm64.dmg"], [data-mac-url$="-mac-arm64.dmg"]'));
        await configureDownloadLinks(window.document, windowsBrowser({ architecture: 'x86', bitness: '64' }));
        for (const link of window.document.querySelectorAll('[data-download-link]')) {
          assert.match(link.href, /SuperWagie-[\d.]+-win-x64\.exe$/);
          assert.match(link.textContent, /x64/);
        }
        await configureDownloadLinks(window.document, windowsBrowser({ architecture: 'arm', bitness: '64' }));
        for (const link of window.document.querySelectorAll('[data-download-link]')) {
          assert.equal(link.href, `https://www.superwagie.com/${prefix}download/#windows`);
        }
      } finally {
        await window.happyDOM.close();
      }
    }
  }
});
