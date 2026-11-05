import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, isTransientRuntimeKey } from '@/lib/runtime-switch';

const signedInSchema = z.object({
  status: z.literal('signed-in'),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  accounts: z.array(z.object({ id: z.string(), kind: z.enum(['personal', 'team']), name: z.string(), role: z.string() })),
  accountId: z.string().nullable(), expiresAt: z.string(),
  membership: z.array(z.object({ id: z.string(), product_id: z.string(), status: z.string(), paid_through: z.string(), offer: z.object({ name: z.string() }) })),
  credits: z.object({ available: z.string().regex(/^\d+$/), reserved: z.string().regex(/^\d+$/) }),
  consoleUrl: z.string().url().nullable(), modelService: z.enum(['available', 'unavailable']),
  modelRecoveryAvailable: z.boolean().optional(),
  modelUnavailableReason: z.string().optional(),
});
const stateSchema = z.discriminatedUnion('status', [signedInSchema, z.object({ status: z.enum(['unsupported', 'unconfigured', 'signed-out', 'expired']) })]);
export type PlatformAccountState = z.infer<typeof stateSchema>;
const identitySessionSchema = z.discriminatedUnion('status', [
  signedInSchema.pick({ status: true, user: true, expiresAt: true }),
  z.object({ status: z.enum(['unsupported', 'unconfigured', 'signed-out', 'expired']) }),
]);
export type PlatformIdentitySession = z.infer<typeof identitySessionSchema>;
type PlatformAccountStateListener = (state: PlatformIdentitySession, runtimeKey: string) => void;
const stateListeners = new Set<PlatformAccountStateListener>();
export const subscribePlatformAccountState = (listener: PlatformAccountStateListener): (() => void) => {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
};
export const notifyPlatformAccountState = (state: PlatformIdentitySession, runtimeKey: string): void => {
  for (const listener of stateListeners) listener(state, runtimeKey);
};
const passwordIssueSchema = z.enum(['too_short', 'too_long', 'too_many_bytes', 'control_character', 'special_character_required', 'repeated_character', 'letter_case_and_digit_required']);
export type PlatformPasswordIssue = z.infer<typeof passwordIssueSchema>;
export class PlatformAccountError extends Error {
  constructor(readonly code: string, readonly interactionKind?: string, readonly status = 400, readonly passwordIssues: PlatformPasswordIssue[] = [], readonly retryAfter?: number) { super(code); this.name = 'PlatformAccountError'; }
}
export const requestPlatformAccount = async <T>(path: string, schema: z.ZodType<T>, method: 'GET' | 'POST' | 'PUT' | 'PATCH' = 'GET', body?: string): Promise<T> => {
  const runtimeKey = getRuntimeKey();
  let response: Response;
  try {
    response = await runtimeFetch(path, {
      method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body,
    });
  } catch {
    throw new PlatformAccountError('platform_unavailable');
  }
  let raw: unknown;
  try { raw = await response.json(); }
  catch { throw new PlatformAccountError('platform_response_invalid'); }
  if (!response.ok) {
    const error = z.object({ error: z.string(), interaction: z.object({ kind: z.string() }).optional(), password_issues: z.array(passwordIssueSchema).max(8).catch([]), retry_after: z.number().int().positive().max(86400).optional().catch(undefined) }).safeParse(raw);
    if (error.success && error.data.error === 'platform_session_expired') notifyPlatformAccountState({ status: 'expired' }, runtimeKey);
    throw new PlatformAccountError(error.success ? error.data.error : 'platform_unavailable', error.success ? error.data.interaction?.kind : undefined, response.status, error.success && error.data.error === 'invalid_password' ? error.data.password_issues : [], error.success && error.data.error === 'rate_limited' ? error.data.retry_after : undefined);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new PlatformAccountError('platform_response_invalid');
  return parsed.data;
};
export const readPlatformAccount = () => requestPlatformAccount('/api/platform-account', stateSchema);
export const readPlatformIdentitySession = () => requestPlatformAccount('/api/platform-account/session', identitySessionSchema);
export const loginPlatformAccount = () => requestPlatformAccount('/api/platform-account/login', z.object({ authorizationUrl: z.string().url() }), 'POST');
export const selectPlatformAccount = (accountId: string) => requestPlatformAccount('/api/platform-account/account', stateSchema, 'PUT', JSON.stringify({ accountId }));
export const logoutPlatformAccount = async () => {
  const runtimeKey = getRuntimeKey();
  const state = await requestPlatformAccount('/api/platform-account/logout', stateSchema, 'POST');
  notifyPlatformAccountState(state, runtimeKey);
  return state;
};

const authMethodsSchema = z.object({
  passwordLogin: z.boolean(),
  registration: z.boolean(),
  browserLogin: z.boolean(),
  passwordRecoveryUrl: z.string().url().nullable().optional(),
});
export const readPlatformAuthMethods = () => requestPlatformAccount('/api/platform-account/auth-methods', authMethodsSchema);
interface PlatformRegistrationInput {
  username: string;
  password?: string;
  email?: string;
  displayName?: string;
  idempotencyKey: string;
}
const registrationSchema = z.object({ registrationId: z.string(), status: z.enum(['CREATED', 'UNKNOWN']), loginRequired: z.boolean(), retryAfter: z.number().int().nonnegative().optional() });
export const registerPlatformAccount = (input: PlatformRegistrationInput) => requestPlatformAccount('/api/platform-account/register', registrationSchema, 'POST', JSON.stringify(input));
const loginUsernameKey = (runtimeKey: string) => `superwagie.unihub.login-username.v1:${encodeURIComponent(runtimeKey)}`;
const loginUsernameSchema = z.string().trim().min(1).max(64);
export const readPlatformLoginUsername = (runtimeKey: string): string => {
  if (isTransientRuntimeKey(runtimeKey)) return '';
  try {
    const parsed = loginUsernameSchema.safeParse(localStorage.getItem(loginUsernameKey(runtimeKey)));
    return parsed.success ? parsed.data : '';
  } catch { return ''; }
};
export const passwordLoginPlatformAccount = async (input: { username: string; password: string }) => {
  const runtimeKey = getRuntimeKey();
  const state = await requestPlatformAccount('/api/platform-account/password-login', identitySessionSchema, 'POST', JSON.stringify(input));
  if (state.status === 'signed-in' && runtimeKey === getRuntimeKey() && !isTransientRuntimeKey(runtimeKey)) {
    const username = loginUsernameSchema.safeParse(input.username);
    if (username.success) {
      // Save before publishing identity, which can unmount the login form.
      try { localStorage.setItem(loginUsernameKey(runtimeKey), username.data); }
      catch { /* Username storage is optional; authentication already succeeded. */ }
    }
  }
  notifyPlatformAccountState(state, runtimeKey);
  return state;
};

const usageCount = z.string().regex(/^(0|[1-9]\d*)$/);
const usageAsset = z.enum(['CREDIT/6', 'CNY/6', 'LR_QUOTA/0']);
const nativeMeasurementSchema = z.object({
  key: z.string().min(1).max(128).refine((value) => value.trim() === value),
  unit: z.enum(['token', 'character', 'audio_second', 'image', 'request', 'video_second', 'provider_unit']),
  provider_unit: z.string().min(1).max(128).refine((value) => value.trim() === value).optional(),
  // Summary totals aggregate many valid 38-digit source quantities. Keep them exact.
  quantity: z.object({ value: z.string().max(1024).regex(/^(0|[1-9]\d*)$/), scale: z.number().int().min(0).max(9) }),
}).refine((measurement) => (measurement.unit === 'provider_unit') === (measurement.provider_unit !== undefined)
  && (!['token', 'character', 'image', 'request'].includes(measurement.unit) || measurement.quantity.scale === 0));
const nativeUsageSchema = z.array(z.object({
  operation: z.enum(['chat', 'responses', 'embedding', 'rerank', 'speech', 'transcription', 'image_generation', 'image_edit', 'ocr', 'video']),
  measurements: z.array(nativeMeasurementSchema).min(1).max(4096),
})).max(10).refine((groups) => {
  const operations = new Set<string>();
  return groups.every((group) => {
    if (operations.has(group.operation)) return false;
    operations.add(group.operation);
    const dimensions = new Set<string>();
    return group.measurements.every((measurement) => {
      const dimension = JSON.stringify([measurement.key, measurement.unit, measurement.provider_unit]);
      if (dimensions.has(dimension)) return false;
      dimensions.add(dimension);
      switch (measurement.unit) {
        case 'token': return ['chat', 'responses', 'embedding', 'rerank'].includes(group.operation)
          && ['input', 'output', 'cache_read', 'cache_write', 'reasoning'].includes(measurement.key);
        case 'request': return ['chat', 'ocr'].includes(group.operation) && measurement.key === 'requests';
        case 'character': return group.operation === 'speech' && measurement.key === 'characters';
        case 'audio_second': return group.operation === 'transcription' && measurement.key === 'audio';
        case 'image': return ['image_generation', 'image_edit'].includes(group.operation);
        case 'video_second': return group.operation === 'video' && measurement.key === 'video';
        case 'provider_unit': return group.operation === 'video' && measurement.key === 'provider';
      }
    });
  });
});
const usageSummarySchema = z.object({
  visibility: z.enum(['actor', 'account']),
  calls_total: usageCount, settled_calls: usageCount, pending_calls: usageCount, missing_usage_calls: usageCount,
  unknown_calls: usageCount, unknown_time: usageCount,
  usage: z.object({ input: usageCount.optional(), output: usageCount.optional(), cache_read: usageCount.optional(), cache_write: usageCount.optional(), reasoning: usageCount.optional() }),
  usage_complete: z.boolean(),
  native_usage: nativeUsageSchema.optional(),
  usage_coverage: z.object({ legacy_token_calls: usageCount.max(1024), native_metered_calls: usageCount.max(1024) }).optional(),
  charges_by_asset: z.partialRecord(usageAsset, usageCount).optional(),
  refunds_by_asset: z.partialRecord(usageAsset, usageCount).optional(),
});
const usageCallsSchema = z.object({
  items: z.array(z.object({
    call_id: z.string(), model: z.string(), status: z.string(), asset: usageAsset,
    held: usageCount.optional(), charged: usageCount.optional(), refunded: usageCount.optional(),
    usage_status: z.string().optional(), created_at: z.iso.datetime({ offset: true }).nullable(),
  })).max(20),
  has_more: z.boolean(),
});
type UsageProduct = 'superwagie' | 'llmrouter';
const platformUsagePath = (accountId: string, product: UsageProduct) => `/api/platform-account/usage/${encodeURIComponent(accountId)}${product === 'llmrouter' ? '/llmrouter' : ''}`;
export const readPlatformUsageSummary = (accountId: string, product: UsageProduct) => requestPlatformAccount(`${platformUsagePath(accountId, product)}/summary`, usageSummarySchema);
export const readPlatformUsageCalls = (accountId: string, product: UsageProduct) => requestPlatformAccount(`${platformUsagePath(accountId, product)}/calls`, usageCallsSchema);

const modelTaskSchema = z.object({
  sessionID: z.string(), taskID: z.string(), actorID: z.string(), accountID: z.string(), model: z.string(), blocked: z.boolean(),
  calls: z.array(z.object({ callID: z.string(), status: z.enum(['PREPARED', 'DISPATCHED', 'DELIVERED', 'UNKNOWN', 'SETTLED', 'RELEASED', 'REJECTED']), charged: z.string().regex(/^\d+$/).optional() })),
});
export type PlatformModelTask = z.infer<typeof modelTaskSchema>;
const mediaHistorySchema = z.object({ tasks: z.array(z.object({ sessionID: z.string().regex(/^media_[a-f0-9]{32}$/), model: z.string().min(1) })), nextCursor: z.string().regex(/^media_[a-f0-9]{32}$/).nullable() });
export type PlatformMediaHistory = z.infer<typeof mediaHistorySchema>;
export const readPlatformMediaHistory = (after?: string) => requestPlatformAccount(`/api/platform-model/media-tasks${after ? `?after=${encodeURIComponent(after)}` : ''}`, mediaHistorySchema);
export const readPlatformModelTask = async (sessionID: string): Promise<PlatformModelTask | null> => {
  try { return await requestPlatformAccount(`/api/platform-model/sessions/${encodeURIComponent(sessionID)}`, modelTaskSchema); }
  catch (error) { if (error instanceof PlatformAccountError && error.code === 'platform_task_unbound') return null; throw error; }
};
export const reconcilePlatformModelTask = (sessionID: string) => requestPlatformAccount(`/api/platform-model/sessions/${encodeURIComponent(sessionID)}/reconcile`, modelTaskSchema, 'POST');
export const formatPlatformCredits = (units: string): string => {
  const value = BigInt(units);
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`;
};

/** Exact scaled decimal display; only the scale is a JavaScript number. */
export const formatPlatformQuantity = (quantity: { value: string; scale: number }): string => {
  if (quantity.scale === 0) return quantity.value;
  const digits = quantity.value.padStart(quantity.scale + 1, '0');
  return `${digits.slice(0, -quantity.scale)}.${digits.slice(-quantity.scale)}`;
};
