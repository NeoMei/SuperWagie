/**
 * First-run provisioning of the bundled embedded knowledge backend.
 *
 * A fresh backend ships with no account, no models and no knowledge base. This
 * module creates exactly what the product needs, once: a local account, the
 * embedding and rerank models built from the single remote key the user
 * provides, one knowledge base, and an API key restricted to it. Every step
 * checks for its artefact first, so a retry after a crash or a restart never
 * duplicates anything.
 *
 * When a local WeKnora Lite installation exists, its model and parser choices
 * become the defaults instead (see ./local-defaults.js): vision and ASR models,
 * PaddleOCR-VL Cloud for scanned PDFs, and anydoc for Office files.
 *
 * Verified against upstream v0.8.3: registration creates a tenant but returns no
 * token (login follows), model creation does not validate the remote key, and
 * the API key's usable credential is the response's `token` field.
 */

import crypto from 'node:crypto';

import { readLocalDefaults } from './local-defaults.js';

export const KNOWLEDGE_BASE_NAME = 'SuperWagie 资料库';

// Bumped when the defaults applied to an already-provisioned backend change.
// The version lets an existing install pick up new defaults once.
export const DEFAULTS_VERSION = 7;

const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const EMBEDDING_MODEL = { name: 'text-embedding-v4', type: 'Embedding', dimension: 1024 };
const RERANK_MODEL = { name: 'qwen3-rerank', type: 'Rerank' };
// SuperWagie runs on DeepSeek V4.1 Flash. DashScope serves it with image
// input, so it replaces the Qwen vision model for image descriptions; OCR of
// documents still belongs to PaddleOCR.
const VISION_MODEL = { name: 'deepseek-v4.1-flash', type: 'VLLM' };
const ASR_MODEL = { name: 'qwen3-asr-flash', type: 'ASR' };

const PDF_IMAGE_TYPES = ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'tiff'];
// Formats anydoc converts without OCR.
const ANYDOC_TYPES = ['doc', 'docm', 'docx', 'xls', 'xlsm', 'xlsx', 'ppt', 'pptm', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub', 'csv'];

export class ProvisionError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
    this.cause = cause;
  }
}

const generateCredentials = () => ({
  email: `superwagie-${crypto.randomUUID()}@local.superwagie`,
  password: `${crypto.randomBytes(18).toString('base64url')}Aa1!`,
});

const asArray = (value) => (Array.isArray(value) ? value : []);

const ensureModel = async (client, { name, type, displayName, parameters, description }) => {
  const existing = asArray(await client.listModels()).find((model) => model?.name === name && model?.type === type);
  if (existing?.id) return existing.id;

  const created = await client.createModel({
    name,
    display_name: displayName ?? name,
    type,
    source: 'remote',
    description,
    parameters,
  });
  if (!created?.id) throw new ProvisionError('provision_model_failed', `The backend did not create the ${type} model`);
  return created.id;
};

const ensureKnowledgeBase = async (client, embeddingModelId) => {
  const existing = asArray(await client.listKnowledgeBases()).find((kb) => kb?.name === KNOWLEDGE_BASE_NAME);
  if (existing?.id) return existing.id;

  const created = await client.createKnowledgeBase({ name: KNOWLEDGE_BASE_NAME, embeddingModelId });
  if (!created?.id) throw new ProvisionError('provision_kb_failed', 'The backend did not create the knowledge base');
  return created.id;
};

/**
 * Applies the parser and indexing defaults to the knowledge base:
 * - PDF and images go to PaddleOCR-VL Cloud when a token is configured, so
 *   scanned pages are read instead of rejected; otherwise anydoc gets them.
 * - Office documents always go to the in-process anydoc engine. The built-in
 *   simple engine cannot read them and docreader is not part of the desktop app.
 * - The vision model describes images, and chunking follows the local setup.
 */
const applyKnowledgeBaseDefaults = async (client, { knowledgeBaseId, defaults, visionModelId }) => {
  let engines = [];
  try {
    engines = asArray(await client.listParserEngines());
  } catch {
    engines = [];
  }
  const paddleAvailable = engines.some((engine) => engine?.Name === 'paddleocr_vl_cloud' && engine?.Available);

  const rules = [];
  if (paddleAvailable) rules.push({ file_types: PDF_IMAGE_TYPES, engine: 'paddleocr_vl_cloud' });
  rules.push({
    file_types: paddleAvailable ? ANYDOC_TYPES : [...PDF_IMAGE_TYPES, ...ANYDOC_TYPES],
    engine: 'anydoc',
  });

  const chunking = defaults?.knowledgeBase?.chunking ?? { chunk_size: 0, chunk_overlap: 0, separators: null };
  const imageProcessing = defaults?.knowledgeBase?.imageProcessing;
  const config = {
    chunking_config: {
      chunk_size: chunking.chunk_size ?? 0,
      chunk_overlap: chunking.chunk_overlap ?? 0,
      separators: chunking.separators ?? null,
      parser_engine_rules: rules,
    },
    indexing_strategy: { vector_enabled: true, keyword_enabled: true, wiki_enabled: false, graph_enabled: false },
  };
  if (visionModelId && imageProcessing) {
    config.image_processing_config = { model_id: visionModelId };
    if (imageProcessing.image_actions) config.image_processing_config.image_actions = imageProcessing.image_actions;
  }

  const payload = { name: KNOWLEDGE_BASE_NAME, description: '', config };
  if (visionModelId) {
    payload.vlm_config = { enabled: true, model_id: visionModelId, description_language: 'zh' };
  }
  await client.updateKnowledgeBase(knowledgeBaseId, payload);
};

const loginOrRegister = async (client, credentials) => {
  try {
    return await client.login(credentials.email, credentials.password);
  } catch (error) {
    if (error?.code !== 'unauthorized') throw error;
    // The username is unique per account: WeKnora enforces it globally, and a
    // retry after a half-finished setup must not collide with the orphan
    // account the previous attempt created.
    await client.register({
      email: credentials.email,
      password: credentials.password,
      username: `SuperWagie-${crypto.randomUUID().slice(0, 8)}`,
    });
    return client.login(credentials.email, credentials.password);
  }
};

export async function provisionKnowledgeBackend({
  createClient,
  getState,
  saveState,
  modelApiKey,
  deepSeekApiKey,
  localDefaults,
  modelBindings = {},
  parserConfiguration,
} = {}) {
  const state = { ...getState() };
  if (state.apiKey && state.knowledgeBaseId && state.defaultsVersion === DEFAULTS_VERSION) {
    return { tenantId: state.tenantId, knowledgeBaseId: state.knowledgeBaseId, apiKey: state.apiKey };
  }

  const defaults = localDefaults === undefined ? readLocalDefaults() : localDefaults;
  const local = { ...defaults?.models, ...modelBindings };
  if (!modelApiKey && !local.embedding) {
    throw new ProvisionError('provision_key_missing', 'An embedding model key is required');
  }

  if (!state.email || !state.password) {
    Object.assign(state, generateCredentials());
    await saveState({ email: state.email, password: state.password });
  }

  let session;
  try {
    session = await loginOrRegister(createClient(), { email: state.email, password: state.password });
  } catch (error) {
    throw new ProvisionError('provision_account_failed', 'The backend denied the local account', { cause: error });
  }
  const tenantId = session?.user?.tenant_id;
  if (!tenantId) throw new ProvisionError('provision_account_failed', 'The backend returned no tenant for the local account');
  await saveState({ tenantId });

  const client = createClient({ sessionToken: session.token });

  const embeddingSpec = {
    ...EMBEDDING_MODEL,
    description: 'SuperWagie embedding',
    parameters: local.embedding?.parameters ?? {
      base_url: DASHSCOPE_BASE_URL,
      api_key: modelApiKey,
      embedding_parameters: { dimension: EMBEDDING_MODEL.dimension },
    },
  };
  if (local.embedding) {
    embeddingSpec.name = local.embedding.name;
    embeddingSpec.displayName = local.embedding.displayName;
  }
  const embeddingModelId = await ensureModel(client, embeddingSpec);

  const rerankSpec = {
    ...RERANK_MODEL,
    description: 'SuperWagie rerank',
    parameters: local.rerank?.parameters ?? { base_url: DASHSCOPE_BASE_URL, api_key: modelApiKey },
  };
  if (local.rerank) {
    rerankSpec.name = local.rerank.name;
    rerankSpec.displayName = local.rerank.displayName;
  }
  const rerankModelId = modelBindings.embedding && !local.rerank
    ? null
    : await ensureModel(client, rerankSpec);

  // The DashScope key already imported for the other qwen models also serves
  // DeepSeek V4.1 Flash. Without one, fall back to the local vision model.
  const dashscopeKey = [local.embedding, local.rerank, local.vision, local.asr]
    .find((model) => String(model?.parameters?.base_url ?? '').includes('dashscope.aliyuncs.com'))
    ?.parameters?.api_key;

  const visionModelId = deepSeekApiKey
    ? await ensureModel(client, {
        ...VISION_MODEL,
        name: 'deepseek-flash',
        displayName: 'DeepSeek V4.1 Flash',
        description: 'SuperWagie image understanding',
        parameters: {
          base_url: DEEPSEEK_BASE_URL,
          api_key: deepSeekApiKey,
          provider: 'deepseek',
          supports_vision: true,
          extra_config: { thinking_control: 'off' },
        },
      })
    : dashscopeKey
    ? await ensureModel(client, {
        ...VISION_MODEL,
        displayName: 'DeepSeek V4.1 Flash',
        description: 'SuperWagie image understanding',
        parameters: {
          base_url: DASHSCOPE_BASE_URL,
          api_key: dashscopeKey,
          provider: 'aliyun',
          supports_vision: true,
          extra_config: { thinking_control: 'off' },
        },
      })
    : local.vision
      ? await ensureModel(client, {
          ...VISION_MODEL,
          name: local.vision.name,
          displayName: local.vision.displayName,
          description: 'SuperWagie image understanding',
          // The KB only accepts a VLLM-typed record for vlm_config.
          type: VISION_MODEL.type,
          parameters: {
            ...local.vision.parameters,
            extra_config: { ...(local.vision.parameters.extra_config ?? {}), thinking_control: 'off' },
          },
        })
      : null;

  const asrModelId = local.asr
    ? await ensureModel(client, {
        ...ASR_MODEL,
        name: local.asr.name,
        displayName: local.asr.displayName,
        description: 'SuperWagie speech recognition',
        parameters: local.asr.parameters,
      })
    : null;

  // Import the remaining local models (chat models and image embedding) so the
  // backend mirrors the other installation, not only the search pipeline.
  for (const model of defaults?.importableModels ?? []) {
    // Extra models are a convenience, never a reason to fail provisioning.
    await ensureModel(client, {
      name: model.name,
      type: model.type,
      displayName: model.displayName,
      description: 'Imported from the local knowledge installation',
      parameters: model.parameters,
    }).catch(() => null);
  }

  const knowledgeBaseId = await ensureKnowledgeBase(client, embeddingModelId);

  if (parserConfiguration || defaults?.parser) {
    await client.updateTenantParserConfig({ ...defaults?.parser, ...parserConfiguration });
  }
  await applyKnowledgeBaseDefaults(client, { knowledgeBaseId, defaults, visionModelId });

  let apiKey = state.apiKey;
  if (!apiKey) {
    const created = await client.createApiKey(tenantId, {
      name: 'superwagie-runtime',
      capabilities: ['retrieve', 'ingest'],
      knowledgeBaseIds: [knowledgeBaseId],
    });
    if (!created?.apiKey) throw new ProvisionError('provision_key_failed', 'The backend did not return an API key');
    apiKey = created.apiKey;
  }

  await saveState({
    tenantId,
    knowledgeBaseId,
    apiKey,
    embeddingModelId,
    rerankModelId,
    visionModelId,
    asrModelId,
    defaultsVersion: DEFAULTS_VERSION,
  });
  return { tenantId, knowledgeBaseId, apiKey };
}
