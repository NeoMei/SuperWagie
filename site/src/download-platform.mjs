const MOBILE_MARKERS = /Android|iPhone|iPad|iPod|Mobile/i;

const normalize = (value) => String(value || '').trim().toLowerCase();

export function detectDownloadPlatform({
  userAgent = '',
  platform = '',
  userAgentDataPlatform = '',
  userAgentDataMobile = false,
} = {}) {
  const ua = String(userAgent || '');
  const mobile = Boolean(userAgentDataMobile) || MOBILE_MARKERS.test(ua);
  if (mobile) return 'unknown';

  if (/Windows (?:Phone|NT)/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';

  const hintedPlatform = normalize(userAgentDataPlatform);
  if (hintedPlatform.includes('win')) return 'windows';
  if (hintedPlatform.includes('mac')) return 'mac';

  const browserPlatform = normalize(platform);
  if (browserPlatform.startsWith('win')) return 'windows';
  if (browserPlatform.startsWith('mac')) return 'mac';

  return 'unknown';
}

export function applyDownloadPlatform(root, platform) {
  const links = root.querySelectorAll('[data-download-link]');
  const key = platform === 'windows' || platform === 'mac' ? platform : 'fallback';

  links.forEach((link) => {
    const url = link.dataset[`${key}Url`];
    const label = link.dataset[`${key}Label`];
    if (url) link.href = url;
    if (label) link.textContent = label;
  });

  if (root.documentElement) root.documentElement.dataset.downloadPlatform = key;
}

if (typeof window !== 'undefined') {
  window.SuperWagieDownload = { applyDownloadPlatform, detectDownloadPlatform };
}
