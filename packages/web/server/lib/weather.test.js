import { describe, expect, test } from 'bun:test';

import { createWeatherService, parseWeather } from './weather.js';

describe('parseWeather', () => {
  test('maps the common conditions and trims the temperature', () => {
    expect(parseWeather('Clear |+25°C')).toEqual({ label: '晴', temp: '25°' });
    expect(parseWeather('Partly cloudy |+18°C')).toEqual({ label: '多云', temp: '18°' });
    expect(parseWeather('Light rain |+12°C')).toEqual({ label: '小雨', temp: '12°' });
    expect(parseWeather('Overcast |+8°C')).toEqual({ label: '阴', temp: '8°' });
    expect(parseWeather('Thunderstorm |+20°C')).toEqual({ label: '雷雨', temp: '20°' });
  });

  test('keeps an unknown condition instead of inventing one', () => {
    expect(parseWeather('Smoky haze |+31°C')).toEqual({ label: '雾', temp: '31°' });
    expect(parseWeather('Dust |+31°C')).toEqual({ label: 'Dust', temp: '31°' });
  });

  test('rejects a malformed line', () => {
    expect(parseWeather('')).toBeNull();
    expect(parseWeather('Clear')).toBeNull();
    expect(parseWeather('Clear |n/a')).toBeNull();
  });
});

describe('createWeatherService', () => {
  test('reads once and serves the cached line', async () => {
    let calls = 0;
    const service = createWeatherService({
      enabled: () => true,
      fetchImpl: async () => {
        calls += 1;
        return new Response('Clear |+25°C', { status: 200 });
      },
    });
    expect(await service.read()).toEqual({ label: '晴', temp: '25°' });
    expect(await service.read()).toEqual({ label: '晴', temp: '25°' });
    expect(calls).toBe(1);
  });

  test('stays off in enterprise mode and never calls the source', async () => {
    let calls = 0;
    const service = createWeatherService({
      enabled: () => false,
      fetchImpl: async () => {
        calls += 1;
        return new Response('Clear |+25°C', { status: 200 });
      },
    });
    expect(await service.read()).toBeNull();
    expect(calls).toBe(0);
  });

  test('a failed read is null, not a guessed forecast', async () => {
    const service = createWeatherService({
      enabled: () => true,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    expect(await service.read()).toBeNull();
  });
});
