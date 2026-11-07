import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { normalizeCustomOpenAIBaseURL } from '../tts/base-url.js';

export class ConfiguredSpeechError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ConfiguredSpeechError(code, status); };
const inputSchema = z.object({ text: z.string().trim().min(1).max(9999), speed: z.number().finite().min(0.5).max(2).optional() }).strict();
const responseSchema = z.object({ base_resp: z.object({ status_code: z.number().int() }), data: z.object({ audio: z.string().min(2) }).optional() });
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const readBytes = async (response) => {
  const reader = response.body?.getReader();
  if (!reader) return fail('model_configuration_invalid_provider_response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return fail('model_configuration_invalid_provider_response');
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof ConfiguredSpeechError) throw error;
    return fail('model_configuration_invalid_provider_response');
  } finally { await reader.cancel().catch(() => {}); }
};

export const isBailianSpeechBinding = (binding) => binding?.protocol === 'openai-compatible' && binding.parameters?.speechOperation === 'bailian.audio.speech.create';

const generateBailianSpeech = async (binding, input, baseUrl, { fetchImpl, idempotencyKey }) => {
  if ([...input.text].length > 600) return fail('model_configuration_invalid_input', 400);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.apiKey}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const speech = { text: input.text, voice: binding.parameters.voice || 'Cherry' };
  if (binding.parameters.language) speech.language_type = binding.parameters.language;
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/native/bailian/audio/speech`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000), headers,
      body: JSON.stringify({ model: binding.model, input: speech }),
    });
  } catch { return fail('model_configuration_provider_unreachable'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return fail(`model_configuration_provider_http_${response.status}`);
  }
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'audio/wav') {
    await response.body?.cancel().catch(() => {});
    return fail('model_configuration_invalid_provider_response');
  }
  const buffer = await readBytes(response);
  if (buffer.length < 44 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') return fail('model_configuration_invalid_provider_response');
  return { buffer, contentType };
};

/** Shared native speech boundary used by playback, probes and bundled narration. */
export const generateConfiguredSpeech = async (binding, input, { fetchImpl = fetch, idempotencyKey } = {}) => {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return fail('model_configuration_invalid_input', 400);
  if (binding.protocol !== 'minimax' && !isBailianSpeechBinding(binding)) return fail('model_configuration_unsupported_protocol', 409);
  const baseUrl = normalizeCustomOpenAIBaseURL(binding.baseUrl, { allowConfiguredRemote: true });
  if (baseUrl.error || !baseUrl.value) return fail(isEnterpriseMode() ? 'enterprise_mode' : 'model_configuration_invalid_input', isEnterpriseMode() ? 403 : 400);
  if (!binding.apiKey?.trim()) return fail('model_configuration_credential_missing', 503);
  if (isBailianSpeechBinding(binding)) return generateBailianSpeech(binding, parsed.data, baseUrl.value, { fetchImpl, idempotencyKey });
  const voice = binding.parameters?.voice || 'male-qn-qingse';
  let response;
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.apiKey}` };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    response = await fetchImpl(`${baseUrl.value}/t2a_v2`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers,
      body: JSON.stringify({
        model: binding.model, text: parsed.data.text, stream: false, output_format: 'hex',
        voice_setting: { voice_id: voice, speed: parsed.data.speed ?? 1 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      }),
    });
  } catch { return fail('model_configuration_provider_unreachable'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return fail(`model_configuration_provider_http_${response.status}`);
  }
  let json;
  try { json = JSON.parse((await readBytes(response)).toString('utf8')); }
  catch (error) {
    if (error instanceof ConfiguredSpeechError) throw error;
    return fail('model_configuration_invalid_provider_response');
  }
  const result = responseSchema.safeParse(json);
  if (!result.success) return fail('model_configuration_invalid_provider_response');
  if (result.data.base_resp.status_code !== 0) return fail('model_configuration_provider_rejected');
  const hex = result.data.data?.audio;
  if (!hex || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) return fail('model_configuration_invalid_provider_response');
  const buffer = Buffer.from(hex, 'hex');
  if (buffer.length < 4 || !(buffer.subarray(0, 3).toString('ascii') === 'ID3' || buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return fail('model_configuration_invalid_provider_response');
  return { buffer, contentType: 'audio/mpeg' };
};
