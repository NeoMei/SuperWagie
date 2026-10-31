import crypto from 'node:crypto';

const NONCE_BYTES = 16;

const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');
const randomNonce = () => crypto.randomBytes(NONCE_BYTES).toString('base64url');

export const platformRequestSignature = ({ secret, sessionNonce, requestNonce, method, pathname, body }) => crypto
  .createHmac('sha256', secret)
  .update(`${sessionNonce}\n${requestNonce}\n${method.toUpperCase()}\n${pathname}\n${digest(body)}`)
  .digest('base64url');

export const createPlatformIpcSession = (secret = crypto.randomBytes(32), sessionNonce = randomNonce()) => ({
  sessionID: `ipc_${crypto.randomBytes(16).toString('hex')}`,
  secret: Buffer.isBuffer(secret) ? secret : Buffer.from(secret, 'base64url'),
  sessionNonce,
  usedNonces: new Set(),
});

export const secureEqual = (left, right) => {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const createPlatformIpcClient = async (baseURL, fetchImpl = fetch) => {
  const secret = crypto.randomBytes(32);
  const sessionNonce = randomNonce();
  const response = await fetchImpl(`${baseURL}/handshake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: secret.toString('base64url'), nonce: sessionNonce }),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('platform_ipc_handshake_failed');
  const value = await response.json();
  if (!value?.sessionID || value.nonce !== sessionNonce) throw new Error('platform_ipc_handshake_invalid');
  const call = async (pathname, options = {}) => {
    const method = String(options.method || 'POST').toUpperCase();
    const body = options.body === undefined ? '' : String(options.body);
    const requestNonce = randomNonce();
    const headers = new Headers(options.headers || {});
    headers.set('x-unihub-ipc-session', value.sessionID);
    headers.set('x-unihub-ipc-nonce', requestNonce);
    headers.set('x-unihub-ipc-signature', platformRequestSignature({ secret, sessionNonce, requestNonce, method, pathname, body }));
    return fetchImpl(`${baseURL}${pathname}`, { ...options, method, headers, body, redirect: 'error' });
  };
  return { call, sessionID: value.sessionID, sessionNonce };
};
