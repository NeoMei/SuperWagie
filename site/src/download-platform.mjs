const MOBILE_MARKERS = /Android|iPhone|iPad|iPod|Mobile/i;

const normalize = (value) => String(value || '').trim().toLowerCase();

export function detectDownloadPlatform({
  userAgent = '',
  platform = '',
  userAgentDataPlatform = '',
  userAgentDataMobile = false,
  maxTouchPoints = 0,
} = {}) {
  const ua = String(userAgent || '');
  const mobile = Boolean(userAgentDataMobile) || MOBILE_MARKERS.test(ua);
  if (mobile || (maxTouchPoints > 1 && /Mac/i.test(`${platform} ${ua}`))) return 'unknown';

  const hintedPlatform = normalize(userAgentDataPlatform);
  if (hintedPlatform) {
    if (hintedPlatform === 'windows') return 'windows';
    if (hintedPlatform === 'macos') return 'mac';
    return 'unknown';
  }

  if (/Windows NT/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';

  const browserPlatform = normalize(platform);
  if (browserPlatform.startsWith('win')) return 'windows';
  if (browserPlatform.startsWith('mac')) return 'mac';

  return 'unknown';
}

export function applyDownloadPlatform(root, platform) {
  const links = root.querySelectorAll('[data-download-link]');
  const keys = { mac: 'mac', windows: 'windows', 'windows-x64': 'windowsX64', 'windows-arm64': 'windowsArm64' };
  const key = keys[platform] || 'fallback';

  links.forEach((link) => {
    const url = link.dataset[`${key}Url`] || link.dataset.fallbackUrl;
    const label = link.dataset[`${key}Label`] || link.dataset.fallbackLabel;
    if (url) link.href = url;
    if (label) link.textContent = label;
  });

  if (root.documentElement) root.documentElement.dataset.downloadPlatform = key === 'fallback' ? 'unknown' : platform;
}

export async function configureDownloadLinks(root, browser) {
  const platform = detectDownloadPlatform({
    userAgent: browser.userAgent,
    platform: browser.platform,
    userAgentDataPlatform: browser.userAgentData?.platform,
    userAgentDataMobile: browser.userAgentData?.mobile,
    maxTouchPoints: browser.maxTouchPoints,
  });
  // Keep the choice page reachable while architecture detection is pending.
  applyDownloadPlatform(root, platform);
  if (platform !== 'windows') return platform;

  try {
    const hints = await browser.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness']);
    if (hints?.bitness !== '64') return platform;
    const detected = hints.architecture === 'arm' ? 'windows-arm64'
      : hints.architecture === 'x86' ? 'windows-x64' : platform;
    applyDownloadPlatform(root, detected);
    return detected;
  } catch {
    return platform;
  }
}

if (typeof window !== 'undefined') {
  window.SuperWagieDownload = { applyDownloadPlatform, detectDownloadPlatform, configureDownloadLinks };
}
