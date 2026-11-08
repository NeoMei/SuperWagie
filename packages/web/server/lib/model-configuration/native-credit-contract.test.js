import { describe, expect, it } from 'vitest';
import { nativeCreditDiscoverySchema } from './native-credit-contract.js';

const discovery = (numerator, denominator = '1') => ({
  model_scope: 'llmrouter_available', pricing_source: 'llmrouter_native_credit',
  native_credit_conversion: { version: 'fixture-v1', numerator, denominator, rounding: 'lr-cumulative-ceil-v1' },
});

describe('native credit discovery conversion', () => {
  it('retains the exact maximum int64 conversion without floating-point rounding', () => {
    const payload = discovery('9223372036854775807', '9223372036854775807');
    expect(nativeCreditDiscoverySchema.parse(payload)).toEqual(payload);
  });

  it.each(['0', '-1', '01', '1.5', '1e3', 'invalid', '9223372036854775808', '10000000000000000000'])(
    'rejects a noncanonical or out-of-range rational component %s', (value) => {
      expect(nativeCreditDiscoverySchema.safeParse(discovery(value)).success).toBe(false);
      expect(nativeCreditDiscoverySchema.safeParse(discovery('1', value)).success).toBe(false);
    },
  );
});
