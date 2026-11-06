import { describe, expect, it } from 'vitest';
import { readAccountKeyLegacyModels } from './account-key-legacy-models.js';

describe('account key legacy knowledge models', () => {
  it('allows fill-missing only when the backend authoritatively has no existing profile', async () => {
    expect(await readAccountKeyLegacyModels(async () => ({ provisioned: false, modelConfiguration: { status: 'unavailable' } }))).toEqual([]);
  });

  it('preserves configured model names without exposing backend IDs, endpoints or credentials', async () => {
    const result = await readAccountKeyLegacyModels(async () => ({
      provisioned: true,
      modelConfiguration: { status: 'available', models: [
        { purpose: 'embedding', model: 'existing-embed', modelId: 'internal-id', baseUrl: 'https://example.test', hasKey: true, dimensions: 1024, apiKey: 'fixture-never-project' },
      ], unavailablePurposes: ['ocr'] },
    }));
    expect(result).toEqual([
      { purpose: 'embedding', modelId: 'existing-embed', parameters: { dimensions: 1024 }, errorCode: 'account_key_existing_configuration' },
      { purpose: 'ocr', modelId: null, errorCode: 'account_key_existing_configuration_unknown' },
    ]);
  });

  it.each([
    async () => { throw new Error('offline'); },
    async () => ({ provisioned: true, modelConfiguration: { status: 'unavailable' } }),
    async () => ({ provisioned: true, modelConfiguration: { status: 'available', models: [{ purpose: 'embedding' }] } }),
  ])('keeps unreadable existing configuration unknown rather than replacing it', async (read) => {
    const rows = await readAccountKeyLegacyModels(read);
    expect(rows.map((row) => row.purpose)).toEqual(['embedding', 'rerank', 'vision', 'ocr']);
    expect(rows.every((row) => row.modelId === null && row.errorCode === 'account_key_existing_configuration_unknown')).toBe(true);
  });
});
