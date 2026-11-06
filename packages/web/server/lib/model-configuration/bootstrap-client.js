import { llmRouterInferenceApiUrl } from './bootstrap-endpoints.js';
import { parseAccountKeyCatalog } from './account-key-catalog.js';

const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };

export const createUniHubBootstrapClient = ({ platformAccount, env = process.env, fetchImpl = fetch }) => ({
  discover: async ({ source, key, identity, accountId, instanceId }) => {
    if (source === 'session') {
      if (!identity || !accountId) return fail('platform_account_required', 409);
      const catalog = await platformAccount.request(identity, `/v1/accounts/${encodeURIComponent(accountId)}/model-discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_scope: 'llmrouter_available' }) });
      return { ...catalog, models: parseAccountKeyCatalog({ object: 'list', data: catalog.models }) };
    }
    const baseUrl = llmRouterInferenceApiUrl(env);
    const headers = { Authorization: `Bearer ${key}`, 'X-UniHub-Product': 'superwagie', Accept: 'application/json' };
    if (instanceId) headers['X-UniHub-Instance'] = instanceId;
    const response = await fetchImpl(`${baseUrl}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    let body;
    try { body = await response.json(); } catch { return fail('model_configuration_bootstrap_unavailable', 503); }
    if (!response.ok) return fail('model_configuration_bootstrap_key_invalid', response.status === 401 ? 403 : 502);
    const originProductId = response.headers.get('x-unihub-origin-product-id');
    const discoveredAccountId = response.headers.get('x-unihub-account-id');
    const discoveredInstanceId = response.headers.get('x-unihub-instance-id');
    if (!originProductId || !discoveredAccountId || !discoveredInstanceId) return fail('model_configuration_bootstrap_scope_missing', 502);
    return { origin_product_id: originProductId, account_id: discoveredAccountId, instance_id: discoveredInstanceId, expires_at: response.headers.get('x-unihub-expires-at') || null, base_url: baseUrl, data: parseAccountKeyCatalog(body) };
  },
});
