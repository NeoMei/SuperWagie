import { z } from 'zod';

/** Only the exact managed model refusal has the restart recovery path. */
export const isManagedModelScopeRestartRequired = (message: string): boolean => {
  return /(?:^|[^a-z0-9_])platform_model_scope_restart_required(?:$|[^a-z0-9_])/i.test(message);
};

export const isManagedModelDispatchSuspended = (message: string): boolean => {
  return /(?:^|[^a-z0-9_])platform_dispatch_suspended(?:$|[^a-z0-9_])/i.test(message);
};

const fundingRefusal = z.object({ error: z.object({ code: z.literal('platform_model_funding_required') }) });
export const isManagedModelFundingRequired = (message: string, responseBody?: string | null): boolean => {
  if (/(?:^|[^a-z0-9_])platform_model_funding_required(?:$|[^a-z0-9_])/i.test(message)) return true;
  if (!responseBody || responseBody.length > 4096) return false;
  try { return fundingRefusal.safeParse(JSON.parse(responseBody)).success; } catch { return false; }
};

const gatewaySizeRefusal = z.object({ error: z.object({ code: z.literal('platform_gateway_request_too_large') }) });
export const isManagedModelRequestTooLarge = (message: string, responseBody?: string | null): boolean => {
  if (/(?:^|[^a-z0-9_])platform_gateway_request_too_large(?:$|[^a-z0-9_])/i.test(message)) return true;
  if (!responseBody || responseBody.length > 4096) return false;
  try { return gatewaySizeRefusal.safeParse(JSON.parse(responseBody)).success; } catch { return false; }
};
