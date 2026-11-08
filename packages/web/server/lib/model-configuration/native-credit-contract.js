import { z } from 'zod';

export const fundingModeSchema = z.enum(['credits', 'prepaid_cash']);
export const nativePricingSourceSchema = z.enum(['llmrouter_native', 'llmrouter_native_credit']);
const positiveInt64 = z.string().max(19).regex(/^[1-9][0-9]*$/).refine((value) => value.length < 19 || value <= '9223372036854775807');
const nativeCreditConversionSchema = z.object({
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).refine((value) => value !== 'lr-quota-usd-cny-v1'),
  numerator: positiveInt64,
  denominator: positiveInt64,
  rounding: z.literal('lr-cumulative-ceil-v1'),
});
export const nativeCreditDiscoverySchema = z.object({
  model_scope: z.literal('llmrouter_available'),
  pricing_source: z.literal('llmrouter_native_credit'),
  native_credit_conversion: nativeCreditConversionSchema,
});
export const nativeCreditCapabilitiesSchema = z.object({
  native_credits: z.object({ ready: z.boolean(), reason: z.string().optional(), conversion: nativeCreditConversionSchema.optional() }).optional(),
});
