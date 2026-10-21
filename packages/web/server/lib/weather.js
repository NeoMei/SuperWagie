import { isEnterpriseMode } from './enterprise-mode.js';

/**
 * A daybook line wants the weather, not a forecast platform. This reads the
 * current conditions by public IP from wttr.in, keeps the answer for half an
 * hour, and sends no app data. Enterprise mode hides it: the administrator's
 * promise leaves no room for an unconfigured outside service.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const SOURCE = 'https://wttr.in/?format=%C|%t&m';

const LABELS = [
  [/thunder|storm/i, '雷雨'],
  [/torrential|heavy rain/i, '大雨'],
  [/light rain|patchy rain|drizzle|shower/i, '小雨'],
  [/rain/i, '雨'],
  [/blizzard|heavy snow/i, '大雪'],
  [/snow|sleet/i, '雪'],
  [/fog|mist|haze/i, '雾'],
  [/overcast/i, '阴'],
  [/cloud/i, '多云'],
  [/clear|sunny/i, '晴'],
];

/** wttr.in's `%C|%t` line, in the compact form the signature shows. */
export const parseWeather = (text) => {
  const [rawCondition = '', rawTemp = ''] = String(text ?? '').trim().split('|');
  const condition = rawCondition.trim();
  const temp = rawTemp.trim().replace(/^\+/, '').replace(/°C$/i, '°');
  if (!condition || !/^-?\d+(?:\.\d+)?°$/.test(temp)) return null;
  const label = LABELS.find(([pattern]) => pattern.test(condition))?.[1] ?? condition;
  return { label, temp };
};

export const createWeatherService = ({
  fetchImpl = fetch,
  now = () => Date.now(),
  enabled = () => !isEnterpriseMode(),
} = {}) => {
  let cached = null;
  let cachedAt = 0;

  return {
    read: async () => {
      if (!enabled()) return null;
      const current = now();
      const ttl = cached?.value ? CACHE_TTL_MS : FAILURE_TTL_MS;
      if (cached && current - cachedAt < ttl) return cached.value;
      cachedAt = current;
      try {
        const response = await fetchImpl(SOURCE, {
          signal: AbortSignal.timeout(4_000),
          headers: { 'User-Agent': 'SuperWagie/2.5' },
        });
        if (!response.ok) throw new Error('weather-request');
        const value = parseWeather(await response.text());
        cached = { value };
        return value;
      } catch {
        cached = { value: null };
        return null;
      }
    },
  };
};
