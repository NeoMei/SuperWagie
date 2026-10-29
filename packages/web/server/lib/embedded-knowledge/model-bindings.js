import { z } from 'zod';
import { createHash } from 'node:crypto';

import { ProvisionError } from './provision.js';

const PURPOSES = ['embedding', 'rerank', 'vision', 'ocr'];
const OCR_TYPES = ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'tiff'];
const parserRuleSchema = z.looseObject({ file_types: z.array(z.string()), engine: z.string() });
const chunkingSchema = z.looseObject({ parser_engine_rules: z.array(parserRuleSchema).optional() });
const TYPES = { embedding: 'Embedding', rerank: 'Rerank', vision: 'VLLM' };
const modelSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  parameters: z.looseObject({
    base_url: z.string().optional(),
    embedding_parameters: z.looseObject({ dimension: z.number().optional() }).optional(),
  }).optional(),
});
const baseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  embedding_model_id: z.string().optional(),
  vlm_config: z.looseObject({ model_id: z.string().optional() }).optional(),
  chunking_config: chunkingSchema.optional(),
  config: z.looseObject({ chunking_config: chunkingSchema.optional() }).optional(),
});

export const knowledgeBindingProtocols = (purpose, managed = false) => {
  const protocols = purpose === 'ocr' ? ['paddleocr'] : purpose === 'rerank'
    ? ['aliyun']
    : ['openai-compatible', 'aliyun'];
  return managed ? [...protocols, 'managed-media'] : protocols;
};

export function knowledgeParserConfiguration(binding, existing = {}) {
  return {
    ...existing,
    paddleocr_vl_cloud_token: binding.apiKey,
    paddleocr_vl_cloud_base_url: binding.baseUrl,
    paddleocr_vl_cloud_model: binding.model,
  };
}

export function knowledgeModelParameters(purpose, binding, existing = {}) {
  let baseUrl = binding.baseUrl.replace(/\/+$/, '');
  if (binding.protocol === 'aliyun') {
    const url = new URL(baseUrl);
    if (purpose === 'rerank') url.pathname = '/api/v1/services/rerank/text-rerank/text-rerank';
    else if (!url.pathname || url.pathname === '/') url.pathname = '/compatible-mode/v1';
    baseUrl = url.href.replace(/\/+$/, '');
  }
  const parameters = { ...existing, base_url: baseUrl, api_key: binding.apiKey };
  parameters.provider = binding.protocol === 'aliyun' || binding.protocol === 'managed-media' && purpose === 'rerank' ? 'aliyun' : 'openai';
  if (purpose === 'vision') parameters.supports_vision = true;
  if (purpose === 'embedding' && binding.parameters.dimensions !== undefined) {
    parameters.embedding_parameters = { ...existing.embedding_parameters, dimension: binding.parameters.dimensions };
  }
  return parameters;
}

/** Updates only explicitly selected models, retaining the KB and every index record. */
export function createKnowledgeModelBindings({ createClient, getState, readDocuments, resolveModelBinding, resolveManagedBinding }) {
  let appliedIdentity = null;
  let synchronizePromise = null;

  const materialize = async (binding) => {
    if (!binding || binding.protocol !== 'managed-media') return binding;
    if (!resolveManagedBinding) throw new ProvisionError('model_configuration_managed_unavailable', 'Managed knowledge scope is not active');
    const scoped = await resolveManagedBinding(binding);
    let endpoint;
    try { endpoint = new URL(scoped?.baseUrl); } catch { throw new ProvisionError('model_configuration_managed_unavailable', 'Managed knowledge scope is invalid'); }
    const expectedPath = binding.purpose === 'ocr' ? '/api/v2/ocr/jobs' : binding.purpose === 'rerank' ? '/api/v1/services/rerank/text-rerank/text-rerank' : '/v1';
    if (scoped?.purpose !== binding.purpose || scoped.model !== binding.model || scoped.protocol !== 'managed-media' || typeof scoped.apiKey !== 'string' || !scoped.apiKey || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.pathname !== expectedPath || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new ProvisionError('model_configuration_managed_unavailable', 'Managed knowledge scope is invalid');
    }
    return { ...binding, baseUrl: scoped.baseUrl, apiKey: scoped.apiKey };
  };

  const inspect = async () => {
    const state = getState();
    if (!state.email || !state.password || !state.knowledgeBaseId) {
      throw new ProvisionError('model_configuration_knowledge_not_ready', 'Provision the knowledge backend before applying its model configuration');
    }
    try {
      const session = await createClient().login(state.email, state.password);
      const client = createClient({ sessionToken: session.token });
      const models = z.array(modelSchema).parse(await client.listModels());
      const base = baseSchema.parse(await client.getKnowledgeBase(state.knowledgeBaseId));
      return { client, models, base };
    } catch (cause) {
      throw new ProvisionError('model_configuration_knowledge_not_ready', 'Start the knowledge backend before changing its model configuration', { cause });
    }
  };

  const currentModel = ({ models, base }, purpose) => {
    const id = purpose === 'embedding' ? base.embedding_model_id : purpose === 'vision' ? base.vlm_config?.model_id : null;
    if (purpose === 'embedding') return models.find((model) => model.id === id) ?? null;
    return models.find((model) => id ? model.id === id : model.type === TYPES[purpose]) ?? null;
  };

  const validateEmbedding = async (binding, context) => {
    const existing = currentModel(context, 'embedding');
    if (!existing) throw new ProvisionError('model_configuration_knowledge_not_ready', 'The knowledge base has no active embedding model; repair it before applying model configuration');
    const documents = Object.values(await readDocuments());
    const remote = await context.client.listKnowledge({ knowledgeBaseId: context.base.id, pageSize: 1 });
    const indexed = remote.total > 0 || documents.some((document) => document.knowledgeId && document.state !== 'missing');
    if (!indexed) return;
    const dimensions = binding.parameters.dimensions;
    const previousDimensions = existing.parameters?.embedding_parameters?.dimension;
    const baseUrl = knowledgeModelParameters('embedding', binding).base_url;
    if (existing.name !== binding.model || existing.parameters?.base_url?.replace(/\/+$/, '') !== baseUrl || (dimensions !== undefined && dimensions !== previousDimensions)) {
      throw new ProvisionError('model_configuration_embedding_rebuild_required', 'This knowledge library already has an index. Keep its embedding model, endpoint and dimensions, or rebuild the library explicitly before replacing them');
    }
  };

  const prepareModelBindingChange = async (purpose, next) => {
    if (!PURPOSES.includes(purpose) || !next) return;
    if (!knowledgeBindingProtocols(purpose, Boolean(resolveManagedBinding)).includes(next.protocol)) {
      throw new ProvisionError('model_configuration_unsupported_protocol', 'This knowledge consumer does not support the selected model protocol');
    }
    const state = getState();
    if (!state.knowledgeBaseId) return;
    if (purpose === 'embedding') await validateEmbedding(await materialize(next), await inspect());
    if (purpose === 'ocr') {
      if (state.backendReady === false) return;
      const context = await inspect();
      let engines;
      try { engines = await context.client.listParserEngines(); }
      catch (cause) { throw new ProvisionError('model_configuration_knowledge_not_ready', 'The backend parser capabilities could not be read', { cause }); }
      // Available can be false until the token is configured. Registration
      // proves that this binary includes the adapter without a cloud call.
      if (!Array.isArray(engines) || !engines.some((engine) => engine.Name === 'paddleocr_vl_cloud')) {
        throw new ProvisionError('model_configuration_ocr_unavailable', 'This knowledge backend does not include the PaddleOCR parser');
      }
    }
  };

  const synchronize = async () => {
    const bindings = await Promise.all(PURPOSES.map(async (purpose) => materialize(await resolveModelBinding(purpose, { supportedProtocols: knowledgeBindingProtocols(purpose, Boolean(resolveManagedBinding)) }))));
    const selected = bindings.filter(Boolean);
    if (selected.length === 0) return;
    const identity = createHash('sha256').update(JSON.stringify(selected.map(({ purpose, protocol, baseUrl, model, apiKey, parameters }) => ({ purpose, protocol, baseUrl, model, apiKey, parameters })))).digest('hex');
    if (identity === appliedIdentity) return;
    const context = await inspect();
    for (let index = 0; index < PURPOSES.length; index += 1) {
      const purpose = PURPOSES[index];
      const binding = bindings[index];
      if (!binding) continue;
      if (purpose === 'ocr') {
        const parser = await context.client.getTenantParserConfig();
        await context.client.updateTenantParserConfig(knowledgeParserConfiguration(binding, parser));
        const engines = await context.client.listParserEngines();
        if (!engines.some((engine) => engine.Name === 'paddleocr_vl_cloud' && engine.Available)) {
          throw new ProvisionError('model_configuration_ocr_unavailable', 'This knowledge backend does not include the PaddleOCR parser');
        }
        const chunking = context.base.config?.chunking_config ?? context.base.chunking_config ?? {};
        const rules = (chunking.parser_engine_rules ?? []).map((rule) => ({
          ...rule, file_types: rule.file_types.filter((type) => !OCR_TYPES.includes(type.toLowerCase())),
        })).filter((rule) => rule.file_types.length > 0);
        const config = { ...context.base.config, chunking_config: { ...chunking, parser_engine_rules: [{ file_types: OCR_TYPES, engine: 'paddleocr_vl_cloud' }, ...rules] } };
        await context.client.updateKnowledgeBase(context.base.id, { name: context.base.name, config });
        context.base.config = config;
        continue;
      }
      if (purpose === 'embedding') await validateEmbedding(binding, context);
      const existing = currentModel(context, purpose);
      const model = {
        name: binding.model,
        display_name: binding.model,
        type: TYPES[purpose],
        source: 'remote',
        description: 'SuperWagie model configuration',
        parameters: knowledgeModelParameters(purpose, binding, existing?.parameters),
      };
      let modelId = existing?.id;
      if (existing) await context.client.updateModel(existing.id, model);
      else {
        const created = modelSchema.parse(await context.client.createModel(model));
        context.models.push(created);
        modelId = created.id;
      }
      if (purpose === 'vision' && (!context.base.vlm_config?.enabled || context.base.vlm_config.model_id !== modelId)) {
        const vlmConfig = { ...context.base.vlm_config, enabled: true, model_id: modelId };
        await context.client.updateKnowledgeBase(context.base.id, { name: context.base.name, vlm_config: vlmConfig });
        context.base.vlm_config = vlmConfig;
      }
    }
    appliedIdentity = identity;
  };

  const publicBaseUrl = (value) => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.href.replace(/\/+$/, '');
    } catch { return ''; }
  };

  const readModelConfiguration = async () => {
    const state = getState();
    if (!state.email || !state.password) return { status: 'unavailable', reason: 'account_unavailable' };
    let context;
    try { context = await inspect(); } catch { return { status: 'unavailable', reason: 'backend_not_ready' }; }
    const models = [];
    for (const purpose of ['embedding', 'rerank', 'vision']) {
      const model = currentModel(context, purpose);
      if (!model || purpose === 'vision' && !context.base.vlm_config?.enabled) continue;
      const dimensions = model.parameters?.embedding_parameters?.dimension;
      const configuration = {
        purpose, modelId: model.id, model: model.name,
        baseUrl: publicBaseUrl(model.parameters?.base_url),
        hasKey: Boolean(model.parameters?.api_key),
      };
      if (purpose === 'embedding' && dimensions !== undefined) configuration.dimensions = dimensions;
      models.push(configuration);
    }
    const unavailablePurposes = [];
    try {
      const parser = await context.client.getTenantParserConfig();
      if (parser.paddleocr_vl_cloud_token || parser.paddleocr_vl_cloud_model || parser.paddleocr_vl_cloud_base_url) {
        models.push({
          purpose: 'ocr', modelId: 'paddleocr_vl_cloud', model: parser.paddleocr_vl_cloud_model || 'PaddleOCR-VL-1.6',
          baseUrl: publicBaseUrl(parser.paddleocr_vl_cloud_base_url || 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs'),
          hasKey: Boolean(parser.paddleocr_vl_cloud_token),
        });
      }
    } catch { unavailablePurposes.push('ocr'); }
    return { status: 'available', models, unavailablePurposes };
  };

  const syncModelBindings = () => {
    if (!synchronizePromise) synchronizePromise = synchronize().finally(() => { synchronizePromise = null; });
    return synchronizePromise;
  };

  return { prepareModelBindingChange, syncModelBindings, readModelConfiguration, reset: () => { appliedIdentity = null; } };
}
