import { describe, expect, test } from 'bun:test';

import type { ModelBinding, ModelConfiguration, ModelPurposeId } from '@/lib/modelConfiguration';
import type { RoutingState } from '@/lib/routing/routingApi';

import { buildModelOverviewRows, type ModelOverviewInputs } from './modelOverviewRows';
import { MODEL_PURPOSE_LABELS } from './modelConfigurationView';

function inputs(): ModelOverviewInputs {
  return {
    knowledge: { status: 'ready', configuration: { status: 'available', models: [] } },
    routing: { status: 'ready', configuration: routingState() },
    native: { status: 'ready', defaultModel: 'provider/chat-model', smallModelUseDefault: true },
    voice: { tts: { provider: 'browser' }, stt: { provider: 'local', model: 'local-whisper' } },
    runtime: 'available',
  };
}

function routingState(): RoutingState {
  return {
    available: true, autoReady: false, jevAvailable: false, tokenPresent: false,
    customEndpoint: null, enterpriseMode: false, jevSource: 'zen-free',
    classifier: { selected: 'off', effective: null, sources: [] }, config: null, builtins: [],
  };
}

function configuration(): ModelConfiguration {
  return {
    version: 1,
    revision: 1,
    enterpriseMode: false,
    credentialSources: { status: 'available', sources: [] },
    purposes: [
      { id: 'agent', labelKey: MODEL_PURPOSE_LABELS.agent, consumerIds: [], status: 'native', required: true },
      { id: 'auxiliary', labelKey: MODEL_PURPOSE_LABELS.auxiliary, consumerIds: [], status: 'native', required: false },
      { id: 'embedding', labelKey: MODEL_PURPOSE_LABELS.embedding, consumerIds: ['knowledge-library'], status: 'available', required: false, probeProtocols: ['openai-compatible'] },
      { id: 'rerank', labelKey: MODEL_PURPOSE_LABELS.rerank, consumerIds: ['knowledge-library'], status: 'available', required: false, probeProtocols: ['openai-compatible'] },
      { id: 'vision', labelKey: MODEL_PURPOSE_LABELS.vision, consumerIds: ['knowledge-library'], status: 'available', required: false, probeProtocols: ['openai-compatible'] },
      { id: 'ocr', labelKey: MODEL_PURPOSE_LABELS.ocr, consumerIds: ['knowledge-library'], status: 'available', required: false, probeProtocols: [] },
      { id: 'tts', labelKey: MODEL_PURPOSE_LABELS.tts, consumerIds: ['read-aloud'], status: 'available', required: false, probeProtocols: ['openai-compatible'] },
      { id: 'stt-realtime', labelKey: MODEL_PURPOSE_LABELS['stt-realtime'], consumerIds: ['voice-transcription'], status: 'available', required: false, probeProtocols: [] },
      { id: 'image-generation', labelKey: MODEL_PURPOSE_LABELS['image-generation'], consumerIds: ['superppt'], status: 'available', required: false, probeProtocols: ['openai-compatible'] },
      { id: 'routing', labelKey: MODEL_PURPOSE_LABELS.routing, consumerIds: ['auto-routing'], status: 'available', required: false, probeProtocols: ['jev'] },
      ...(['stt-short', 'stt-file', 'image-editing', 'multimodal-embedding', 'video-generation'] satisfies ModelPurposeId[]).map((id) => ({ id, labelKey: MODEL_PURPOSE_LABELS[id], consumerIds: [], status: 'planned' as const, required: false, probeProtocols: [] })),
    ],
    presets: [{
      id: 'embedding', providerId: 'example', name: 'Example embedding', origin: 'international', purposes: ['embedding'],
      protocol: 'openai-compatible', model: 'embedding-model', baseUrl: 'https://model.example/v1',
      docsUrl: 'https://model.example/docs', keyUrl: 'https://model.example/keys',
      parameters: {}, status: 'compatible', notes: [], noteCodes: [], reviewedAt: '2026-10-23',
    }],
    connections: [{ id: 'connection', name: 'Example connection', providerId: 'example', protocol: 'openai-compatible', baseUrl: 'https://model.example/v1', hasApiKey: true }],
    bindings: [],
  };
}

function binding(status: ModelBinding['verification']['status'] = 'untested', purpose: ModelPurposeId = 'embedding'): ModelBinding {
  const verification: ModelBinding['verification'] = { status };
  if (status !== 'untested') verification.testedAt = '2026-10-23T01:00:00Z';
  if (status === 'failed') verification.errorCode = 'model_configuration_provider_http_401';
  return {
    purpose, connectionId: 'connection', model: `${purpose}-model`, parameters: {},
    verification,
  };
}

function row(snapshot: ModelConfiguration | null, purpose: ModelPurposeId, inherited = inputs()) {
  const result = buildModelOverviewRows(snapshot, inherited).find((candidate) => candidate.purpose === purpose);
  if (!result) throw new Error(`Missing overview row ${purpose}`);
  return result;
}

describe('model configuration overview projection', () => {
  test('always includes every purpose in the settings order and keeps required metadata', () => {
    const snapshot = configuration();
    snapshot.purposes.reverse();
    const rows = buildModelOverviewRows(snapshot, inputs());
    expect(rows.map((entry) => entry.purpose)).toEqual(Object.keys(MODEL_PURPOSE_LABELS));
    expect(rows).toHaveLength(15);
    expect(rows.filter((entry) => entry.required).map((entry) => entry.purpose)).toEqual(['agent']);
  });

  test('a saved binding remains untested and exposes its selected model and connection', () => {
    const snapshot = configuration();
    snapshot.bindings = [binding()];
    expect(row(snapshot, 'embedding')).toMatchObject({
      configuration: 'configured', test: 'untested', model: 'embedding-model', connectionName: 'Example connection', canTest: true, canConfigure: true,
    });
  });

  test('only the saved purpose verification supplies health and its last test time', () => {
    const snapshot = configuration();
    snapshot.bindings = [binding('verified')];
    expect(row(snapshot, 'embedding')).toMatchObject({ test: 'verified', testedAt: '2026-10-23T01:00:00Z' });
    snapshot.bindings = [binding('failed')];
    expect(row(snapshot, 'embedding')).toMatchObject({ test: 'failed', errorCode: 'model_configuration_provider_http_401', testedAt: '2026-10-23T01:00:00Z', canTest: true });
    expect(row(snapshot, 'vision').test).not.toBe('verified');
  });

  test('a rotated credential projected as untested cannot retain the old successful test', () => {
    const snapshot = configuration();
    snapshot.bindings = [binding('verified')];
    expect(row(snapshot, 'embedding').test).toBe('verified');
    snapshot.revision += 1;
    snapshot.bindings = [binding()];
    expect(row(snapshot, 'embedding')).toMatchObject({ test: 'untested', testedAt: undefined });
  });

  test('native model choices and automatic defaults require component validation', () => {
    expect(row(configuration(), 'agent')).toMatchObject({ configuration: 'native', model: 'provider/chat-model', test: 'component', canTest: false });
    expect(row(configuration(), 'auxiliary')).toMatchObject({ configuration: 'inherited', model: null, test: 'component' });
    const inherited = inputs();
    inherited.native = { status: 'ready', smallModelUseDefault: false, smallModelOverride: 'provider/small-model' };
    expect(row(configuration(), 'agent', inherited)).toMatchObject({ configuration: 'inherited', model: null, test: 'component' });
    expect(row(configuration(), 'auxiliary', inherited)).toMatchObject({ configuration: 'native', model: 'provider/small-model', test: 'component' });
  });

  test('unreadable native preferences remain unknown while their controls remain available', () => {
    const inherited = inputs();
    inherited.native = { status: 'failed' };
    expect(row(configuration(), 'agent', inherited)).toMatchObject({ configuration: 'unknown', test: 'unknown', canConfigure: true });
  });

  test('an unavailable unified configuration cannot masquerade as missing setup', () => {
    expect(row(null, 'embedding')).toMatchObject({ configuration: 'unknown', test: 'unknown', reason: 'runtime', canConfigure: false, canTest: false });
    expect(row(null, 'tts').configuration).toBe('unknown');
    expect(row(null, 'agent')).toMatchObject({ configuration: 'native', canConfigure: true });
  });

  test('unsupported runtimes keep native controls and make app model status unknown', () => {
    const inherited = inputs();
    inherited.runtime = 'unsupported';
    const snapshot = configuration();
    snapshot.bindings = [binding('verified')];
    expect(row(snapshot, 'embedding', inherited)).toMatchObject({ configuration: 'unknown', test: 'unknown', reason: 'runtime', canTest: false, canConfigure: false });
    expect(row(snapshot, 'agent', inherited).canConfigure).toBe(true);
  });

  test('planned purposes stay separate from incomplete setup even if an old binding exists', () => {
    const snapshot = configuration();
    snapshot.bindings = [binding('verified', 'video-generation')];
    expect(row(snapshot, 'video-generation')).toMatchObject({ configuration: 'planned', test: 'unsupported', reason: 'adapter', canTest: false, canConfigure: false });
    expect(row(snapshot, 'stt-short').configuration).toBe('planned');
  });

  test('a known empty knowledge projection reports missing setup', () => {
    expect(row(configuration(), 'embedding')).toMatchObject({ configuration: 'missing', test: 'untested', canConfigure: true });
  });

  test('failed, loading and unavailable knowledge reads cannot report missing setup', () => {
    const inherited = inputs();
    for (const status of ['failed', 'loading'] as const) {
      inherited.knowledge = { status };
      expect(row(configuration(), 'embedding', inherited).configuration).toBe('unknown');
    }
    inherited.knowledge = { status: 'ready', configuration: { status: 'unavailable', reason: 'backend_not_ready' } };
    expect(row(configuration(), 'embedding', inherited)).toMatchObject({ configuration: 'unknown', test: 'unknown' });
  });

  test('a partial knowledge projection preserves unrelated inherited models', () => {
    const inherited = inputs();
    inherited.knowledge = { status: 'ready', configuration: {
      status: 'available', unavailablePurposes: ['vision'],
      models: [{ purpose: 'embedding', modelId: 'existing-id', model: 'existing-index-model', dimensions: 1024, baseUrl: 'https://knowledge.example/v1', hasKey: true }],
    } };
    expect(row(configuration(), 'embedding', inherited)).toMatchObject({ model: 'existing-index-model', configuration: 'inherited', test: 'component', canTest: false });
    expect(row(configuration(), 'vision', inherited)).toMatchObject({ configuration: 'unknown', test: 'unknown' });
    expect(row(configuration(), 'rerank', inherited).configuration).toBe('missing');
  });

  test('a keyless inherited model stays component-owned without inferring an authentication failure', () => {
    const inherited = inputs();
    inherited.knowledge = { status: 'ready', configuration: { status: 'available', models: [
      { purpose: 'embedding', modelId: 'existing-id', model: 'existing-model', baseUrl: 'https://knowledge.example/v1', hasKey: false },
    ] } };
    expect(row(configuration(), 'embedding', inherited)).toMatchObject({ configuration: 'inherited', test: 'component', reason: 'component', model: 'existing-model' });
  });

  test('local and system voice selections need no cloud API setup', () => {
    for (const provider of ['browser', 'local', 'say'] as const) {
      const inherited = inputs();
      inherited.voice.tts = { provider, model: provider === 'local' ? 'local-tts' : undefined };
      expect(row(configuration(), 'tts', inherited)).toMatchObject({ configuration: 'local', test: 'component', canTest: false });
    }
    expect(row(configuration(), 'stt-realtime')).toMatchObject({ configuration: 'local', model: 'local-whisper', test: 'component' });
  });

  test('legacy cloud voice choices stay component-owned until a unified binding replaces them', () => {
    const inherited = inputs();
    inherited.voice = { tts: { provider: 'openai-compatible', model: 'legacy-speech' }, stt: { provider: 'openai-compatible', model: 'legacy-transcribe' } };
    expect(row(configuration(), 'tts', inherited)).toMatchObject({ configuration: 'inherited', model: 'legacy-speech', test: 'component' });
    expect(row(configuration(), 'stt-realtime', inherited)).toMatchObject({ configuration: 'inherited', model: 'legacy-transcribe', test: 'component' });
    const snapshot = configuration();
    snapshot.bindings = [binding('verified', 'tts')];
    expect(row(snapshot, 'tts', inherited)).toMatchObject({ configuration: 'configured', model: 'tts-model', test: 'verified' });
  });

  test('a selected adapter without a central probe stays component-validated', () => {
    const snapshot = configuration();
    snapshot.connections[0]!.protocol = 'paddleocr';
    snapshot.bindings = [binding('untested', 'ocr')];
    expect(row(snapshot, 'ocr')).toMatchObject({ configuration: 'configured', test: 'component', reason: 'component', canTest: false });
  });

  test('presets requiring an adapter cannot inherit a stale verified status or enable a probe', () => {
    const snapshot = configuration();
    snapshot.bindings = [{ ...binding('verified'), presetId: 'embedding' }];
    snapshot.presets[0]!.status = 'requires-adapter';
    expect(row(snapshot, 'embedding')).toMatchObject({ test: 'unsupported', reason: 'adapter', canTest: false });
    expect(row(snapshot, 'embedding').testedAt).toBeUndefined();
    snapshot.presets = [];
    expect(row(snapshot, 'embedding').test).toBe('unsupported');
  });

  test('enterprise restrictions are policy blocks, while loopback probes remain available', () => {
    const snapshot = configuration();
    snapshot.enterpriseMode = true;
    snapshot.bindings = [binding('verified')];
    expect(row(snapshot, 'embedding')).toMatchObject({ test: 'blocked', reason: 'policy', canTest: false });
    snapshot.connections[0]!.baseUrl = 'http://127.0.0.1:43183/v1';
    snapshot.connections[0]!.hasApiKey = false;
    expect(row(snapshot, 'embedding')).toMatchObject({ test: 'verified', canTest: true });
  });

  test('a missing native credential differs from a failed credential reader', () => {
    const snapshot = configuration();
    snapshot.connections[0]!.credentialSource = { type: 'opencode', providerId: 'example' };
    snapshot.connections[0]!.hasApiKey = false;
    snapshot.bindings = [binding()];
    expect(row(snapshot, 'embedding')).toMatchObject({ configuration: 'missing', test: 'untested', reason: 'credentials', errorCode: 'model_configuration_credential_missing', canTest: false });
    for (const status of ['failed', 'unavailable'] as const) {
      snapshot.credentialSources.status = status;
      expect(row(snapshot, 'embedding')).toMatchObject({ configuration: 'configured', test: 'unknown', reason: 'credentials', errorCode: 'model_configuration_credential_unavailable', canTest: false });
    }
  });

  test('keyless local models can be tested without inventing API credentials', () => {
    const snapshot = configuration();
    snapshot.connections[0]!.baseUrl = 'http://localhost:8000/v1';
    snapshot.connections[0]!.hasApiKey = false;
    snapshot.bindings = [binding()];
    expect(row(snapshot, 'embedding')).toMatchObject({ configuration: 'configured', test: 'untested', canTest: true });
  });

  test('manual keyless remote endpoints retain their actual last probe result', () => {
    const snapshot = configuration();
    snapshot.connections[0]!.hasApiKey = false;
    snapshot.bindings = [binding('verified')];
    expect(row(snapshot, 'embedding')).toMatchObject({ configuration: 'configured', test: 'verified', canTest: true });
  });

  test('a dangling connection reference remains unknown and never claims a provider fault', () => {
    const snapshot = configuration();
    snapshot.connections = [];
    snapshot.bindings = [binding('verified')];
    expect(row(snapshot, 'embedding')).toMatchObject({ configuration: 'configured', test: 'unknown', reason: 'runtime', canTest: false });
  });

  test('legacy custom routing exposes the actual component model without a unified probe claim', () => {
    const inherited = inputs();
    inherited.routing = { status: 'ready', configuration: {
      ...routingState(), jevAvailable: true,
      customEndpoint: { url: 'https://legacy.example/systemone', model: 'legacy-decision-model', keyPresent: true, pinned: false },
      classifier: { selected: 'custom', effective: 'custom', sources: [] },
    } };
    expect(row(configuration(), 'routing', inherited)).toMatchObject({ configuration: 'inherited', test: 'component', model: 'legacy-decision-model', connectionName: 'custom', canTest: false });
  });

  test('effective legacy Jev sources retain component ownership without guessing a model ID', () => {
    const inherited = inputs();
    inherited.routing = { status: 'ready', configuration: {
      ...routingState(), jevAvailable: true, tokenPresent: true, jevSource: 'typesafe',
      classifier: { selected: 'openrouter', effective: 'typesafe', sources: [] },
    } };
    expect(row(configuration(), 'routing', inherited)).toMatchObject({ configuration: 'inherited', test: 'component', model: null, connectionName: 'typesafe', canTest: false });
  });

  test('an active administrator routing pin takes precedence over a verified user binding', () => {
    const snapshot = configuration();
    snapshot.connections[0]!.protocol = 'jev';
    snapshot.bindings = [binding('verified', 'routing')];
    const inherited = inputs();
    inherited.routing = { status: 'ready', configuration: {
      ...routingState(), jevAvailable: true, enterpriseMode: true,
      customEndpoint: { url: 'https://admin.example/systemone', model: 'admin-decision-model', keyPresent: true, pinned: true },
      classifier: { selected: 'custom', effective: 'custom', sources: [] },
    } };
    expect(row(snapshot, 'routing', inherited)).toMatchObject({ configuration: 'inherited', test: 'component', model: 'admin-decision-model', canTest: false });
    expect(row(snapshot, 'routing', inherited).testedAt).toBeUndefined();
  });

  test('a saved administrator endpoint does not replace the actual off or effective legacy source', () => {
    const snapshot = configuration();
    snapshot.bindings = [binding('verified', 'routing')];
    const inherited = inputs();
    const state = routingState();
    state.customEndpoint = { url: 'https://admin.example/systemone', model: 'admin-model', keyPresent: true, pinned: true };
    inherited.routing = { status: 'ready', configuration: state };
    expect(row(snapshot, 'routing', inherited)).toMatchObject({ configuration: 'missing', test: 'untested', model: null, canTest: false });
    state.classifier = { selected: 'typesafe', effective: 'typesafe', sources: [] };
    state.jevAvailable = true;
    expect(row(snapshot, 'routing', inherited)).toMatchObject({ configuration: 'inherited', test: 'component', model: null, connectionName: 'typesafe' });
  });

  test('failed or loading routing reads cannot expose a potentially overridden user verification', () => {
    const snapshot = configuration();
    snapshot.bindings = [binding('verified', 'routing')];
    const inherited = inputs();
    for (const status of ['failed', 'loading'] as const) {
      inherited.routing = { status };
      expect(row(snapshot, 'routing', inherited)).toMatchObject({ configuration: 'unknown', test: 'unknown', model: null, canTest: false });
    }
    inherited.routing = { status: 'ready', configuration: { ...routingState(), available: false } };
    expect(row(snapshot, 'routing', inherited).configuration).toBe('unknown');
  });

  test('a matching active unified routing binding retains its exact test result', () => {
    const snapshot = configuration();
    snapshot.connections[0]!.protocol = 'jev';
    snapshot.bindings = [binding('verified', 'routing')];
    const inherited = inputs();
    inherited.routing = { status: 'ready', configuration: {
      ...routingState(), jevAvailable: true,
      customEndpoint: { url: 'https://model.example/v1', model: 'routing-model', keyPresent: true, pinned: false },
      classifier: { selected: 'custom', effective: 'custom', sources: [] },
    } };
    expect(row(snapshot, 'routing', inherited)).toMatchObject({ configuration: 'configured', test: 'verified', model: 'routing-model', connectionName: 'Example connection', canTest: true });
  });

  test('a different effective custom endpoint cannot borrow another routing binding verification', () => {
    const snapshot = configuration();
    snapshot.connections[0]!.protocol = 'jev';
    snapshot.bindings = [binding('verified', 'routing')];
    const inherited = inputs();
    inherited.routing = { status: 'ready', configuration: {
      ...routingState(), jevAvailable: true,
      customEndpoint: { url: 'https://other.example/systemone', model: 'other-routing-model', keyPresent: true, pinned: false },
      classifier: { selected: 'custom', effective: 'custom', sources: [] },
    } };
    expect(row(snapshot, 'routing', inherited)).toMatchObject({ configuration: 'inherited', test: 'component', model: 'other-routing-model', canTest: false });
  });

  test('ready routing with no effective provider reports missing setup', () => {
    expect(row(configuration(), 'routing')).toMatchObject({ configuration: 'missing', test: 'untested', model: null });
  });

  test('projection leaves every supplied snapshot unchanged', () => {
    const snapshot = configuration();
    snapshot.bindings = [binding('verified')];
    const inherited = inputs();
    const before = JSON.stringify({ snapshot, inherited });
    buildModelOverviewRows(snapshot, inherited);
    expect(JSON.stringify({ snapshot, inherited })).toBe(before);
  });
});
