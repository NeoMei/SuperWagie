export const PROXY_CLIENT_CREDENTIAL_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'cf-access-client-id',
  'cf-access-client-secret',
  'cf-access-jwt-assertion',
];

export const OPENCODE_PROXY_ERROR_HEADER = 'x-openchamber-error';

const filteredRequestHeaders = new Set([
  ...PROXY_CLIENT_CREDENTIAL_HEADERS,
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding',
  'expect',
]);

const filteredResponseHeaders = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'www-authenticate',
  'set-cookie',
  'clear-site-data',
  OPENCODE_PROXY_ERROR_HEADER,
]);

export const collectForwardProxyHeaders = (requestHeaders, authHeaders = {}) => {
  const headers = {};

  for (const [key, value] of Object.entries(requestHeaders || {})) {
    if (!value) continue;
    const normalizedKey = key.toLowerCase();
    if (filteredRequestHeaders.has(normalizedKey)) continue;
    headers[normalizedKey] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  if (authHeaders.Authorization) {
    headers.Authorization = authHeaders.Authorization;
  }

  return headers;
};

export const shouldForwardProxyResponseHeader = (key, { bodyDecoded = true } = {}) => {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return false;
  }

  const name = key.toLowerCase();
  return !(bodyDecoded && name === 'content-encoding') && !filteredResponseHeaders.has(name);
};

export const applyForwardProxyResponseHeaders = (responseHeaders, response) => {
  if (!responseHeaders || typeof response?.setHeader !== 'function') {
    return;
  }

  for (const [key, value] of responseHeaders.entries()) {
    if (!shouldForwardProxyResponseHeader(key)) {
      continue;
    }
    response.setHeader(key, value);
  }
};
