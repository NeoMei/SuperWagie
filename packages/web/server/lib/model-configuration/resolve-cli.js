import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { createModelConfigurationRuntime } from './runtime.js';
import { openCodeCredentialSource, projectCredentialEntries } from '../opencode/auth.js';
import { generateConfiguredSpeech } from './speech.js';

const privateCredentialReader = (environment) => {
  if (!environment.SUPERWAGIE_MODEL_OPENCODE_URL) return undefined;
  let baseUrl;
  try {
    const url = new URL(environment.SUPERWAGIE_MODEL_OPENCODE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    baseUrl = url.origin;
  } catch { return undefined; }
  const source = openCodeCredentialSource({
    buildOpenCodeUrl: () => baseUrl,
    getOpenCodeAuthHeaders: () => {
      const password = (environment.OPENCODE_PASSWORD || environment.OPENCODE_SERVER_PASSWORD || '').trim();
      return password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } : {};
    },
    getLaunchEnvironment: () => environment,
    getDefaultDirectory: () => process.cwd(),
  });
  return async () => {
    const [stored, environmentKeys] = await Promise.all([source.list(), source.listEnvironmentKeys()]);
    return { ...Object.fromEntries(Object.entries(environmentKeys).map(([providerId, key]) => [providerId, { type: 'api', key }])), ...projectCredentialEntries(stored) };
  };
};

/** For bundled child processes only. Never forward its stdout to a browser or log. */
export const resolveModelBindingFromDisk = (purpose, { dataDir, supportedProtocols, environment = process.env } = {}) => {
  const directory = dataDir ?? (environment.OPENCHAMBER_DATA_DIR ? path.resolve(environment.OPENCHAMBER_DATA_DIR) : path.join(os.homedir(), '.config', 'openchamber'));
  return createModelConfigurationRuntime({ dataDir: directory, readOpenCodeCredentials: privateCredentialReader(environment) }).resolveBinding(purpose, { supportedProtocols });
};
const speechInput = z.object({ sessionID: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).optional(),
  text: z.string().trim().min(1).max(9999), speed: z.number().finite().min(0.5).max(2).optional(),
  expectedModel: z.string().trim().min(1).max(256).optional(), expectedVoice: z.string().trim().min(1).max(256).optional(),
}).strict();
const speechFailure = (code) => Object.assign(new Error(code), { code });

/** Returns audio only; resolved keys stay inside this private helper process. */
export const synthesizeConfiguredSpeechFromDisk = async (input, options = {}) => {
  const parsed = speechInput.safeParse(input);
  if (!parsed.success) throw speechFailure('model_configuration_invalid_input');
  const binding = await resolveModelBindingFromDisk('tts', { ...options, supportedProtocols: ['minimax', 'managed-media'] });
  if (!binding) throw speechFailure('model_configuration_binding_missing');
  if (parsed.data.expectedModel && parsed.data.expectedModel !== binding.model || parsed.data.expectedVoice && parsed.data.expectedVoice !== (binding.parameters.voice || 'male-qn-qingse')) throw speechFailure('model_configuration_voice_mismatch');
  if (binding.protocol === 'managed-media') {
    const environment = options.environment ?? process.env;
    const proxyURL = environment.OPENCHAMBER_UNIHUB_PROXY_URL;
    const proxyToken = environment.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
    if (!proxyURL || !proxyToken) throw speechFailure('model_configuration_unavailable');
    const voice = parsed.data.expectedVoice || binding.parameters.voice || 'Cherry';
    let response;
    try {
      response = await fetch(proxyURL.replace(/[/]+$/, '') + '/media/speech', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + proxyToken },
        body: JSON.stringify({ sessionID: parsed.data.sessionID, model: binding.model, text: parsed.data.text, voice }),
      });
    } catch { throw speechFailure('model_configuration_unavailable'); }
    if (!response.ok) throw speechFailure('model_configuration_synthesis_failed');
    if (!(response.headers.get('content-type') ?? '').startsWith('audio/')) throw speechFailure('model_configuration_invalid_provider_response');
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw speechFailure('model_configuration_invalid_provider_response');
    return { audio: audio.toString('base64'), contentType: response.headers.get('content-type') ?? 'audio/mpeg' };
  }
  const speech = { text: parsed.data.text };
  if (parsed.data.speed !== undefined) speech.speed = parsed.data.speed;
  const result = await generateConfiguredSpeech(binding, speech);
  return { audio: result.buffer.toString('base64'), contentType: result.contentType };
};

const readSpeechInput = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw speechFailure('model_configuration_invalid_input');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw speechFailure('model_configuration_invalid_input'); }
};
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [purpose, ...supportedProtocols] = process.argv.slice(2);
  try {
    const result = purpose === '--synthesize-tts'
      ? await synthesizeConfiguredSpeechFromDisk(await readSpeechInput())
      : await resolveModelBindingFromDisk(purpose, { supportedProtocols });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(/^(?:model_configuration_[a-z0-9_]+|enterprise_mode)$/.test(error.code) ? error.code : 'model_configuration_failed');
    process.exitCode = 1;
  }
}
