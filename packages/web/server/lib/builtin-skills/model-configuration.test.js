import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { requestConfiguredSpeech } from '../../builtin-skills/supervideo-engine/src/providers/model-configuration.mjs';
import { validateVoice } from '../../builtin-skills/supervideo-engine/src/providers/tts.mjs';

let server;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

describe('bundled SuperVideo narration configuration', () => {
  it('accepts a configured voice and consumes its selected endpoint, model and key', async () => {
    let received;
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = { url: req.url, key: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end('audio-fixture');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const binding = { protocol: 'openai-compatible', model: 'narration-model', apiKey: 'narration-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
    const voice = { provider: 'openai-compatible', model: 'narration-model', voice: 'alloy' };
    expect(validateVoice(voice)).toBe(voice);
    const result = await requestConfiguredSpeech('Narration', voice, { resolveBinding: async () => binding });
    expect(result.bytes.toString()).toBe('audio-fixture');
    expect(received).toEqual({ url: '/v1/audio/speech', key: 'Bearer narration-key', body: { model: 'narration-model', input: 'Narration', voice: 'alloy', response_format: 'mp3' } });
    expect(JSON.stringify(result.evidence)).not.toContain('narration-key');
  });

  it('refuses an explicit project model mismatch instead of sending a key to another adapter', async () => {
    await expect(requestConfiguredSpeech('Narration', { model: 'old-project-model', voice: 'alloy' }, { resolveBinding: async () => ({ model: 'new-selected-model' }) })).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_VOICE_MISMATCH' });
  });
});

it('reports a managed speech account switch with a restart action', async () => {
  const previous=process.env.SUPERWAGIE_MODEL_RESOLVER;process.env.SUPERWAGIE_MODEL_RESOLVER='/fixture/resolver';
  try {
    await expect(requestConfiguredSpeech('Narration',{model:'voice',voice:'Cherry',provider:'managed-media'}, {
      resolveBinding:async()=>({protocol:'managed-media',model:'voice',parameters:{voice:'Cherry'}}),
      runResolver:async()=>({code:1,stderr:'platform_model_scope_restart_required',stdout:''}),
    })).rejects.toMatchObject({code:'PLATFORM_MODEL_SCOPE_RESTART_REQUIRED',message:expect.stringContaining('Restart SuperWagie')});
  } finally {if(previous===undefined)delete process.env.SUPERWAGIE_MODEL_RESOLVER;else process.env.SUPERWAGIE_MODEL_RESOLVER=previous;}
});

it.each([
  [{ contentType: 'audio/ogg', audio: 'YQ==' }],
  [{ contentType: 'audio/mpeg', audio: '%%%%' }],
])('rejects unsupported or malformed managed narration responses', async (output) => {
  const previous = process.env.SUPERWAGIE_MODEL_RESOLVER;
  process.env.SUPERWAGIE_MODEL_RESOLVER = '/fixture/resolver';
  try {
    await expect(requestConfiguredSpeech('Narration', { model: 'voice', voice: 'Cherry', provider: 'managed-media' }, {
      resolveBinding: async () => ({ protocol: 'managed-media', model: 'voice' }),
      runResolver: async () => ({ code: 0, stdout: JSON.stringify(output) }),
    })).rejects.toMatchObject({ code: 'OUTPUT_INVALID' });
  } finally {
    if (previous === undefined) delete process.env.SUPERWAGIE_MODEL_RESOLVER;
    else process.env.SUPERWAGIE_MODEL_RESOLVER = previous;
  }
});
