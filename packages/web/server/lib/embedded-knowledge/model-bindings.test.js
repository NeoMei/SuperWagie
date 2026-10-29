import { describe, expect, it } from 'vitest';
import { createKnowledgeModelBindings } from './model-bindings.js';

function setup({ documents = {}, dimensions = 1024 } = {}) {
  const changes = [];
  let binding = { purpose: 'embedding', protocol: 'openai-compatible', baseUrl: 'https://embedding.example/v1', model: 'existing-embedding', apiKey: 'selected-key', parameters: { dimensions }, revision: 1 };
  const models = [{ id: 'emb-1', name: 'existing-embedding', type: 'Embedding', parameters: { base_url: 'https://embedding.example/v1', api_key: 'old-key', embedding_parameters: { dimension: 1024 }, extra: 'retained' } }];
  const client = {
    login: async () => ({ token: 'local-account' }),
    listModels: async () => models,
    listKnowledge: async () => ({ total: 0 }),
    getKnowledgeBase: async () => ({ id: 'kb-1', name: 'Existing library', embedding_model_id: 'emb-1' }),
    updateModel: async (id, model) => { changes.push({ id, model }); Object.assign(models.find((item) => item.id === id), model); },
  };
  const runtime = createKnowledgeModelBindings({
    createClient: () => client,
    getState: () => ({ email: 'local@example.invalid', password: 'local-password', knowledgeBaseId: 'kb-1' }),
    readDocuments: async () => documents,
    resolveModelBinding: async (purpose) => purpose === 'embedding' ? binding : null,
  });
  return { runtime, changes, setBinding: (value) => { binding = value; }, binding };
}

describe('knowledge model binding consumption', () => {
  it('rotates a selected key on the existing model record without changing index dimensions or IDs', async () => {
    const { runtime, changes } = setup({ documents: { a: { knowledgeId: 'document-1', state: 'ready' } } });
    await runtime.syncModelBindings();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: 'emb-1', model: { name: 'existing-embedding', parameters: { api_key: 'selected-key', base_url: 'https://embedding.example/v1', embedding_parameters: { dimension: 1024 }, extra: 'retained' } } });
    await runtime.syncModelBindings();
    expect(changes).toHaveLength(1);
  });

  it('applies native credential rotation even when the model configuration revision is unchanged', async () => {
    const { runtime, changes, binding, setBinding } = setup({ documents: { a: { knowledgeId: 'document-1', state: 'ready' } } });
    await runtime.syncModelBindings();
    setBinding({ ...binding, apiKey: 'native-rotated-key' });
    await runtime.syncModelBindings();
    expect(changes).toHaveLength(2);
    expect(changes[1].model.parameters.api_key).toBe('native-rotated-key');
  });

  it('preserves a newly attached vision model when OCR is applied in the same synchronization', async () => {
    let base = { id: 'kb-1', name: 'Library', vlm_config: { enabled: false, model_id: '' }, chunking_config: { parser_engine_rules: [] } };
    const client = {
      login: async () => ({ token: 'local-account' }),
      listModels: async () => [],
      getKnowledgeBase: async () => base,
      createModel: async (model) => ({ ...model, id: 'new-vision' }),
      getTenantParserConfig: async () => ({}),
      updateTenantParserConfig: async () => {},
      listParserEngines: async () => [{ Name: 'paddleocr_vl_cloud', Available: true }],
      updateKnowledgeBase: async (id, patch) => { base = { ...base, ...patch }; },
    };
    const runtime = createKnowledgeModelBindings({
      createClient: () => client,
      getState: () => ({ email: 'local@example.invalid', password: 'local-password', knowledgeBaseId: 'kb-1' }),
      readDocuments: async () => ({}),
      resolveModelBinding: async (purpose) => ['vision', 'ocr'].includes(purpose) ? { purpose, revision: 1, protocol: purpose === 'ocr' ? 'paddleocr' : 'openai-compatible', baseUrl: 'https://provider.example/v1', model: `${purpose}-model`, apiKey: 'fixture-key', parameters: {} } : null,
    });
    await runtime.syncModelBindings();
    expect(base.vlm_config).toEqual({ enabled: true, model_id: 'new-vision' });
    expect(base.config.chunking_config.parser_engine_rules[0].engine).toBe('paddleocr_vl_cloud');
  });

  it('refuses replacing an indexed embedding model before saving or calling update', async () => {
    const { runtime, changes, binding } = setup({ documents: { a: { knowledgeId: 'document-1', state: 'ready' } } });
    await expect(runtime.prepareModelBindingChange('embedding', { ...binding, model: 'new-embedding' })).rejects.toMatchObject({ code: 'model_configuration_embedding_rebuild_required' });
    expect(changes).toHaveLength(0);
  });

  it('refuses an OCR binding before save when the provisioned backend has no registered parser adapter', async () => {
    let writes = 0;
    const runtime = createKnowledgeModelBindings({
      createClient: () => ({ login: async () => ({ token: 'session' }), listModels: async () => [], getKnowledgeBase: async () => ({ id: 'kb-1', name: 'Library' }), listParserEngines: async () => [{ Name: 'anydoc', Available: true }], updateTenantParserConfig: async () => { writes += 1; } }),
      getState: () => ({ email: 'local@example.invalid', password: 'local-password', knowledgeBaseId: 'kb-1' }),
      readDocuments: async () => ({}), resolveModelBinding: async () => null,
    });
    await expect(runtime.prepareModelBindingChange('ocr', { protocol: 'paddleocr' })).rejects.toMatchObject({ code: 'model_configuration_ocr_unavailable' });
    expect(writes).toBe(0);
  });

  it('allows a registered OCR parser that awaits its token and allows unprovisioned setup without cloud calls', async () => {
    const client = { login: async () => ({ token: 'session' }), listModels: async () => [], getKnowledgeBase: async () => ({ id: 'kb-1', name: 'Library' }), listParserEngines: async () => [{ Name: 'paddleocr_vl_cloud', Available: false }] };
    const runtime = createKnowledgeModelBindings({ createClient: () => client, getState: () => ({ email: 'local@example.invalid', password: 'local-password', knowledgeBaseId: 'kb-1' }), readDocuments: async () => ({}), resolveModelBinding: async () => null });
    await expect(runtime.prepareModelBindingChange('ocr', { protocol: 'paddleocr' })).resolves.toBeUndefined();
    const fresh = createKnowledgeModelBindings({ createClient: () => { throw new Error('must not query unprovisioned backend'); }, getState: () => ({}), readDocuments: async () => ({}), resolveModelBinding: async () => null });
    await expect(fresh.prepareModelBindingChange('ocr', { protocol: 'paddleocr' })).resolves.toBeUndefined();
    await expect(fresh.prepareModelBindingChange('vision', { protocol: 'openai-compatible' })).resolves.toBeUndefined();
    await expect(fresh.prepareModelBindingChange('vision', { protocol: 'anthropic' })).rejects.toMatchObject({ code: 'model_configuration_unsupported_protocol' });
  });

  it('refuses unsupported missing-embedding recovery instead of creating an orphan model', async () => {
    let creates = 0;
    const runtime = createKnowledgeModelBindings({
      createClient: () => ({
        login: async () => ({ token: 'local-account' }), listModels: async () => [],
        getKnowledgeBase: async () => ({ id: 'kb-1', name: 'Library', embedding_model_id: 'missing-record' }),
        createModel: async () => { creates += 1; },
      }),
      getState: () => ({ email: 'local@example.invalid', password: 'local-password', knowledgeBaseId: 'kb-1' }),
      readDocuments: async () => ({}),
      resolveModelBinding: async (purpose) => purpose === 'embedding' ? { purpose, protocol: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'new-model', apiKey: 'fixture-key', parameters: {} } : null,
    });
    await expect(runtime.syncModelBindings()).rejects.toMatchObject({ code: 'model_configuration_knowledge_not_ready' });
    expect(creates).toBe(0);
  });

  it('refuses changing indexed embedding dimensions and rechecks at actual invocation', async () => {
    const { runtime, changes } = setup({ documents: { a: { knowledgeId: 'document-1', state: 'ready' } }, dimensions: 1536 });
    await expect(runtime.syncModelBindings()).rejects.toMatchObject({ code: 'model_configuration_embedding_rebuild_required' });
    expect(changes).toHaveLength(0);
  });

  it('uses an explicitly changed model and endpoint on an empty library and re-reads key rotation', async () => {
    const { runtime, changes, binding, setBinding } = setup();
    setBinding({ ...binding, baseUrl: 'https://new.example/v1', model: 'new-model' });
    await runtime.syncModelBindings();
    expect(changes[0]).toMatchObject({ id: 'emb-1', model: { name: 'new-model', parameters: { base_url: 'https://new.example/v1' } } });
    setBinding({ ...binding, revision: 2, baseUrl: 'https://new.example/v1', model: 'new-model', apiKey: 'rotated-key' });
    await runtime.syncModelBindings();
    expect(changes[1].model.parameters.api_key).toBe('rotated-key');
  });

  it('applies the saved PaddleOCR jobs endpoint, model and token to parser configuration without removing other parser rules', async () => {
    const updates = [];
    const parser = { anydoc_timeout: 90, paddleocr_vl_cloud_use_chart_recognition: true };
    const client = {
      login: async () => ({ token: 'local-account' }),
      listModels: async () => [],
      getKnowledgeBase: async () => ({ id: 'kb-1', name: 'Library', chunking_config: { chunk_size: 512, parser_engine_rules: [{ file_types: ['pdf', 'docx'], engine: 'anydoc' }] } }),
      getTenantParserConfig: async () => parser,
      updateTenantParserConfig: async (config) => updates.push(config),
      listParserEngines: async () => [{ Name: 'paddleocr_vl_cloud', Available: true }],
      updateKnowledgeBase: async (id, body) => updates.push({ id, body }),
    };
    const runtime = createKnowledgeModelBindings({
      createClient: () => client,
      getState: () => ({ email: 'local@example.invalid', password: 'local-password', knowledgeBaseId: 'kb-1' }),
      readDocuments: async () => ({}),
      resolveModelBinding: async (purpose) => purpose === 'ocr' ? { purpose, revision: 1, protocol: 'paddleocr', baseUrl: 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs', model: 'PaddleOCR-VL-1.6', apiKey: 'selected-ocr-token', parameters: {} } : null,
    });
    await runtime.syncModelBindings();
    expect(updates[0]).toEqual({ ...parser, paddleocr_vl_cloud_token: 'selected-ocr-token', paddleocr_vl_cloud_base_url: 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs', paddleocr_vl_cloud_model: 'PaddleOCR-VL-1.6' });
    expect(updates[1]).toMatchObject({ id: 'kb-1', body: { config: { chunking_config: { chunk_size: 512, parser_engine_rules: [{ file_types: ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'tiff'], engine: 'paddleocr_vl_cloud' }, { file_types: ['docx'], engine: 'anydoc' }] } } } });
  });

  it('projects actual legacy model metadata without exposing keys or URL credentials', async () => {
    const client = {
      login: async () => ({ token: 'local-account' }),
      listModels: async () => [{ id: 'legacy-embedding-id', name: 'legacy-embedding', type: 'Embedding', parameters: { base_url: 'https://username:password@provider.example/v1?api_key=private-url-key#secret', api_key: 'private-model-key', embedding_parameters: { dimension: 1024 } } }],
      getKnowledgeBase: async () => ({ id: 'kb-1', name: 'Existing library', embedding_model_id: 'legacy-embedding-id' }),
      getTenantParserConfig: async () => ({ paddleocr_vl_cloud_token: 'private-parser-key', paddleocr_vl_cloud_model: 'PaddleOCR-VL-1.6' }),
    };
    const runtime = createKnowledgeModelBindings({
      createClient: () => client,
      getState: () => ({ email: 'local@example.invalid', password: 'private-account-password', knowledgeBaseId: 'kb-1' }),
      readDocuments: async () => ({}),
      resolveModelBinding: async () => null,
    });
    const configuration = await runtime.readModelConfiguration();
    expect(configuration).toMatchObject({ status: 'available', models: [{ purpose: 'embedding', modelId: 'legacy-embedding-id', model: 'legacy-embedding', baseUrl: 'https://provider.example/v1', dimensions: 1024, hasKey: true }, { purpose: 'ocr', model: 'PaddleOCR-VL-1.6', hasKey: true }] });
    const publicText = JSON.stringify(configuration);
    for (const secret of ['username', 'password', 'private-url-key', 'private-model-key', 'private-parser-key', 'private-account-password', 'local-account']) expect(publicText).not.toContain(secret);
  });

  it('reports an unavailable projection after a backend failure instead of a valid empty configuration', async () => {
    const runtime = createKnowledgeModelBindings({
      createClient: () => ({ login: async () => { throw new Error('unavailable'); } }),
      getState: () => ({ email: 'local@example.invalid', password: 'local-password', knowledgeBaseId: 'kb-1' }),
      readDocuments: async () => ({}), resolveModelBinding: async () => null,
    });
    expect(await runtime.readModelConfiguration()).toEqual({ status: 'unavailable', reason: 'backend_not_ready' });
  });

  it('does not touch existing models when no binding was selected', async () => {
    const { runtime, changes, setBinding } = setup();
    setBinding(null);
    await runtime.syncModelBindings();
    expect(changes).toHaveLength(0);
  });

  it('injects only a matching loopback managed capability and refuses it without an active scope', async () => {
    const selected = { purpose: 'vision', protocol: 'managed-media', model: 'vision-model', parameters: {} };
    const writes = [];
    let scoped = { ...selected, baseUrl: 'http://127.0.0.1:43210/v1', apiKey: 'scoped-token' };
    const client = {
      login: async () => ({ token: 'session' }), listModels: async () => [],
      getKnowledgeBase: async () => ({ id: 'kb-1', name: 'Library' }),
      createModel: async (model) => { writes.push(model); return { ...model, id: 'vision-id' }; },
      updateKnowledgeBase: async () => {},
    };
    const options = { createClient: () => client, getState: () => ({ email: 'local', password: 'private', knowledgeBaseId: 'kb-1' }), readDocuments: async () => ({}), resolveModelBinding: async (purpose) => purpose === 'vision' ? selected : null };
    const unavailable = createKnowledgeModelBindings(options);
    await expect(unavailable.syncModelBindings()).rejects.toMatchObject({ code: 'model_configuration_managed_unavailable' });
    const runtime = createKnowledgeModelBindings({ ...options, resolveManagedBinding: async () => scoped });
    await runtime.syncModelBindings();
    expect(writes[0]).toMatchObject({ name: selected.model, parameters: { provider: 'openai', base_url: scoped.baseUrl, api_key: scoped.apiKey } });
    runtime.reset();
    scoped = { ...scoped, baseUrl: 'http://127.0.0.1:43210/admin' };
    await expect(runtime.syncModelBindings()).rejects.toMatchObject({ code: 'model_configuration_managed_unavailable' });
    expect(writes).toHaveLength(1);
  });
});
