import { llmRouterInferenceApiUrl, uniHubCatalogApiUrl } from './bootstrap-endpoints.js';

const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };

export const createUniHubBootstrapClient = ({ platformAccount, env = process.env, fetchImpl = fetch }) => ({
  discover: async ({ source, key, identity, accountId, instanceId }) => {
    if (source === 'session') {
      if (!identity || !accountId) return fail('platform_account_required', 409);
      return platformAccount.request(identity, `/v1/accounts/${encodeURIComponent(accountId)}/model-discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    }
    const baseUrl = llmRouterInferenceApiUrl(env);
    const headers = { Authorization: `Bearer ${key}`, 'X-UniHub-Product': 'superwagie', Accept: 'application/json' };
    if (instanceId) headers['X-UniHub-Instance'] = instanceId;
    const response = await fetchImpl(`${uniHubCatalogApiUrl(env)}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    let body;
    try { body = await response.json(); } catch { return fail('model_configuration_bootstrap_unavailable', 503); }
    if (!response.ok) return fail('model_configuration_bootstrap_key_invalid', response.status === 401 ? 403 : 502);
    const originProductId = response.headers.get('x-unihub-origin-product-id');
    const discoveredAccountId = response.headers.get('x-unihub-account-id');
    const discoveredInstanceId = response.headers.get('x-unihub-instance-id');
    if (!originProductId || !discoveredAccountId || !discoveredInstanceId) return fail('model_configuration_bootstrap_scope_missing', 502);
    return { origin_product_id: originProductId, account_id: discoveredAccountId, instance_id: discoveredInstanceId, expires_at: response.headers.get('x-unihub-expires-at') || null, base_url: baseUrl, data: body?.data ?? [] };
  },
  issueKey: async ({ identity, accountId, instanceId, models, expiresAt }) => {
    if (!identity || !accountId) return fail('platform_account_required', 409);
    const baseUrl = llmRouterInferenceApiUrl(env);
    const catalog = await platformAccount.request(identity, `/v1/accounts/${encodeURIComponent(accountId)}/model-discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const discoveredModels = Array.isArray(catalog?.models) ? catalog.models : [];
    const modelIds = Array.isArray(models) && models.length ? models : discoveredModels.map((model) => model.id).filter(Boolean);
    const payload = { name: 'SuperWagie quick setup', origin_product_id: 'superwagie', instance_id: instanceId || 'default', models: modelIds };
    if (expiresAt) payload.expires_at = expiresAt;
    const value = await platformAccount.request(identity, `/v1/accounts/${encodeURIComponent(accountId)}/api-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { key: value?.token, origin_product_id: value?.origin_product_id || 'superwagie', account_id: value?.account_id || accountId, instance_id: value?.instance_id || instanceId || 'default', expires_at: value?.expires_at || null, base_url: baseUrl, data: discoveredModels.filter((model) => modelIds.includes(model.id)) };
  },
});
