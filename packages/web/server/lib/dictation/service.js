import { configuredProviderError } from '../tts/provider-errors.js';
import { isEnterpriseMode, ENTERPRISE_MODE_ERROR } from '../enterprise-mode.js';
import { detectTextLanguage } from '../tts/language-detect.js';
/**
 * Dictation service: resolves the LLMRouter ASR binding for continuous
 * dictation and owns local TTS model download state and readiness.
 * Continuous dictation submits buffered WAV segments to the configured
 * /v1/audio/transcriptions endpoint; there is no local STT model.
 */

import { rm } from 'fs/promises';

import { DictationWorkerClient } from './local/worker-client.js';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';
import {
  DEFAULT_LOCAL_TTS_MODEL,
  getLocalTtsDefaultSpeaker,
  resolveLocalTtsModelForLanguage,
  LOCAL_TTS_MODEL_CATALOG,
  LOCAL_TTS_MODEL_IDS,
  getLocalTtsModelDir,
  isLocalTtsModelId,
} from './local/model-catalog.js';
import { ensureLocalTtsModel, isLocalTtsModelInstalled } from './local/model-downloader.js';

export function createDictationService({ modelsDir, resolveModelBinding = async () => null }) {
  const workerClient = new DictationWorkerClient();
  /** modelId -> 'downloading' | 'error' */
  const downloadStates = new Map();
  /** modelId -> last download error message */
  const downloadErrors = new Map();
  /** modelId -> in-flight ensure promise */
  const downloadPromises = new Map();
  /** modelId -> 0..100 download percent (null while size unknown) */
  const downloadProgress = new Map();

  const notConfigured = () => ({ error: 'Speech-to-text is not configured. Connect the LLMRouter ASR model in Model configuration.', reasonCode: 'stt_not_configured' });
  const enterpriseRefusal = () => ({ error: ENTERPRISE_MODE_ERROR, reasonCode: 'enterprise_mode' });
  const startModelDownload = (modelId) => {
    const existing = downloadPromises.get(modelId);
    if (existing) {
      return existing;
    }
    downloadStates.set(modelId, 'downloading');
    downloadErrors.delete(modelId);
    downloadProgress.set(modelId, 0);
    const promise = ensureLocalTtsModel({
      modelsDir,
      modelId,
      onProgress: (downloadedBytes, totalBytes) => {
        downloadProgress.set(
          modelId,
          totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null,
        );
      },
    })
      .then(() => {
        downloadStates.delete(modelId);
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      })
      .catch((error) => {
        downloadStates.set(modelId, 'error');
        downloadErrors.set(modelId, error?.message || String(error));
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      });
    downloadPromises.set(modelId, promise);
    return promise;
  };

  /**
   * Create a connected StreamingTranscriptionSession for one dictation.
   * The server resolves the binding; client options cannot supply an endpoint
   * or credential. Returns { session } or a stable visible failure.
   */
  const createSttSession = async () => {
    let binding;
    try {
      binding = await resolveModelBinding('stt-realtime', { supportedProtocols: ['openai-compatible'] });
    } catch (error) {
      return { error: error.message, retryable: false, reasonCode: error.code || 'stt_not_configured' };
    }
    if (!binding) {
      const unbound = isEnterpriseMode() ? enterpriseRefusal() : notConfigured();
      return { ...unbound, retryable: false };
    }
    const session = new OpenAICompatibleTranscriptionSession({
      baseURL: binding.baseUrl,
      model: binding.model,
      apiKey: binding.apiKey,
      configured: true,
    });
    try {
      await session.connect();
    } catch {
      const failure = configuredProviderError('transcription');
      return {
        error: failure?.message || String(failure),
        retryable: false,
        reasonCode: failure.code || 'stt_not_configured',
      };
    }
    return { session };
  };

  /**
   * Readiness snapshot for the status route and UI gating. Local TTS model
   * download state is still reported for the read-aloud controls.
   */
  const getStatus = async () => {
    let binding;
    let bindingError;
    try {
      binding = await resolveModelBinding('stt-realtime', { supportedProtocols: ['openai-compatible'] });
    } catch (error) {
      bindingError = { error: error.message, reasonCode: error.code || 'stt_not_configured' };
    }
    const describeModel = async (id) => ({
      id,
      description: LOCAL_TTS_MODEL_CATALOG[id].description,
      installed: await isLocalTtsModelInstalled(modelsDir, id),
      downloading: downloadStates.get(id) === 'downloading',
      downloadProgress: downloadProgress.get(id) ?? null,
      downloadError: downloadErrors.get(id) || null,
    });
    const ttsModels = await Promise.all(
      LOCAL_TTS_MODEL_IDS.map(describeModel),
    );
    if (bindingError) return { provider: 'openai-compatible', available: false, ...bindingError, ttsModels };
    if (!binding) {
      const unbound = isEnterpriseMode() ? enterpriseRefusal() : notConfigured();
      return { provider: 'openai-compatible', available: false, ...unbound, ttsModels };
    }
    return { provider: 'openai-compatible', available: true, activeModel: binding.model, ttsModels };
  };

  /**
   * Synthesize speech with the local TTS model. Returns WAV bytes, or a
   * readiness error while the model is missing/downloading.
   *
   * With `language: 'auto'` the text's language decides the model: the
   * caller's model when it speaks that language, otherwise the catalog
   * model for it (downloaded on first use, reported as in-progress until it
   * lands). The caller's speaker id is kept only on the caller's model; a
   * substitute model starts from its own default speaker for the language.
   * A language no catalog model covers keeps the caller's model, so text is
   * never silently dropped.
   * `languageSample` is the whole message the chunk belongs to (or a prefix
   * of it): the language is judged on that, never on a short chunk alone.
   * @param {{ text: string, model?: string, speakerId?: number, speed?: number, language?: string, languageSample?: string }} options
   */
  const synthesizeSpeech = async ({ text, model, speakerId, speed, language, languageSample }) => {
    const requestedModelId = isLocalTtsModelId(model) ? model : DEFAULT_LOCAL_TTS_MODEL;
    let modelId = requestedModelId;
    let resolvedLanguage = null;
    if (language === 'auto') {
      resolvedLanguage = detectTextLanguage(languageSample || text).language;
      const forLanguage = resolveLocalTtsModelForLanguage(resolvedLanguage, requestedModelId);
      if (forLanguage && forLanguage !== requestedModelId) {
        modelId = forLanguage;
        speakerId = getLocalTtsDefaultSpeaker(modelId, resolvedLanguage);
      }
    }
    const installed = await isLocalTtsModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        downloadStates.delete(modelId);
        return {
          error: `Failed to download TTS model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'TTS model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    const result = await workerClient.synthesizeSpeech({
      modelsDir,
      modelId,
      text,
      speakerId,
      speed,
    });
    return { audio: result.audio, format: result.format, modelId, language: resolvedLanguage };
  };

  /**
   * Kick off a background download for a model (used by the status route's
   * download action so Settings can pre-download models).
   */
  const requestModelDownload = async (modelId) => {
    if (!isLocalTtsModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (await isLocalTtsModelInstalled(modelsDir, modelId)) {
      return { ok: true, installed: true };
    }
    void startModelDownload(modelId);
    return { ok: true, installed: false };
  };

  /**
   * Delete an installed model from disk. A model that is mid-download cannot
   * be deleted. An engine already loaded in the worker keeps its in-memory
   * copy until the worker's idle shutdown; the files are simply re-downloaded
   * on the next use if the model is selected again.
   */
  const deleteModel = async (modelId) => {
    if (!isLocalTtsModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (downloadStates.get(modelId) === 'downloading') {
      return { ok: false, error: 'Model is downloading' };
    }
    await rm(getLocalTtsModelDir(modelsDir, modelId), { recursive: true, force: true });
    downloadErrors.delete(modelId);
    return { ok: true };
  };

  const shutdown = () => {
    workerClient.shutdown();
  };

  return {
    createSttSession,
    synthesizeSpeech,
    getStatus,
    requestModelDownload,
    deleteModel,
    shutdown,
  };
}
