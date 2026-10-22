import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';

import { createEmbeddedKnowledgeClient } from './client.js';
import { KNOWLEDGE_BASE_NAME, provisionKnowledgeBackend } from './provision.js';

let server;
let baseUrl;
let calls;
let registered;
let paddleReady;

const respond = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  calls = [];
  registered = false;
  paddleReady = false;
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      calls.push({ method: req.method, url: req.url, body });

      if (req.url === '/api/v1/auth/login') {
        if (!registered) return respond(res, 401, { error: 'Unauthorized' });
        return respond(res, 200, { token: 'session-1', user: { tenant_id: 5 } });
      }
      if (req.url === '/api/v1/auth/register') {
        registered = true;
        return respond(res, 201, { success: true, user: { tenant_id: 5 } });
      }
      if (req.url === '/api/v1/models' && req.method === 'GET') return respond(res, 200, { data: [] });
      if (req.url === '/api/v1/models' && req.method === 'POST') {
        const ids = { Embedding: 'm-emb', Rerank: 'm-rerank', VLLM: 'm-vlm', ASR: 'm-asr' };
        return respond(res, 201, { data: { id: ids[body.type] ?? 'm-other', name: body.name, type: body.type } });
      }
      if (req.url === '/api/v1/knowledge-bases' && req.method === 'GET') return respond(res, 200, { data: [] });
      if (req.url === '/api/v1/knowledge-bases' && req.method === 'POST') {
        return respond(res, 201, { data: { id: 'kb-1', name: body.name } });
      }
      if (req.url === '/api/v1/system/parser-engines') {
        return respond(res, 200, {
          data: [
            { Name: 'anydoc', Available: true },
            { Name: 'paddleocr_vl_cloud', Available: paddleReady },
          ],
        });
      }
      if (req.url === '/api/v1/tenants/kv/parser-engine-config' && req.method === 'PUT') {
        paddleReady = true;
        return respond(res, 200, { success: true, data: body });
      }
      if (req.url === '/api/v1/knowledge-bases/kb-1' && req.method === 'PUT') {
        return respond(res, 200, { data: { id: 'kb-1', ...body } });
      }
      if (req.url === '/api/v1/tenants/5/api-keys') {
        return respond(res, 201, { data: { id: 1, api_key: 'display-id', token: 'runtime-token', capabilities: ['retrieve', 'ingest'] } });
      }
      return respond(res, 404, { error: 'unexpected ' + req.url });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

const run = (state, modelApiKey = 'sk-test', localDefaults = null, deepSeekApiKey) =>
  provisionKnowledgeBackend({
    createClient: (options = {}) => createEmbeddedKnowledgeClient({ baseUrl, ...options }),
    getState: () => state,
    saveState: (patch) => Object.assign(state, patch),
    modelApiKey,
    deepSeekApiKey,
    localDefaults,
  });

const localDefaults = {
  models: {
    embedding: {
      name: 'text-embedding-v4',
      displayName: 'text-embedding-v4（远程）',
      parameters: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: 'sk-local', embedding_parameters: { dimension: 1024 } },
    },
    rerank: {
      name: 'qwen3-rerank',
      displayName: '千问检索重排',
      parameters: { base_url: 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank', api_key: 'sk-local' },
    },
    vision: {
      name: 'qwen3.8-flash',
      displayName: '千问图片理解与 OCR',
      parameters: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: 'sk-local', supports_vision: true },
    },
    asr: {
      name: 'qwen3-asr-flash',
      displayName: '千问语音识别',
      parameters: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: 'sk-local' },
    },
  },
  parser: {
    chat_parser_engine_rules: [{ file_types: ['pdf', 'png'], engine: 'paddleocr_vl_cloud' }],
    paddleocr_vl_cloud_token: 'paddle-token',
    paddleocr_vl_cloud_model: 'PaddleOCR-VL-1.6',
  },
  knowledgeBase: {
    chunking: { chunk_size: 512, chunk_overlap: 80, separators: ['\n\n', '\n'] },
    imageProcessing: { image_actions: { ocr: { on: [{ prop: 'contain.text', is: 'block' }], on_unobserved: true } } },
  },
  importableModels: [
    { name: 'deepseek-flash', type: 'KnowledgeQA', displayName: 'deepseek-flash', parameters: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-local' } },
  ],
};

describe('provisioning', () => {
  it('registers, logs in, creates both models, the KB and a scoped key', async () => {
    const state = {};
    const result = await run(state);

    expect(result).toEqual({ tenantId: 5, knowledgeBaseId: 'kb-1', apiKey: 'runtime-token' });
    expect(state.apiKey).toBe('runtime-token');
    expect(state.embeddingModelId).toBe('m-emb');
    expect(state.rerankModelId).toBe('m-rerank');

    const modelCalls = calls.filter((call) => call.url === '/api/v1/models' && call.method === 'POST');
    expect(modelCalls.map((call) => call.body.type)).toEqual(['Embedding', 'Rerank']);
    expect(modelCalls[0].body.parameters.embedding_parameters.dimension).toBe(1024);
    expect(modelCalls[0].body.parameters.api_key).toBe('sk-test');

    const kbCall = calls.find((call) => call.url === '/api/v1/knowledge-bases' && call.method === 'POST');
    expect(kbCall.body).toEqual({ name: KNOWLEDGE_BASE_NAME, embedding_model_id: 'm-emb' });

    const keyCall = calls.find((call) => call.url === '/api/v1/tenants/5/api-keys');
    expect(keyCall.body).toMatchObject({ capabilities: ['retrieve', 'ingest'], knowledge_base_ids: ['kb-1'] });

    const parserCall = calls.find((call) => call.url === '/api/v1/knowledge-bases/kb-1' && call.method === 'PUT');
    expect(parserCall.body.config.chunking_config.parser_engine_rules).toEqual([
      { file_types: expect.arrayContaining(['pdf', 'docx', 'pptx']), engine: 'anydoc' },
    ]);
  });

  it('inherits the local installation models, parser plugins and chunking', async () => {
    const state = {};
    await run(state, '', localDefaults);

    const created = calls.filter((call) => call.url === '/api/v1/models' && call.method === 'POST').map((call) => call.body);
    expect(created.map((model) => model.type)).toEqual(['Embedding', 'Rerank', 'VLLM', 'ASR', 'KnowledgeQA']);
    expect(created.find((model) => model.type === 'VLLM')).toMatchObject({ name: 'deepseek-v4.1-flash' });
    expect(created.find((model) => model.type === 'VLLM').parameters.api_key).toBe('sk-local');

    const parserCall = calls.find((call) => call.url === '/api/v1/tenants/kv/parser-engine-config');
    expect(parserCall.body).toMatchObject({ paddleocr_vl_cloud_token: 'paddle-token' });

    const kbCall = calls.find((call) => call.url === '/api/v1/knowledge-bases/kb-1' && call.method === 'PUT');
    expect(kbCall.body.vlm_config).toMatchObject({ enabled: true, model_id: 'm-vlm' });
    expect(kbCall.body.config.chunking_config).toMatchObject({ chunk_size: 512, chunk_overlap: 80 });
    expect(kbCall.body.config.chunking_config.parser_engine_rules).toEqual([
      { file_types: ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'tiff'], engine: 'paddleocr_vl_cloud' },
      { file_types: expect.arrayContaining(['docx', 'pptx']), engine: 'anydoc' },
    ]);
    expect(kbCall.body.config.image_processing_config.model_id).toBe('m-vlm');
  });

  it('prefers a real DeepSeek key for the generation/vision model', async () => {
    const state = {};
    await run(state, 'sk-test', localDefaults, 'sk-deepseek');

    const vision = calls
      .filter((call) => call.url === '/api/v1/models' && call.method === 'POST')
      .map((call) => call.body)
      .find((model) => model.type === 'VLLM');
    expect(vision).toMatchObject({ name: 'deepseek-flash' });
    expect(vision.parameters).toMatchObject({
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-deepseek',
      provider: 'deepseek',
    });

    const kbCall = calls.find((call) => call.url === '/api/v1/knowledge-bases/kb-1' && call.method === 'PUT');
    expect(kbCall.body.vlm_config.model_id).toBe('m-vlm');
  });

  it('uses the returned token, not the display api_key', async () => {
    const state = {};
    const result = await run(state);
    expect(result.apiKey).not.toBe('display-id');
    expect(result.apiKey).toBe('runtime-token');
  });

  it('does nothing on a second run once provisioned', async () => {
    const state = {};
    await run(state);
    const afterFirst = calls.length;
    await run(state);
    expect(calls.length).toBe(afterFirst);
  });

  it('refuses to start without a model key', async () => {
    await expect(run({}, '')).rejects.toMatchObject({ code: 'provision_key_missing' });
  });

  it('reports an account the backend refuses', async () => {
    registered = true; // login succeeds, so make the tenant missing instead
    const failing = await new Promise((resolve) => {
      const s = http.createServer((req, res) => respond(res, 200, { token: 'x', user: {} })).listen(0, '127.0.0.1', () => resolve(s));
    });
    const state = { email: 'a@b.c', password: 'pw' };
    await expect(
      provisionKnowledgeBackend({
        createClient: (options = {}) => createEmbeddedKnowledgeClient({ baseUrl: `http://127.0.0.1:${failing.address().port}`, ...options }),
        getState: () => state,
        saveState: (patch) => Object.assign(state, patch),
        modelApiKey: 'sk-test',
      }),
    ).rejects.toMatchObject({ code: 'provision_account_failed' });
    await new Promise((resolve) => failing.close(resolve));
  });
});
