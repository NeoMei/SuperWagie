import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { PlatformAccountError, requestPlatformAccount, notifyPlatformAccountState } from './platformAccount';
import { getRuntimeKey } from './runtime-switch';

const profileSchema = z.object({
  id: z.string(), username: z.string(), displayName: z.string(), email: z.string(), avatarAvailable: z.boolean(), version: z.string(),
});
export type PlatformProfile = z.infer<typeof profileSchema>;

export const readPlatformProfile = () => requestPlatformAccount('/api/platform-account/profile', profileSchema);
export const updatePlatformProfile = (input: { displayName: string }) => requestPlatformAccount('/api/platform-account/profile', profileSchema, 'PATCH', JSON.stringify(input));
export const changePlatformPassword = async (input: { currentPassword: string; newPassword: string }) => {
  const runtimeKey = getRuntimeKey();
  try {
    const result = await requestPlatformAccount('/api/platform-account/password', z.object({ status: z.literal('signed-out') }), 'POST', JSON.stringify(input));
    notifyPlatformAccountState(result, runtimeKey);
    return result;
  } catch (error) {
    if (error instanceof PlatformAccountError && ['platform_password_unknown', 'platform_unavailable', 'platform_response_invalid'].includes(error.code)) notifyPlatformAccountState({ status: 'expired' }, runtimeKey);
    throw error;
  }
};
export const updatePlatformAvatar = (input: { contentType: 'image/png' | 'image/jpeg'; dataBase64: string }) => requestPlatformAccount('/api/platform-account/avatar', profileSchema, 'PUT', JSON.stringify(input));

export const readPlatformAvatar = async (): Promise<Blob> => {
  const runtimeKey = getRuntimeKey();
  let response: Response;
  try { response = await runtimeFetch('/api/platform-account/avatar', { credentials: 'include', headers: { Accept: 'image/png,image/jpeg' } }); }
  catch { throw new PlatformAccountError('platform_unavailable'); }
  if (!response.ok) {
    let code = 'platform_unavailable';
    try { const raw: unknown = await response.json(); const parsed = z.object({ error: z.string() }).safeParse(raw); if (parsed.success) code = parsed.data.error; } catch { /* preserve the transport error */ }
    if (code === 'platform_session_expired') notifyPlatformAccountState({ status: 'expired' }, runtimeKey);
    throw new PlatformAccountError(code, undefined, response.status);
  }
  const type = response.headers.get('content-type')?.split(';', 1)[0];
  if (type !== 'image/png' && type !== 'image/jpeg') throw new PlatformAccountError('platform_response_invalid');
  return response.blob();
};
