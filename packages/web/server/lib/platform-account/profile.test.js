import { describe, expect, it } from 'vitest';
import { createPlatformProfileRuntime } from './profile.js';
import { PlatformAccountError } from './runtime.js';

const profile = { id: 'user-a', username: 'alice', display_name: 'Alice', email: '', avatar_url: '', version: '1' };
const fixture = () => {
  let saved = { ...profile }; let revoked = false; let passwordError;
  const requests = [];
  const accountRuntime = {
    captureIdentitySession: () => ({ userId: 'user-a',
      request: async (path, init = {}) => {
        if (revoked) throw new PlatformAccountError('platform_session_expired', 401);
        requests.push({ path, ...init });
        if (path.endsWith('/password')) { if (passwordError) throw passwordError; return null; }
        if (init.method === 'PATCH') saved = { ...saved, ...JSON.parse(init.body), version: '2' };
        if (path.endsWith('/avatar')) saved = { ...saved, avatar_url: '/v1/me/avatar' };
        return saved;
      },
      invalidate: () => { revoked = true; },
      updateUser: (user) => { saved.display_name = user.name; },
      readAvatar: async () => ({ bytes: Buffer.from([137, 80, 78, 71]), contentType: 'image/png' }),
    }),
  };
  return { runtime: createPlatformProfileRuntime(accountRuntime), requests, revoked: () => revoked, setPasswordError: (error) => { passwordError = error; }, setProfile: (next) => { saved = next; } };
};

describe('personal profile boundary', () => {
  it('reads authoritative profile and permits only a display name update', async () => {
    const f = fixture();
    expect(await f.runtime.read({})).toEqual({ id: 'user-a', username: 'alice', displayName: 'Alice', email: '', avatarAvailable: false, version: '1' });
    expect(await f.runtime.update({}, { displayName: 'New name' })).toMatchObject({ username: 'alice', displayName: 'New name' });
    await expect(f.runtime.update({}, { displayName: 'New', username: 'changed' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(JSON.parse(f.requests[1].body)).toEqual({ display_name: 'New name' });
  });
  it('rejects another subject and never exposes an external avatar URL', async () => {
    const f = fixture();
    f.setProfile({ ...profile, id: 'someone-else' });
    await expect(f.runtime.read({})).rejects.toMatchObject({ code: 'platform_response_invalid' });
    f.setProfile({ ...profile, avatar_url: 'https://unexpected.example/image' });
    await expect(f.runtime.read({})).rejects.toMatchObject({ code: 'platform_response_invalid' });
  });
  it('changes password once and revokes local sessions, including an uncertain result', async () => {
    const f = fixture();
    expect(await f.runtime.changePassword({}, { currentPassword: 'old-password', newPassword: 'NewPassword123!' })).toEqual({ status: 'signed-out' });
    expect(f.revoked()).toBe(true);
    expect(f.requests).toHaveLength(1);
    const uncertain = fixture(); uncertain.setPasswordError(new PlatformAccountError('platform_unavailable', 502));
    await expect(uncertain.runtime.changePassword({}, { currentPassword: 'old-password', newPassword: 'NewPassword123!' })).rejects.toMatchObject({ code: 'platform_password_unknown' });
    expect(uncertain.revoked()).toBe(true);
    expect(uncertain.requests).toHaveLength(1);
    const rejected = fixture(); rejected.setPasswordError(new PlatformAccountError('invalid_credentials', 400));
    await expect(rejected.runtime.changePassword({}, { currentPassword: 'wrong', newPassword: 'NewPassword123!' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(rejected.revoked()).toBe(false);
  });
  it('uploads only bounded PNG or JPEG and exposes the private avatar bytes', async () => {
    const f = fixture();
    expect(await f.runtime.updateAvatar({}, { contentType: 'image/png', dataBase64: 'iVBORw==' })).toMatchObject({ avatarAvailable: true });
    expect(JSON.parse(f.requests[0].body)).toEqual({ content_type: 'image/png', data_base64: 'iVBORw==' });
    await expect(f.runtime.updateAvatar({}, { contentType: 'image/svg+xml', dataBase64: 'PHN2Zz4=' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.runtime.updateAvatar({}, { contentType: 'image/png', dataBase64: Buffer.alloc(524289).toString('base64') })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await f.runtime.avatar({})).contentType).toBe('image/png');
  });
});
