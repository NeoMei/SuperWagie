import { MODEL_PURPOSES, MODEL_PROBE_PROTOCOLS } from './catalog.js';

const operations = {
  vision: ['vision', 'image-input'], embedding: ['embedding', 'embeddings', 'text-embedding'],
  rerank: ['rerank', 'reranking', 'text-rerank'], tts: ['speech', 'tts', 'text-to-speech'],
  'image-generation': ['image-generation', 'image'],
};
const supports = (model, purpose) => {
  const values = model.operations.map((operation) => operation.toLowerCase().replaceAll('_', '-'));
  return values.some((operation) => operations[purpose]?.includes(operation))
    || purpose === 'vision' && values.includes('chat') && model.input_modalities?.includes('image');
};

/** Select only explicit capabilities, preserving every existing consumer choice. */
export const selectAccountKeyModels = (catalog, configuration, legacyModels) => {
  const chat = catalog.find((model) => model.operations.includes('chat'));
  if (!chat) return null;
  const selected = new Map([[chat.id, { id: chat.id, name: chat.name }]]);
  const purposeModels = MODEL_PURPOSES.filter((purpose) => purpose.status === 'available').map(({ id: purpose }) => {
    const current = configuration.bindings.find((binding) => binding.purpose === purpose);
    const legacy = legacyModels.find((binding) => binding.purpose === purpose);
    if (current || legacy) return { purpose, modelId: current?.model ?? legacy.modelId, parameters: {}, errorCode: legacy?.errorCode ?? 'account_key_existing_configuration' };
    if (!MODEL_PROBE_PROTOCOLS[purpose]?.includes('openai-compatible')) return { purpose, modelId: null, parameters: {}, errorCode: 'account_key_probe_unavailable' };
    const model = catalog.find((candidate) => supports(candidate, purpose));
    if (!model) return { purpose, modelId: null, parameters: {}, errorCode: 'account_key_model_unavailable' };
    selected.set(model.id, { id: model.id, name: model.name });
    return { purpose, modelId: model.id, parameters: purpose === 'embedding' && model.dimensions ? { dimensions: model.dimensions } : {}, errorCode: null };
  });
  return { modelId: chat.id, chatModels: [{ id: chat.id, name: chat.name }], models: [...selected.values()], purposeModels };
};

/** The public rows are receipts; private probe inputs never leave this module. */
export const planAccountKeyTests = (record, configuration, legacyModels, nativeRows) => {
  const allowedModels = new Set(record.models.map((model) => model.id));
  const planned = nativeRows.filter((row) => row.providerId === record.providerId && allowedModels.has(row.modelId)).map((row) => ({ ...row, native: true }));
  const purposes = new Set([...configuration.bindings.map((binding) => binding.purpose), ...legacyModels.map((binding) => binding.purpose), ...record.purposeModels.filter((row) => row.modelId).map((row) => row.purpose)]);
  for (const purpose of purposes) {
    if (purpose === 'agent' || purpose === 'auxiliary') continue;
    const binding = configuration.bindings.find((candidate) => candidate.purpose === purpose);
    const selected = record.purposeModels.find((candidate) => candidate.purpose === purpose);
    const legacy = legacyModels.find((candidate) => candidate.purpose === purpose);
    const connection = binding && configuration.connections.find((candidate) => candidate.id === binding.connectionId);
    const modelId = binding?.model ?? legacy?.modelId ?? selected?.modelId ?? null;
    let errorCode = null;
    if (!binding) errorCode = legacy ? legacy.errorCode ?? 'account_key_existing_configuration' : selected?.errorCode ?? (selected?.modelId ? 'account_key_model_unconfigured' : 'account_key_model_not_authorized');
    else if (binding.connectionId !== record.connectionId) errorCode = 'account_key_other_connection';
    else if (!allowedModels.has(binding.model)) errorCode = 'account_key_model_not_authorized';
    else if (!MODEL_PROBE_PROTOCOLS[purpose]?.includes(connection?.protocol)) errorCode = 'account_key_probe_unavailable';
    planned.push({ id: `purpose:${purpose}`, purpose, modelId, status: errorCode ? 'skipped' : 'queued', errorCode, binding, revision: configuration.revision });
  }
  return planned;
};
