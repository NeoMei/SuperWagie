import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './process.mjs';
import { mediaError } from './assets.mjs';

/** Resolver output is private child-process data and must never enter a receipt. */
export async function resolveSpeechBinding() {
  const resolver = process.env.SUPERWAGIE_MODEL_RESOLVER;
  if (!resolver) {
    try {
      await access(join(process.env.OPENCHAMBER_DATA_DIR || join(homedir(), '.config', 'openchamber'), 'model-configuration.json'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw mediaError('MODEL_CONFIGURATION_UNAVAILABLE', 'The model configuration cannot be read');
    }
    throw mediaError('MODEL_CONFIGURATION_UNAVAILABLE', 'Run this skill from SuperWagie to use the selected model');
  }
  const result = await runProcess(process.env.SUPERWAGIE_MODEL_NODE || process.execPath, [resolver, 'tts', 'openai-compatible', 'minimax'], {
    timeoutMs: 20000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.code !== 0 || result.timedOut) throw mediaError('MODEL_CONFIGURATION_UNAVAILABLE', 'The selected narration model is unavailable or requires another adapter');
  let binding;
  try { binding = JSON.parse(result.stdout); } catch { throw mediaError('MODEL_CONFIGURATION_UNAVAILABLE', 'The model resolver returned an unreadable response'); }
  if (binding === null) return null;
  if (!['openai-compatible', 'minimax', 'managed-media'].includes(binding.protocol) || typeof binding.baseUrl !== 'string' || typeof binding.model !== 'string' || (binding.protocol !== 'managed-media' && typeof binding.apiKey !== 'string')) {
    throw mediaError('MODEL_CONFIGURATION_UNAVAILABLE', 'The selected narration model is unsupported');
  }
  return binding;
}

export async function configuredDefaultVoice({ resolveBinding = resolveSpeechBinding } = {}) {
  const binding = await resolveBinding();
  if (!binding) return null;
  return { provider: binding.protocol, model: binding.model, voice: binding.parameters.voice || (binding.protocol === 'minimax' ? 'male-qn-qingse' : 'alloy') };
}

export async function requestConfiguredSpeech(text, voice, { resolveBinding = resolveSpeechBinding, fetchImpl = fetch, runResolver = runProcess } = {}) {
  const binding = await resolveBinding();
  if (!binding) throw mediaError('TTS_UNAVAILABLE', 'Select a narration model in SuperWagie Model configuration');
  if (voice.model !== binding.model || voice.provider && voice.provider !== binding.protocol) throw mediaError('MODEL_CONFIGURATION_VOICE_MISMATCH', 'The project narration model differs from Model configuration; update its explicit voice settings');
  if (binding.protocol === 'managed-media') {
    const resolver = process.env.SUPERWAGIE_MODEL_RESOLVER;
    if (!resolver) throw mediaError('MODEL_CONFIGURATION_UNAVAILABLE', 'Run this skill from SuperWagie to use the selected model');
    const result = await runResolver(process.env.SUPERWAGIE_MODEL_NODE || process.execPath, [resolver, '--synthesize-tts'], {
      timeoutMs: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      input: JSON.stringify({ text, expectedModel: voice.model, expectedVoice: voice.voice }),
    });
    if (result.code !== 0 && result.stderr?.trim() === 'model_configuration_agent_session_required') throw mediaError('MODEL_CONFIGURATION_AGENT_SESSION_REQUIRED', 'Run this skill in one active agent session and retry. 请在唯一运行中的主智能体会话里重试。');
    if (result.code !== 0 && result.stderr?.trim() === 'platform_model_scope_restart_required') throw mediaError('PLATFORM_MODEL_SCOPE_RESTART_REQUIRED', 'Your account or sign-in has changed. Restart SuperWagie to continue. 账户或登录状态已变化，请重启 SuperWagie 后继续。');
    if (result.code !== 0 || result.timedOut) throw mediaError('TTS_FAILED', 'The managed narration service failed; check the model and voice in SuperWagie');
    let output;
    try { output = JSON.parse(result.stdout); } catch { throw mediaError('OUTPUT_INVALID', 'The narration helper returned an unreadable response'); }
    if (output.contentType !== 'audio/mpeg' || typeof output.audio !== 'string' || !output.audio.length) throw mediaError('OUTPUT_INVALID', 'The narration helper returned invalid audio');
    return { bytes: Buffer.from(output.audio, 'base64'), evidence: { provider: 'managed', model: binding.model, voice: voice.voice, status: 'succeeded' } };
  }
  if (binding.protocol === 'minimax') {
    const resolver = process.env.SUPERWAGIE_MODEL_RESOLVER;
    if (!resolver) throw mediaError('MODEL_CONFIGURATION_UNAVAILABLE', 'Run this skill from SuperWagie to use the selected model');
    const result = await runResolver(process.env.SUPERWAGIE_MODEL_NODE || process.execPath, [resolver, '--synthesize-tts'], {
      timeoutMs: 70000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      input: JSON.stringify({ text, ...(voice.speed === undefined ? {} : { speed: voice.speed }), expectedModel: voice.model, expectedVoice: voice.voice }),
    });
    if (result.code !== 0 || result.timedOut) throw mediaError('TTS_FAILED', 'The configured narration service failed; check the model and voice in SuperWagie');
    let output;
    try { output = JSON.parse(result.stdout); } catch { throw mediaError('OUTPUT_INVALID', 'The narration helper returned an unreadable response'); }
    if (output.contentType !== 'audio/mpeg' || typeof output.audio !== 'string' || output.audio.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(output.audio) || !output.audio.length) throw mediaError('OUTPUT_INVALID', 'The narration helper returned invalid audio');
    return { bytes: Buffer.from(output.audio, 'base64'), evidence: { provider: 'minimax', model: binding.model, voice: voice.voice, status: 'succeeded' } };
  }
  let response;
  try {
    response = await fetchImpl(`${binding.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${binding.apiKey}` },
      body: JSON.stringify({ model: binding.model, input: text, voice: voice.voice, response_format: 'mp3', ...(voice.speed ? { speed: voice.speed } : {}) }),
    });
  } catch { throw mediaError('TTS_FAILED', 'The selected narration service could not be reached'); }
  if (!response.ok) throw mediaError('TTS_FAILED', `The narration service rejected the request (HTTP ${response.status})`);
  if (!response.headers.get('content-type')?.startsWith('audio/')) throw mediaError('OUTPUT_INVALID', 'The narration service returned a non-audio response');
  const limit = 32 * 1024 * 1024;
  const chunks = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (!reader) throw mediaError('OUTPUT_INVALID', 'The narration service returned no audio');
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw mediaError('OUTPUT_INVALID', 'Narration audio exceeded the size limit');
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!length) throw mediaError('OUTPUT_INVALID', 'The narration service returned empty audio');
  return { bytes: Buffer.concat(chunks), evidence: { provider: 'openai-compatible', model: binding.model, voice: voice.voice, status: 'succeeded' } };
}
