import { MODEL_PURPOSES, MODEL_PROBE_PROTOCOLS } from './catalog.js';
import { accountChatModel, isAccountChatModel } from './account-key-models.js';

const operations = {
  vision: ['vision', 'image-input'], embedding: ['embedding', 'embeddings', 'text-embedding'],
  rerank: ['rerank', 'reranking', 'text-rerank'], tts: ['speech', 'tts', 'text-to-speech'],
  'image-generation': ['image-generation', 'image'], ocr: ['ocr'],
};
const supports = (model, purpose) => {
  const values = model.operations.map((operation) => operation.toLowerCase().replaceAll('_', '-'));
  return values.some((operation) => operations[purpose]?.includes(operation))
    || purpose === 'vision' && values.includes('chat') && model.input_modalities?.includes('image');
};
const safeParameters = (parameters = {}) => Object.fromEntries(
  ['dimensions', 'voice', 'language'].filter((name) => parameters[name] !== undefined).map((name) => [name, parameters[name]]),
);

/** Select compatible models from the account key's authoritative catalog. */
export const selectAccountKeyModels = (catalog, configuration, legacyModels, nativeModels = []) => {
  const defaultModel = nativeModels.find((model) => model.purpose === 'agent');
  const chat = catalog.find((model) => model.id === defaultModel?.modelId && isAccountChatModel(model))
    ?? catalog.find(isAccountChatModel);
  if (!chat) return null;
  const chatModels = catalog.filter(isAccountChatModel);
  const selected = new Map(chatModels.map(({ id, name }) => [id, { id, name }]));
  const purposeModels = [];
  for (const { id: purpose, status } of MODEL_PURPOSES) {
    if (['agent', 'auxiliary'].includes(purpose)) continue;
    const current = configuration.bindings.find((binding) => binding.purpose === purpose);
    const legacy = legacyModels.find((binding) => binding.purpose === purpose);
    const modelId = current?.model ?? legacy?.modelId;
    const exact = modelId ? catalog.find((model) => model.id === modelId && supports(model, purpose)) : null;
    const candidate = exact ?? catalog.find((model) => supports(model, purpose));
    const supported = status === 'available' && MODEL_PROBE_PROTOCOLS[purpose]?.includes('openai-compatible');
    if (!current && !legacy && !supported) continue;
    const defaults = purpose === 'embedding' && candidate?.dimensions ? { dimensions: candidate.dimensions } : {};
    const parameters = safeParameters(exact ? current?.parameters ?? legacy?.parameters ?? defaults : defaults);
    let errorCode = null;
    if (legacy?.errorCode === 'account_key_existing_configuration_unknown' && !current) errorCode = legacy.errorCode;
    else if (!MODEL_PROBE_PROTOCOLS[purpose]?.includes('openai-compatible')) errorCode = 'account_key_probe_unavailable';
    else if (!candidate) errorCode = 'account_key_model_unavailable';
    // Purpose selection never narrows the dynamic Key scope.
    if (candidate && !errorCode) selected.set(candidate.id, { id: candidate.id, name: candidate.name });
    purposeModels.push({ purpose, modelId: legacy?.errorCode === 'account_key_existing_configuration_unknown' && !current ? null : candidate?.id ?? null, parameters, errorCode });
  }
  return { modelId: chat.id, chatModels: chatModels.map(accountChatModel), models: [...selected.values()], purposeModels };
};

/** Candidate probes never borrow a previous connection's endpoint or credential. */
export const planAccountKeyTests = (record, configuration, legacyModels, nativeRows, keyCatalog) => {
  const allowedModels = record.modelScope === 'llmrouter_available' ? null : new Set(record.models.map((model) => model.id));
  const planned = nativeRows.map((row) => {
    const model = keyCatalog?.find((candidate) => candidate.id === row.modelId);
    const code = row.errorCode ?? (!row.modelId ? 'account_key_model_unavailable' : allowedModels && !allowedModels.has(row.modelId) ? 'account_key_model_not_authorized'
      : keyCatalog && (!model || model.capabilitiesKnown !== false && !isAccountChatModel(model)) ? 'account_key_model_unavailable' : null);
    return { ...row, native: true, status: code ? 'skipped' : 'queued', errorCode: code };
  });
  for (const selected of record.purposeModels) {
    const { purpose, modelId, parameters } = selected;
    const capability = keyCatalog?.find((model) => model.id === modelId);
    let errorCode = selected.errorCode;
    if (!errorCode && allowedModels && !allowedModels.has(modelId)) errorCode = 'account_key_model_not_authorized';
    if (!errorCode && keyCatalog && (!capability || capability.capabilitiesKnown !== false && !supports(capability, purpose))) errorCode = 'account_key_model_unavailable';
    if (!errorCode && !MODEL_PROBE_PROTOCOLS[purpose]?.includes('openai-compatible')) errorCode = 'account_key_probe_unavailable';
    planned.push({ id: `purpose:${purpose}`, purpose, modelId, status: errorCode ? 'skipped' : 'queued', errorCode,
      binding: { purpose, connectionId: record.connectionId, model: modelId, parameters: safeParameters(parameters) }, revision: configuration.revision });
  }
  return planned;
};
