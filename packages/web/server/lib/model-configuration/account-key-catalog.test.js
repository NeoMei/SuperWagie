import { describe, expect, it } from 'vitest';
import { readAccountKeyCatalog } from './account-key-catalog.js';

const operation = (id, endpoint, changes = {}) => ({ id, endpoint, protocol: 'openai', method: 'POST', transports: ['json'], available: true, executable: true, limits: { max_body_bytes: 1024, max_quantity: 1, policy: 'provider_reported_v1', provider_unit_cap: '1', provider_unit: 'request' }, ...changes });
const model = (id, operations, capabilities = {}) => ({ id, object: 'model', created: 0, owned_by: 'unihub', capability_metadata: { id, name: id, capabilities, supports_tools: false, supports_reasoning_summary: false, operations } });
const catalog = (data) => ({ object: 'list', data, schemaVersion: 1, catalog_version: 'fixture-version' });
const request = (fetchImpl, changes = {}) => readAccountKeyCatalog({ apiKey: 'fixture-key', baseUrl: 'https://llmrouter.quukk.com/v1', instanceId: 'fixture-instance', assertCurrent: () => {}, fetchImpl, ...changes });

describe('account key executable catalog', () => {
  it('retains the native Bailian operation only for the exact gateway contract', async () => {
    const speech = operation('bailian.audio.speech.create', '/v1/native/bailian/audio/speech', { protocol: 'bailian', transports: ['binary'] });
    const result = await request(async () => Response.json(catalog([
      model('native', [speech]),
      model('wrong-path', [{ ...speech, endpoint: '/v1/audio/speech' }]),
      model('wrong-protocol', [{ ...speech, protocol: 'openai' }]),
      model('wrong-transport', [{ ...speech, transports: ['json'] }]),
      model('denied', [{ ...speech, executable: false, disabled_reason: 'operation_not_authorized' }]),
    ])));
    expect(result[0]).toMatchObject({ operations: ['speech'], speechOperation: 'bailian.audio.speech.create' });
    expect(result.slice(1).every((entry) => entry.operations.length === 0 && entry.speechOperation === undefined)).toBe(true);
  });
  it('retains the actual Responses, Claude and Gemini protocols for native chat registration', async () => {
    const result = await request(async () => Response.json(catalog([
      model('responses', [operation('responses.create', '/v1/responses')]),
      model('claude', [operation('claude.messages.create', '/v1/messages', { protocol: 'claude' })]),
      model('gemini', [operation('gemini.generate', '/v1beta/models/gemini:generateContent', { protocol: 'gemini' })]),
    ])));
    expect(result.map(({ operations }) => operations)).toEqual([['responses'], ['claude'], ['gemini']]);
  });
  it('probes a supported operation whose authorization is unknown without treating it as denied', async () => {
    const result = await request(async () => Response.json(catalog([
      model('unknown', [operation('embeddings.create', '/v1/embeddings', { executable: false, disabled_reason: 'operation_authorization_unknown' })]),
      model('denied', [operation('embeddings.create', '/v1/embeddings', { executable: false, disabled_reason: 'operation_not_authorized' })]),
    ])));
    expect(result.map(({ id, operations }) => ({ id, operations }))).toEqual([{ id: 'unknown', operations: ['embedding'] }, { id: 'denied', operations: [] }]);
  });
  it('uses the key-scoped inference catalog and projects only supported executable operations', async () => {
    const calls = [];
    const result = await request(async (url, init) => {
      calls.push({ url, init });
      return Response.json(catalog([
        model('chat-image', [operation('chat.completions.create', '/v1/chat/completions')], { input_modalities: ['text', 'image'], operations: ['chat.completions.create'] }),
        model('embed', [operation('embeddings.create', '/v1/embeddings')], { embedding_space: { provider: 'supplier', model: 'embedding', version: 'v1', dimensions: 1024, input_semantics: 'text' } }),
        model('ocr', [operation('ocr.jobs.create', '/v1/ocr', { protocol: 'paddleocr_jobs', transports: ['async_job'] })], { input_modalities: ['image'] }),
        model('denied', [operation('images.generations.create', '/v1/images/generations', { executable: false })]),
        model('unavailable', [operation('rerank.create', '/v1/rerank', { available: false })]),
        { id: 'no-metadata', object: 'model', created: 0, owned_by: 'unihub', disabled_reason: 'capability_metadata_unavailable' },
      ]));
    });
    expect(result).toEqual([
      { id: 'chat-image', name: 'chat-image', capabilitiesKnown: true, operations: ['chat'], input_modalities: ['text', 'image'] },
      { id: 'embed', name: 'embed', capabilitiesKnown: true, operations: ['embedding'], dimensions: 1024 },
      { id: 'ocr', name: 'ocr', capabilitiesKnown: true, operations: ['ocr'], input_modalities: ['image'] },
      { id: 'denied', name: 'denied', capabilitiesKnown: true, operations: [] },
      { id: 'unavailable', name: 'unavailable', capabilitiesKnown: true, operations: [] },
      { id: 'no-metadata', name: 'no-metadata', capabilitiesKnown: false, operations: [] },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://llmrouter.quukk.com/v1/models');
    expect(calls[0].init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer fixture-key', 'X-UniHub-Product': 'superwagie', 'X-UniHub-Instance': 'fixture-instance' } });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain('fixture-key');
  });

  it('does not infer protocol support or aliases from names and billing metadata', async () => {
    const result = await request(async () => Response.json(catalog([
      model('looks-like-vision', [operation('chat.completions.create', '/wrong-path'), operation('claude.messages.create', '/v1/messages', { protocol: 'claude', billing_operation: 'chat' })], { input_modalities: ['image'] }),
      model('native-image', [operation('dashscope.images.generate', '/v1/native/dashscope/images/generations', { protocol: 'dashscope', billing_operation: 'image_generation' })]),
    ])));
    expect(result).toEqual([{ id: 'looks-like-vision', name: 'looks-like-vision', capabilitiesKnown: true, operations: ['claude'], input_modalities: ['image'] }, { id: 'native-image', name: 'native-image', capabilitiesKnown: true, operations: [] }]);
  });

  it.each([
    catalog([model('m', [operation('chat.completions.create', '/v1/chat/completions', { executable: 'true' })])]),
    catalog([model('m', [], { input_modalities: 'image' })]),
    catalog([model('m', [], { embedding_space: { dimensions: 0 } })]),
    catalog([{ ...model('m', []), capability_metadata: { ...model('other', []).capability_metadata } }]),
    catalog([model('m', []), model('m', [])]),
    { object: 'list', data: null },
  ])('refuses malformed or ambiguous catalog data', async (payload) => {
    await expect(request(async () => Response.json(payload))).rejects.toMatchObject({ code: 'model_configuration_account_catalog_invalid' });
  });

  it('strips unrecognized metadata without exposing credentials or pretending it grants access', async () => {
    const entry = model('m', []);
    entry.apiKey = 'private-fixture';
    entry.capability_metadata.secret = 'private-fixture';
    entry.capability_metadata.aliases = ['guessed-alias'];
    expect(await request(async () => Response.json(catalog([entry])))).toEqual([{ id: 'm', name: 'm', capabilitiesKnown: true, operations: [] }]);
  });

  it('distinguishes old model lists with no metadata from explicit current denials', async () => {
    const result = await request(async () => Response.json({ object: 'list', data: [
      { id: 'old-chat', object: 'model', created: 0, owned_by: 'unihub' },
      model('known-denied', [operation('chat.completions.create', '/v1/chat/completions', { executable: false })]),
    ] }));
    expect(result).toEqual([
      { id: 'old-chat', name: 'old-chat', capabilitiesKnown: false, operations: [] },
      { id: 'known-denied', name: 'known-denied', capabilitiesKnown: true, operations: [] },
    ]);
  });

  it.each([401, 403, 500])('keeps HTTP %s errors explicit and excludes their raw body', async (status) => {
    let calls = 0;
    await expect(request(async () => { calls += 1; return new Response('private-fixture', { status }); })).rejects.toMatchObject({ code: `model_configuration_provider_http_${status}` });
    expect(calls).toBe(1);
  });

  it('does not retry a network error or expose its message', async () => {
    let calls = 0;
    await expect(request(async () => { calls += 1; throw new Error('private-fixture'); })).rejects.toMatchObject({ message: 'model_configuration_account_catalog_unavailable' });
    expect(calls).toBe(1);
  });

  it('rejects enterprise policy before sending the key', async () => {
    let calls = 0;
    await expect(request(async () => { calls += 1; return Response.json(catalog([])); }, { enterpriseOptions: { env: { OPENCHAMBER_ENTERPRISE_MODE: '1' }, policyFilePaths: [] } })).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(calls).toBe(0);
  });

  it('rejects a stale owner after reading the response', async () => {
    let current = true;
    await expect(request(async () => { current = false; return Response.json(catalog([])); }, { assertCurrent: () => { if (!current) throw Object.assign(new Error('stale'), { code: 'platform_account_session_changed' }); } })).rejects.toMatchObject({ code: 'platform_account_session_changed' });
  });

  it('rejects a destination that differs from the configured inference service', async () => {
    let calls = 0;
    await expect(request(async () => { calls += 1; return Response.json(catalog([])); }, { baseUrl: 'https://foreign.example/v1' })).rejects.toMatchObject({ code: 'model_configuration_bootstrap_endpoint_invalid' });
    expect(calls).toBe(0);
  });
});
