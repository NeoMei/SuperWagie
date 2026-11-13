import { z } from 'zod';

/** Only the exact managed model refusal has the restart recovery path. */
export const isManagedModelScopeRestartRequired = (message: string): boolean => {
  return /(?:^|[^a-z0-9_])platform_model_scope_restart_required(?:$|[^a-z0-9_])/i.test(message);
};

export const isManagedModelDispatchSuspended = (message: string): boolean => {
  return /(?:^|[^a-z0-9_])platform_dispatch_suspended(?:$|[^a-z0-9_])/i.test(message);
};

const fundingRefusal = z.object({ error: z.object({ code: z.enum(['platform_model_funding_required', 'platform_model_credits_required']), asset: z.string().optional(), funding_mode: z.string().optional() }) });
export const isManagedModelFundingRequired = (message: string, responseBody?: string | null): boolean => {
  if (/(?:^|[^a-z0-9_])platform_model_(?:funding|credits)_required(?:$|[^a-z0-9_])/i.test(message)) return true;
  if (!responseBody || responseBody.length > 4096) return false;
  try { return fundingRefusal.safeParse(JSON.parse(responseBody)).success; } catch { return false; }
};

/** Model calls are billed in credits only, so every funding refusal leads to credits. */
export const managedModelFundingMode = (): 'credits' => 'credits';

const gatewaySizeRefusal = z.object({ error: z.object({ code: z.literal('platform_gateway_request_too_large') }) });
export const isManagedModelRequestTooLarge = (message: string, responseBody?: string | null): boolean => {
  if (/(?:^|[^a-z0-9_])platform_gateway_request_too_large(?:$|[^a-z0-9_])/i.test(message)) return true;
  if (!responseBody || responseBody.length > 4096) return false;
  try { return gatewaySizeRefusal.safeParse(JSON.parse(responseBody)).success; } catch { return false; }
};
