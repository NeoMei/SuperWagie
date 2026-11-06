import { describe, expect, it } from 'vitest';
import { planAccountKeyTests, selectAccountKeyModels } from './account-key-test-plan.js';

const model = (id, operations, rest = {}) => ({ id, name: id, operations, ...rest });
const configuration = { revision: 7, connections: [{ id: 'previous', providerId: 'private-provider', baseUrl: 'https://previous.example/v1' }], bindings: [] };
const account = (purposeModels = []) => ({ connectionId: 'account-connection', providerId: 'account-provider', modelId: 'chat', models: [{ id: 'chat', name: 'Chat' }, { id: 'small', name: 'Small' }, { id: 'embed', name: 'Embed' }], purposeModels });

describe('account key candidate test plan', () => {
  it('registers and probes native protocols without replacing the selected native model ID', () => {
    const catalog = [model('responses', ['responses']), model('claude', ['claude']), model('gemini', ['gemini'])];
    const native = [{ id: 'native-agent', purpose: 'agent', providerId: 'old', modelId: 'claude' }];
    const selection = selectAccountKeyModels(catalog, configuration, [], native);
    expect(selection.modelId).toBe('claude');
    expect(selection.chatModels).toEqual([
      { id: 'responses', name: 'responses', package: 'aisdk:@ai-sdk/openai' },
      { id: 'claude', name: 'claude', package: 'aisdk:@ai-sdk/anthropic' },
      { id: 'gemini', name: 'gemini', package: 'aisdk:@ai-sdk/google' },
    ]);
    expect(planAccountKeyTests({ ...account(), ...selection, modelScope: 'llmrouter_available' }, configuration, [], native, catalog)[0]).toMatchObject({ modelId: 'claude', status: 'queued' });
  });
  it('uses the live catalog for dynamic scope while retaining finite scope for legacy keys', () => {
    const row = { id: 'account-chat', purpose: 'agent', providerId: 'account-provider', modelId: 'new-chat' };
    const catalog = [model('new-chat', ['chat'], { capabilitiesKnown: true })];
    expect(planAccountKeyTests({ ...account(), modelScope: 'llmrouter_available', models: [] }, configuration, [], [row], catalog)[0]).toMatchObject({ status: 'queued', errorCode: null });
    expect(planAccountKeyTests(account(), configuration, [], [row], catalog)[0]).toMatchObject({ status: 'skipped', errorCode: 'account_key_model_not_authorized' });
  });
  it('preserves every unavailable existing model instead of selecting a compatible replacement', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('image', ['image_generation']), model('embed', ['embedding'])], { ...configuration, bindings: [
      { purpose: 'image-generation', connectionId: 'previous', model: 'missing-image', parameters: {} },
      { purpose: 'embedding', connectionId: 'previous', model: 'indexed-embedding', parameters: { dimensions: 1024 } },
    ] }, []);
    expect(selected.purposeModels).toEqual(expect.arrayContaining([
      { purpose: 'image-generation', modelId: 'missing-image', parameters: {}, errorCode: 'account_key_model_unavailable' },
      { purpose: 'embedding', modelId: 'indexed-embedding', parameters: { dimensions: 1024 }, errorCode: 'account_key_model_unavailable' },
    ]));
    expect(selected.models.map((entry) => entry.id)).toEqual(['chat']);
  });

  it('preserves an unavailable legacy model while choosing defaults only for unconfigured purposes', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('vision', ['chat'], { input_modalities: ['image'] }), model('image', ['image_generation'])], configuration, [
      { purpose: 'vision', modelId: 'legacy-vision', parameters: {} },
    ]);
    expect(selected.purposeModels).toEqual(expect.arrayContaining([
      { purpose: 'vision', modelId: 'legacy-vision', parameters: {}, errorCode: 'account_key_model_unavailable' },
      { purpose: 'image-generation', modelId: 'image', parameters: {}, errorCode: null },
    ]));
    expect(selected.models.map(({ id }) => id)).toEqual(['chat', 'vision', 'image']);
  });
  it('moves candidate probes to the account connection without carrying old provider settings', () => {
    const existing = { ...configuration, bindings: [{ purpose: 'embedding', connectionId: 'previous', model: 'embed', parameters: { dimensions: 1024, privateSetting: 'private-value' } }] };
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('embed', ['embedding'])], existing, []);
    const plan = planAccountKeyTests({ ...account(), ...selected }, existing, [], [], [model('embed', ['embedding'], { capabilitiesKnown: true })]);
    expect(plan).toEqual([{ id: 'purpose:embedding', purpose: 'embedding', modelId: 'embed', status: 'queued', errorCode: null, binding: { purpose: 'embedding', connectionId: 'account-connection', model: 'embed', parameters: { dimensions: 1024 } }, revision: 7 }]);
    expect(JSON.stringify(plan)).not.toMatch(/previous|private-provider|private-value/);
  });

  it('does not infer vision chat capability from OCR image input', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('ocr', ['ocr'], { input_modalities: ['image'] })], configuration, []);
    expect(selected.purposeModels.some((entry) => entry.purpose === 'vision')).toBe(false);
    expect(selected.purposeModels.find((entry) => entry.purpose === 'ocr')).toMatchObject({ modelId: 'ocr', errorCode: null });
  });

  it('keeps native auxiliary purposes visible when their model cannot use the current key', () => {
    const plan = planAccountKeyTests(account(), configuration, [], [
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'account-provider', modelId: 'outside-key' },
    ], [model('chat', ['chat'], { capabilitiesKnown: true })]);
    expect(plan).toEqual([{ id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'account-provider', modelId: 'outside-key', native: true, status: 'skipped', errorCode: 'account_key_model_not_authorized' }]);
  });

  it('refuses explicitly disabled chat operations for auxiliary as well as account chat', () => {
    const plan = planAccountKeyTests(account(), configuration, [], [
      { id: 'account-chat', purpose: 'agent', providerId: 'account-provider', modelId: 'chat', account: true },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'account-provider', modelId: 'small' },
    ], [model('chat', [], { capabilitiesKnown: true }), model('small', [], { capabilitiesKnown: true })]);
    expect(plan.map(({ id, status, errorCode }) => ({ id, status, errorCode }))).toEqual([
      { id: 'account-chat', status: 'skipped', errorCode: 'account_key_model_unavailable' },
      { id: 'native-auxiliary', status: 'skipped', errorCode: 'account_key_model_unavailable' },
    ]);
  });

  it('permits actual probes for older key catalogs only when metadata is explicitly unknown', () => {
    const record = account([{ purpose: 'embedding', modelId: 'embed', parameters: { dimensions: 1024 }, errorCode: null }]);
    const native = [{ id: 'account-chat', purpose: 'agent', providerId: 'account-provider', modelId: 'chat', account: true }];
    const plan = planAccountKeyTests(record, configuration, [], native, [model('chat', [], { capabilitiesKnown: false }), model('embed', [], { capabilitiesKnown: false })]);
    expect(plan.map(({ status, errorCode }) => ({ status, errorCode }))).toEqual([{ status: 'queued', errorCode: null }, { status: 'queued', errorCode: null }]);
    const denied = planAccountKeyTests(record, configuration, [], native, [model('chat', [], { capabilitiesKnown: true }), model('embed', [], { capabilitiesKnown: true })]);
    expect(denied.map(({ status }) => status)).toEqual(['skipped', 'skipped']);
  });

  it('refuses a model absent from the credential-scoped catalog even if the receipt contains it', () => {
    const record = account([{ purpose: 'embedding', modelId: 'embed', parameters: {}, errorCode: null }]);
    const plan = planAccountKeyTests(record, configuration, [], [], []);
    expect(plan[0]).toMatchObject({ status: 'skipped', errorCode: 'account_key_model_unavailable' });
  });

  it('keeps an unreadable existing configuration blocked even when discovery has a model', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('embed', ['embedding'])], configuration, [{ purpose: 'embedding', modelId: 'embed', errorCode: 'account_key_existing_configuration_unknown' }]);
    expect(selected.purposeModels.find((entry) => entry.purpose === 'embedding')).toMatchObject({ errorCode: 'account_key_existing_configuration_unknown' });
    expect(selected.models.map(({ id }) => id)).toEqual(['chat']);
  });
});
