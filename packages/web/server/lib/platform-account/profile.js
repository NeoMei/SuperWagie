import { z } from 'zod';
import { PlatformAccountError } from './runtime.js';

const profileSchema = z.object({
  id: z.string().min(1),
  username: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  display_name: z.string().max(160),
  avatar_url: z.string().refine((value) => value === '' || value === '/v1/me/avatar'),
  email: z.string().max(254),
  version: z.string().min(1),
}).strict();
const updateSchema = z.object({ displayName: z.string().max(160) }).strict().refine((value) => [...value.displayName].length <= 80);
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(512), newPassword: z.string().min(12).max(512) }).strict();
const avatarSchema = z.object({ contentType: z.enum(['image/png', 'image/jpeg']), dataBase64: z.string().min(1) }).strict();
const MAX_AVATAR_BYTES = 512 * 1024;

class PlatformProfileError extends PlatformAccountError {}

const reject = (code, status = 400) => { throw new PlatformProfileError(code, status); };

const profileFor = (capture, raw) => {
  const value = profileSchema.safeParse(raw);
  if (!value.success || value.data.id !== capture.userId) reject('platform_response_invalid', 502);
  return {
    id: value.data.id,
    username: value.data.username,
    displayName: value.data.display_name,
    email: value.data.email,
    avatarAvailable: Boolean(value.data.avatar_url),
    version: value.data.version,
  };
};

export const createPlatformProfileRuntime = (accountRuntime) => {
  const capture = (identity) => accountRuntime.captureIdentitySession(identity);
  const read = async (identity) => {
    const session = capture(identity);
    return profileFor(session, await session.request('/v1/me/profile'));
  };
  const update = async (identity, input) => {
    const session = capture(identity);
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) reject('invalid_request');
    return profileFor(session, await session.request('/v1/me/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: parsed.data.displayName }),
    }));
  };
  const changePassword = async (identity, input) => {
    const session = capture(identity);
    const parsed = passwordSchema.safeParse(input);
    if (!parsed.success || parsed.data.currentPassword === parsed.data.newPassword) reject('invalid_request');
    try {
      await session.request('/v1/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: parsed.data.currentPassword, new_password: parsed.data.newPassword }),
      });
    } catch (error) {
      if (error instanceof PlatformAccountError && error.status < 500 && error.code !== 'platform_session_changed_after_request') throw error;
      session.invalidate();
      reject('platform_password_unknown', 502);
    }
    session.invalidate();
    return { status: 'signed-out' };
  };
  const updateAvatar = async (identity, input) => {
    const session = capture(identity);
    const parsed = avatarSchema.safeParse(input);
    if (!parsed.success) reject('invalid_request');
    let bytes;
    try { bytes = Buffer.from(parsed.data.dataBase64, 'base64'); } catch { reject('invalid_request'); }
    if (!bytes.length || bytes.length > MAX_AVATAR_BYTES || bytes.toString('base64') !== parsed.data.dataBase64.replace(/\s/g, '')) reject('invalid_request');
    return profileFor(session, await session.request('/v1/me/avatar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: parsed.data.contentType, data_base64: parsed.data.dataBase64 }),
    }));
  };
  const avatar = async (identity) => {
    const session = capture(identity);
    const result = await session.readAvatar();
    if (!result || !Buffer.isBuffer(result.bytes) || !['image/png', 'image/jpeg'].includes(result.contentType) || result.bytes.length > MAX_AVATAR_BYTES) reject('platform_response_invalid', 502);
    return result;
  };
  return { read, update, changePassword, updateAvatar, avatar };
};
