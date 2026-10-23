import { afterEach, describe, expect, test } from 'bun:test';

import {
  AUTO_CHECK_UPDATES_KEY,
  SKIPPED_UPDATE_VERSION_KEY,
  clearSkippedUpdate,
  getSkippedUpdateVersion,
  isAutoCheckEnabled,
  setAutoCheckEnabled,
  skipUpdateVersion,
} from './update-preferences';

const values = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};

afterEach(() => {
  values.clear();
  Reflect.deleteProperty(globalThis, 'window');
});

const withStorage = () => {
  Reflect.set(globalThis, 'window', { localStorage: fakeStorage });
};

describe('update preferences', () => {
  test('auto-check is on by default and off only for the explicit "0"', () => {
    withStorage();
    expect(isAutoCheckEnabled()).toBe(true);
    setAutoCheckEnabled(false);
    expect(fakeStorage.getItem(AUTO_CHECK_UPDATES_KEY)).toBe('0');
    expect(isAutoCheckEnabled()).toBe(false);
    setAutoCheckEnabled(true);
    expect(isAutoCheckEnabled()).toBe(true);
  });

  test('a skipped version is remembered and cleared', () => {
    withStorage();
    expect(getSkippedUpdateVersion()).toBe('');
    skipUpdateVersion('2.8.0');
    expect(fakeStorage.getItem(SKIPPED_UPDATE_VERSION_KEY)).toBe('2.8.0');
    expect(getSkippedUpdateVersion()).toBe('2.8.0');
    skipUpdateVersion('   ');
    expect(getSkippedUpdateVersion()).toBe('2.8.0');
    clearSkippedUpdate();
    expect(getSkippedUpdateVersion()).toBe('');
  });
});
