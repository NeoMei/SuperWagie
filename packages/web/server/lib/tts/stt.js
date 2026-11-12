/**
 * Server-side Speech-to-Text Service
 *
 * Submits audio to the server-resolved LLMRouter ASR transcription endpoint
 * using the OpenAI Node SDK. The gateway accepts only model, response_format
 * and a WAV file, so no language hint or other field is sent.
 */

import { loadOpenAI } from './openai-sdk.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { configuredProviderError } from './provider-errors.js';

/**
 * Transcribe an audio buffer via an OpenAI-compatible /v1/audio/transcriptions endpoint.
 *
 * @param {object} opts
 * @param {Buffer} opts.audioBuffer  - Raw audio bytes
 * @param {string} opts.mimeType     - MIME type of the audio (e.g. 'audio/webm')
 * @param {string} opts.model        - Model name accepted by the remote server
 * @param {string} [opts.baseURL]    - Base URL of the compatible server (including /v1)
 * @param {string} [opts.apiKey]     - Optional API key for the compatible server
 * @param {boolean} [opts.configured] - A server-resolved binding; remote URLs
 *   are allowed only for this path.
 * @returns {Promise<string>} Transcribed text
 */
export async function transcribeAudio({ audioBuffer, mimeType, model, baseURL, apiKey, configured = false }) {
  const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL, { allowConfiguredRemote: configured });
  if (normalizedBaseURLResult.error) {
    throw new Error(normalizedBaseURLResult.error);
  }

  const normalizedBaseURL = normalizedBaseURLResult.value;
  if (!normalizedBaseURL) {
    throw new Error('Custom server URL is required');
  }

  // Only the server-resolved binding's key goes to its own endpoint.
  const clientOpts = {
    apiKey: apiKey || 'not-required',
  };
  clientOpts.baseURL = normalizedBaseURL;

  const OpenAI = await loadOpenAI();
  const client = new OpenAI(clientOpts);

  try {
    // Derive a sensible filename extension from the MIME type so the server
    // can infer the codec when it isn't explicit in the stream header.
    const ext = mimeTypeToExt(mimeType);
    const filename = `audio.${ext}`;
    const file = await OpenAI.toFile(audioBuffer, filename, { type: mimeType });
    const result = await client.audio.transcriptions.create({
      file,
      model,
      response_format: 'json',
    });
    return result.text ?? '';
  } catch {
    throw configuredProviderError('transcription');
  }
}

/**
 * Map a MIME type to a file extension understood by OpenAI-compatible transcription endpoints.
 * @param {string} mimeType
 * @returns {string}
 */
function mimeTypeToExt(mimeType) {
  const type = (mimeType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mp4',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
  };
  return map[type] ?? 'webm';
}
