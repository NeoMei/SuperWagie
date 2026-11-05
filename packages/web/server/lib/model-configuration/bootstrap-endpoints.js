const apiUrl = (value) => {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new Error('invalid endpoint');
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
    return url.href;
  } catch {
    throw Object.assign(new Error('model_configuration_bootstrap_endpoint_invalid'), { code: 'model_configuration_bootstrap_endpoint_invalid', status: 503 });
  }
};

export const uniHubCatalogApiUrl = (env = process.env) => apiUrl(env.OPENCHAMBER_UNIHUB_API_URL || 'https://unihub.quukk.com/v1');

// Public API keys use LLMRouter inference. UniHub's /v1 only serves discovery.
export const llmRouterInferenceApiUrl = (env = process.env) => {
  const value = apiUrl(env.OPENCHAMBER_LLMROUTER_API_URL || 'https://llmrouter.quukk.com/v1');
  if (new URL(value).pathname.endsWith('/platform/v1')) throw Object.assign(new Error('model_configuration_bootstrap_endpoint_invalid'), { code: 'model_configuration_bootstrap_endpoint_invalid', status: 503 });
  return value;
};
