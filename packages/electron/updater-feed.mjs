export const PRODUCTION_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://github.com/NeoMei/SuperWagie/releases/latest/download/',
});

const isLoopbackHostname = (hostname) => {
  if (hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const values = octets.map(Number);
  return values[0] === 127 && values.every((value) => value <= 255);
};

export const parseLoopbackUpdaterUrl = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || !isLoopbackHostname(url.hostname)
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const resolveUpdaterFeed = ({
  environment = process.env,
  testBuild = false,
  platform = process.platform,
  architecture = process.arch,
} = {}) => {
  let feed = PRODUCTION_UPDATER_FEED;
  if (environment.OPENCHAMBER_E2E === '1' && testBuild === true) {
    const url = parseLoopbackUpdaterUrl(environment.OPENCHAMBER_UPDATER_E2E_URL);
    if (url) feed = { provider: 'generic', url };
  }
  return platform === 'win32' && architecture === 'x64'
    ? { ...feed, channel: 'latest-x64' }
    : feed;
};
