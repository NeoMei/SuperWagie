import { describe, expect, it } from 'vitest';
import { planAccountKeyTests, selectAccountKeyModels } from './account-key-test-plan.js';

const model = (id, operations, rest = {}) => ({ id, name: id, operations, ...rest });
const configuration = { revision: 7, connections: [{ id: 'previous', providerId: 'private-provider', baseUrl: 'https://previous.example/v1' }], bindings: [] };
const account = (purposeModels = []) => ({ connectionId: 'account-connection', providerId: 'account-provider', modelId: 'chat', models: [{ id: 'chat', name: 'Chat' }, { id: 'small', name: 'Small' }, { id: 'embed', name: 'Embed' }], purposeModels });

describe('account key candidate test plan', () => {
  it('carries the authoritative speech operation into the shared account binding', () => {
    const catalog = [model('chat', ['chat']), model('qwen', ['speech'], { capabilitiesKnown: true, speechOperation: 'bailian.audio.speech.create' })];
    const selected = selectAccountKeyModels(catalog, configuration, []);
    expect(selected.purposeModels.find((entry) => entry.purpose === 'tts')).toEqual({ purpose: 'tts', modelId: 'qwen', parameters: { speechOperation: 'bailian.audio.speech.create' }, errorCode: null });
    const plan = planAccountKeyTests({ ...account(), ...selected, modelScope: 'llmrouter_available' }, configuration, [], [], catalog);
    expect(plan.find((entry) => entry.purpose === 'tts').binding).toEqual({ purpose: 'tts', connectionId: 'account-connection', model: 'qwen', parameters: { speechOperation: 'bailian.audio.speech.create' } });
    const changed = planAccountKeyTests({ ...account(), ...selected, modelScope: 'llmrouter_available' }, configuration, [], [], [model('qwen', ['speech'], { capabilitiesKnown: true })]);
    expect(changed.find((entry) => entry.purpose === 'tts')).toMatchObject({ status: 'skipped', errorCode: 'account_key_model_unavailable' });
  });
  it('includes every supported Key purpose when a fresh chat-only catalog has no feature candidate', () => {
    const catalog = [model('chat', ['chat'])];
    const selected = selectAccountKeyModels(catalog, configuration, []);
    expect(selected.purposeModels).toEqual(['ocr', 'vision', 'embedding', 'rerank', 'tts', 'image-generation'].map((purpose) => ({ purpose, modelId: null, parameters: {}, errorCode: 'account_key_model_unavailable' })));
    const plan = planAccountKeyTests({ ...account(), ...selected }, configuration, [], [], catalog);
    expect(plan.map(({ purpose, modelId, status, errorCode }) => ({ purpose, modelId, status, errorCode }))).toEqual(['ocr', 'vision', 'embedding', 'rerank', 'tts', 'image-generation'].map((purpose) => ({ purpose, modelId: null, status: 'skipped', errorCode: 'account_key_model_unavailable' })));
  });

  it('omits unconfigured purposes without a supported Key probe even when catalog operations exist', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('other', ['stt', 'speech-to-text', 'routing', 'video', 'image-editing', 'multimodal-embedding'])], configuration, []);
    expect(selected.purposeModels.map(({ purpose }) => purpose)).toEqual(['ocr', 'vision', 'embedding', 'rerank', 'tts', 'image-generation']);
    expect(selected.models.map(({ id }) => id)).toEqual(['chat']);
  });

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
  it('replaces unavailable models with compatible catalog models and resets model-specific parameters', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('image', ['image_generation']), model('embed', ['embedding'], { dimensions: 2048 })], { ...configuration, bindings: [
      { purpose: 'image-generation', connectionId: 'previous', model: 'missing-image', parameters: {} },
      { purpose: 'embedding', connectionId: 'previous', model: 'indexed-embedding', parameters: { dimensions: 1024 } },
    ] }, []);
    expect(selected.purposeModels).toEqual(expect.arrayContaining([
      { purpose: 'image-generation', modelId: 'image', parameters: {}, errorCode: null },
      { purpose: 'embedding', modelId: 'embed', parameters: { dimensions: 2048 }, errorCode: null },
    ]));
    expect(selected.models.map((entry) => entry.id)).toEqual(['chat', 'embed', 'image']);
  });

  it('replaces an unavailable legacy model and configures compatible unconfigured purposes', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('vision', ['chat'], { input_modalities: ['image'] }), model('image', ['image_generation'])], configuration, [
      { purpose: 'vision', modelId: 'legacy-vision', parameters: {} },
    ]);
    expect(selected.purposeModels).toEqual(expect.arrayContaining([
      { purpose: 'vision', modelId: 'vision', parameters: {}, errorCode: null },
      { purpose: 'image-generation', modelId: 'image', parameters: {}, errorCode: null },
    ]));
    expect(selected.models.map(({ id }) => id)).toEqual(['chat', 'vision', 'image']);
  });
  it('uses capability support and catalog order when an existing model has the wrong operation', () => {
    const selected = selectAccountKeyModels([
      model('text-only', ['chat']), model('vision-first', ['chat'], { input_modalities: ['text', 'image'] }),
      model('vision-second', ['chat'], { input_modalities: ['image'] }), model('rerank', ['rerank']),
    ], { ...configuration, bindings: [
      { purpose: 'vision', model: 'text-only', parameters: {} },
      { purpose: 'embedding', model: 'rerank', parameters: { dimensions: 1024 } },
    ] }, []);
    expect(selected.purposeModels).toEqual(expect.arrayContaining([
      { purpose: 'vision', modelId: 'vision-first', parameters: {}, errorCode: null },
      { purpose: 'embedding', modelId: null, parameters: {}, errorCode: 'account_key_model_unavailable' },
    ]));
  });
  it('keeps compatible current choices and their parameters ahead of earlier catalog entries', () => {
    const selected = selectAccountKeyModels([
      model('chat', ['chat']), model('embed-first', ['embedding'], { dimensions: 2048 }),
      model('embed-current', ['embedding'], { dimensions: 4096 }), model('speech-first', ['speech']), model('speech-current', ['speech']),
    ], { ...configuration, bindings: [
      { purpose: 'embedding', model: 'embed-current', parameters: { dimensions: 1024 } },
      { purpose: 'tts', model: 'speech-current', parameters: { voice: 'chosen-voice', language: 'zh' } },
    ] }, []);
    expect(selected.purposeModels).toEqual(expect.arrayContaining([
      { purpose: 'embedding', modelId: 'embed-current', parameters: { dimensions: 1024 }, errorCode: null },
      { purpose: 'tts', modelId: 'speech-current', parameters: { voice: 'chosen-voice', language: 'zh' }, errorCode: null },
    ]));
  });
  it('does not carry parameters from an unavailable model into a new model', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('embed', ['embedding']), model('speech', ['speech'])], configuration, [
      { purpose: 'embedding', modelId: 'old-embed', parameters: { dimensions: 1024 } },
      { purpose: 'tts', modelId: 'old-speech', parameters: { voice: 'old-voice', language: 'zh' } },
    ]);
    expect(selected.purposeModels).toEqual(expect.arrayContaining([
      { purpose: 'embedding', modelId: 'embed', parameters: {}, errorCode: null },
      { purpose: 'tts', modelId: 'speech', parameters: {}, errorCode: null },
    ]));
  });
  it('moves candidate probes to the account connection without carrying old provider settings', () => {
    const existing = { ...configuration, bindings: [{ purpose: 'embedding', connectionId: 'previous', model: 'embed', parameters: { dimensions: 1024, privateSetting: 'private-value' } }] };
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('embed', ['embedding'])], existing, []);
    const plan = planAccountKeyTests({ ...account(), ...selected }, existing, [], [], [model('embed', ['embedding'], { capabilitiesKnown: true })]);
    expect(plan.find((row) => row.purpose === 'embedding')).toEqual({ id: 'purpose:embedding', purpose: 'embedding', modelId: 'embed', status: 'queued', errorCode: null, binding: { purpose: 'embedding', connectionId: 'account-connection', model: 'embed', parameters: { dimensions: 1024 } }, revision: 7 });
    expect(plan.filter((row) => row.purpose !== 'embedding')).toEqual(['ocr', 'vision', 'rerank', 'tts', 'image-generation'].map((purpose) => ({ id: `purpose:${purpose}`, purpose, modelId: null, status: 'skipped', errorCode: 'account_key_model_unavailable', binding: { purpose, connectionId: 'account-connection', model: null, parameters: {} }, revision: 7 })));
    expect(JSON.stringify(plan)).not.toMatch(/previous|private-provider|private-value/);
  });

  it('does not infer vision chat capability from OCR image input', () => {
    const selected = selectAccountKeyModels([model('chat', ['chat']), model('ocr', ['ocr'], { input_modalities: ['image'] })], configuration, []);
    expect(selected.purposeModels.find((entry) => entry.purpose === 'vision')).toEqual({ purpose: 'vision', modelId: null, parameters: {}, errorCode: 'account_key_model_unavailable' });
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
