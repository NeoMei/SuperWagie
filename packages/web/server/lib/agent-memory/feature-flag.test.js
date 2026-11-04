import { afterEach, describe, expect, test } from 'bun:test';

import { isAgentMemoryFeatureAvailable } from './feature-flag.js';

const original = process.env.OPENCHAMBER_MEMORY_ENABLE;

afterEach(() => {
  if (original === undefined) delete process.env.OPENCHAMBER_MEMORY_ENABLE;
  else process.env.OPENCHAMBER_MEMORY_ENABLE = original;
});

describe('native memory availability', () => {
  test('is available independently of the legacy environment gate', () => {
    for (const value of [undefined, '', '0', 'false', '1', 'true']) {
      if (value === undefined) delete process.env.OPENCHAMBER_MEMORY_ENABLE;
      else process.env.OPENCHAMBER_MEMORY_ENABLE = value;
      expect(isAgentMemoryFeatureAvailable()).toBe(true);
    }
  });
});
