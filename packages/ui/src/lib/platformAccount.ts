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
export class PlatformAccountError extends Error {
  constructor(readonly code: string, readonly interactionKind?: string, readonly status = 400) { super(code); this.name = 'PlatformAccountError'; }
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
    const error = z.object({ error: z.string(), interaction: z.object({ kind: z.string() }).optional() }).safeParse(raw);
    if (error.success && error.data.error === 'platform_session_expired') notifyPlatformAccountState({ status: 'expired' }, runtimeKey);
    throw new PlatformAccountError(error.success ? error.data.error : 'platform_unavailable', error.success ? error.data.interaction?.kind : undefined, response.status);
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

const modelTaskSchema = z.object({
  sessionID: z.string(), taskID: z.string(), actorID: z.string(), accountID: z.string(), model: z.string(), blocked: z.boolean(),
  calls: z.array(z.object({ callID: z.string(), status: z.enum(['PREPARED', 'DISPATCHED', 'DELIVERED', 'UNKNOWN', 'SETTLED', 'RELEASED', 'REJECTED']), charged: z.string().regex(/^\d+$/).optional() })),
});
export type PlatformModelTask = z.infer<typeof modelTaskSchema>;
export const readPlatformModelTask = async (sessionID: string): Promise<PlatformModelTask | null> => {
  try { return await requestPlatformAccount(`/api/platform-model/sessions/${encodeURIComponent(sessionID)}`, modelTaskSchema); }
  catch (error) { if (error instanceof PlatformAccountError && error.code === 'platform_task_unbound') return null; throw error; }
};
export const reconcilePlatformModelTask = (sessionID: string) => requestPlatformAccount(`/api/platform-model/sessions/${encodeURIComponent(sessionID)}/reconcile`, modelTaskSchema, 'POST');
export const formatPlatformCredits = (units: string): string => {
  const value = BigInt(units);
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`;
};
