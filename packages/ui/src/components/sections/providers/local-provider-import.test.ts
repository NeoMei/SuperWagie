import { describe, expect, test } from 'bun:test';
import { createEmptyCustomProviderForm } from './custom-provider-form';
import { mergeImportedProviderModels, readLocalProviderConfig } from './local-provider-import';

describe('local provider configuration import', () => {
  test('reads an OpenCode JSONC provider without bringing credentials into the preview', () => {
    const result = readLocalProviderConfig(`{
      // User provider settings
      "provider": {
        "local": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": "https://models.example/v1", "apiKey": "source-key" },
          "headers": { "Authorization": "source-header" },
          "models": {
            "code": {
              "name": "Code", "limit": { "context": 65536, "output": 8192 },
              "modalities": { "input": ["text", "image"], "output": ["text"] },
              "variants": { "high": { "headers": { "Authorization": "source-variant" } } },
            },
          },
        },
      },
    }`);
    expect(result.skipped).toBe(0);
    expect(result.providers[0]).toMatchObject({
      providerID: 'local',
      baseURL: 'https://models.example/v1',
      protocol: 'openai-chat',
      apiKey: '',
      models: [{ id: 'code', name: 'Code', contextWindow: '65536', maxOutputTokens: '8192',
        inputCapabilities: ['text', 'image'], variants: 'high' }],
    });
    expect(JSON.stringify(result)).not.toContain('source-');
  });

  test('reads OpenCodex model mappings and skips providers that require another adapter', () => {
    const result = readLocalProviderConfig(JSON.stringify({
      providers: {
        gateway: {
          adapter: 'openai-responses', baseUrl: 'http://127.0.0.1:8788/v1',
          models: ['m1'], modelDisplayNames: { m1: 'One' }, modelContextWindows: { m1: 100000 },
          modelMaxOutputTokens: { m1: 5000 }, modelInputModalities: { m1: ['text', 'image'] },
          modelReasoningEfforts: { m1: ['low', 'high'] }, apiKeyPool: { main: 'source-pool' },
        },
        native: { adapter: 'dsh-account', baseUrl: 'https://example.com', models: ['m2'] },
      },
    }));
    expect(result.skipped).toBe(1);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({
      protocol: 'openai-responses',
      models: [{ id: 'm1', name: 'One', contextWindow: '100000', maxOutputTokens: '5000',
        inputCapabilities: ['text', 'image'], variants: 'low, high' }],
    });
    expect(JSON.stringify(result)).not.toContain('source-pool');
  });

  test('merges only missing models and only into the same connection', () => {
    const source = readLocalProviderConfig(JSON.stringify({
      providers: [{ id: 'local', protocol: 'openai-chat', baseURL: 'https://models.example/v1/', models: ['existing', 'new'] }],
    })).providers[0]!;
    const current = {
      ...createEmptyCustomProviderForm(), providerID: 'local-2', baseURL: 'https://models.example/v1',
      models: [{ ...source.models[0]!, name: 'My existing model' }], apiKey: 'target-key',
    };

    const merged = mergeImportedProviderModels(current, source);
    expect(merged?.models.map(({ id, name }) => [id, name])).toEqual([
      ['existing', 'My existing model'], ['new', 'new'],
    ]);
    expect(merged?.providerID).toBe('local-2');
    expect(merged?.apiKey).toBe('target-key');
    expect(mergeImportedProviderModels(merged!, source)?.models).toHaveLength(2);
    expect(mergeImportedProviderModels(current, { ...source, baseURL: 'https://elsewhere.example/v1' })).toBeNull();
    expect(mergeImportedProviderModels(current, { ...source, protocol: 'openai-responses' })).toBeNull();
  });

  test('omits credential-bearing or ambiguous connection URLs', () => {
    const result = readLocalProviderConfig(JSON.stringify({
      providers: {
        withQuery: { baseURL: 'https://example.com/v1?token=hidden', models: ['m'] },
        withUser: { baseURL: 'https://user:pass@example.com/v1', models: ['m'] },
      },
    }));
    expect(result).toEqual({ providers: [], skipped: 2 });
  });
});
