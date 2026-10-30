import express from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { summarizeText, sanitizeForTTS, sanitizeForNote } from '../text/summarization.js';

import { detectTextLanguage, languageOfLocale, pickVoiceForLanguage } from './language-detect.js';
import { ENTERPRISE_MODE_ERROR, isEnterpriseMode } from '../enterprise-mode.js';
import { describeVoiceKeys, readVoiceKey, updateVoiceKeys } from './voice-keys.js';
import { configuredProviderError } from './provider-errors.js';
import { ConfiguredSpeechError, generateConfiguredSpeech } from '../model-configuration/speech.js';

// HTTP header values must be printable latin1; macOS voice names can be localized
// (e.g. "Milena (Русский (Россия))") and Node rejects non-latin1 header content
// outright. Percent-encode so the X-Speech-Voice header is always safe.
export function speechVoiceHeaderValue(voice) {
  return encodeURIComponent(voice);
}

const speechTextSchema = z.string().trim().min(1);
const sayRateSchema = z.number().finite().positive();
const managedTransportSchema = z.object({ admitMediaTask: z.function(), mediaDispatch: z.function() });

export function registerTtsRoutes(app, { sayTTSCapability, resolveModelBinding = async () => null, getPlatformModelRuntime = () => null, resolvePlatformIdentity }) {
  let ttsModulePromise = null;
  const getTtsModule = async () => {
    if (!ttsModulePromise) {
      ttsModulePromise = import('./index.js');
    }
    return ttsModulePromise;
  };

  // Which voice keys are stored; the keys themselves never leave the server.
  app.get('/api/voice/keys', (_req, res) => {
    res.json(describeVoiceKeys());
  });

  app.put('/api/voice/keys', express.json({ limit: '16kb' }), (req, res) => {
    try {
      res.json(updateVoiceKeys(req.body));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid voice keys' });
    }
  });

  app.post('/api/voice/token', async (req, res) => {
    console.log('[Voice] Token request received:', {
      contentType: req.headers['content-type'] || null,
    });
    try {
      if (isEnterpriseMode()) {
        return res.status(403).json({ allowed: false, error: ENTERPRISE_MODE_ERROR });
      }
      const openaiApiKey = process.env.OPENAI_API_KEY;
      console.log('[Voice] OpenAI API Key present:', !!openaiApiKey);

      if (!openaiApiKey) {
        return res.status(503).json({
          allowed: false,
          error: 'OpenAI voice service not configured. Set OPENAI_API_KEY environment variable.'
        });
      }

      // Return success - OpenAI TTS is available
      res.json({
        allowed: true,
        provider: 'openai',
        message: 'OpenAI TTS is available'
      });
    } catch (error) {
      console.error('[Voice] Token generation error:', error);
      res.status(500).json({
        allowed: false,
        error: 'Voice service error'
      });
    }
  });

  // Server-side TTS endpoint - streams audio from OpenAI TTS API
  app.post('/api/tts/speak', async (req, res) => {
    let usesConfiguredProvider = false;
    try {
      const { text, speed = 0.9, instructions, apiKey } = req.body || {};
      if (!speechTextSchema.safeParse(text).success) {
        return res.status(400).json({ error: 'Text is required' });
      }
      const binding = await resolveModelBinding('tts', { supportedProtocols: ['openai-compatible', 'minimax', 'managed-media'] });
      usesConfiguredProvider = Boolean(binding);
      if (binding?.protocol === 'managed-media') {
        const runtime = getPlatformModelRuntime?.();
        if (!runtime?.mediaDispatch || !z.function().safeParse(resolvePlatformIdentity).success) {
          return res.status(503).json({ error: 'Managed media transport unavailable' });
        }
        if (runtime.isMediaOperationConfigured?.(binding.model, 'speech') !== true) {
          return res.status(503).json({ code: 'platform_media_recovery_unavailable', error: 'Managed speech is temporarily unavailable until interrupted requests can be recovered safely.' });
        }
        try {
          const identity = await resolvePlatformIdentity(req, res, { allowUrlToken: false });
          const admitted = await runtime.admitMediaTask(identity, { model: { providerID: 'unihub', id: binding.model } });
          const result = await runtime.mediaDispatch({
            identity,
            sessionID: admitted.sessionID,
            callID: 'tts_' + globalThis.crypto.randomUUID(),
            model: binding.model,
            operation: 'speech',
            inputs: { text: text.trim(), voice: binding?.parameters?.voice || req.body?.voice || 'Cherry' },
          });
          res.setHeader('Content-Type', result.contentType);
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Content-Length', result.buffer.length);
          return res.send(result.buffer);
        } catch (error) {
          console.error('[TTS] Managed media dispatch failed:', error.code ?? error.message);
          return res.status(error.status ?? 502).json({ error: error.code === 'platform_model_scope_restart_required' ? error.code : 'Managed media transport failed' });
        }
      }
      if (binding?.protocol === 'minimax') {
        const result = await generateConfiguredSpeech(binding, { text, speed });
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Length', result.buffer.length);
        return res.send(result.buffer);
      }
      const voice = binding?.parameters.voice || req.body?.voice || 'nova';
      const model = binding?.model || req.body?.model || 'gpt-4o-mini-tts';
      const baseURL = binding?.baseUrl || req.body?.baseURL;
      const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL, { allowConfiguredRemote: Boolean(binding) });
      if (normalizedBaseURLResult.error) {
        return res.status(400).json({ error: normalizedBaseURLResult.error });
      }
      const normalizedBaseURL = normalizedBaseURLResult.value;

      console.log('[TTS] Request received:', { voice, model, speed, textLength: text?.length, hasApiKey: !!apiKey, hasBaseURL: !!baseURL });

      // Without a custom server this is OpenAI's cloud; a custom one has
      // already been held to this machine by the URL check above.
      if (isEnterpriseMode() && !normalizedBaseURL) {
        return res.status(403).json({ error: ENTERPRISE_MODE_ERROR });
      }

      // Dynamically import the TTS service (ESM)
      const { ttsService } = await getTtsModule();

      // Check availability - server-configured key, client-provided key, or custom server URL
      const hasServerKey = binding ? false : await ttsService.isAvailable();
      const hasCustomBaseURL = typeof normalizedBaseURL === 'string' && normalizedBaseURL.length > 0;
      // The key stored for this kind of server; a key in the body is what
      // clients from before the server kept them sent, and still wins.
      const requestKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;
      const clientKey = binding ? binding.apiKey : requestKey ?? readVoiceKey(hasCustomBaseURL ? 'openaiCompatible' : 'openai');
      const hasClientKey = Boolean(clientKey);

      if (!hasServerKey && !hasClientKey && !hasCustomBaseURL) {
        return res.status(503).json({ 
          error: 'TTS service not available. Please configure OpenAI in OpenCode, provide an API key, or set a custom server URL in settings.' 
        });
      }

      let textToSpeak = text.trim();

      // Historical summarize request fields are intentionally ignored. The
      // model-backed summarization provider is retired.

      const result = await ttsService.generateSpeechStream({
        text: textToSpeak,
        voice,
        model,
        speed,
        instructions,
        apiKey: clientKey,
        baseURL: hasCustomBaseURL ? normalizedBaseURL : undefined,
        configured: Boolean(binding),
      });

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', result.buffer.length);
      res.send(result.buffer);
      } catch (error) {
        const failure = usesConfiguredProvider && !(error instanceof ConfiguredSpeechError) ? configuredProviderError('speech') : error;
        console.error('[TTS] Generation failed:', failure.code || 'generation_failed');
        if (!res.headersSent) {
          const { model: m, voice: v, baseURL: b } = req.body || {};
          res.status(failure.status || 500).json({
            error: failure instanceof Error ? failure.message : 'TTS generation failed',
            ...(failure.code ? { code: failure.code } : {}),
            detail: { model: m, voice: v, hasBaseURL: !!b },
          });
        }
      }
  });

  app.post('/api/text/summarize', async (req, res) => {
    try {
      const { text, threshold = 200, maxLength = 500, mode } = req.body || {};

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }
      const result = await summarizeText({
        text,
        threshold,
        maxLength,
        mode: typeof mode === 'string' ? mode : 'tts',
      });

      return res.json(result);
    } catch (error) {
      console.error('[Summarize] Error:', error);
      const sanitized = typeof req.body?.mode === 'string' && req.body.mode === 'note'
        ? sanitizeForNote(req.body?.text || '')
        : sanitizeForTTS(req.body?.text || '');
      return res.json({ summary: sanitized, summarized: false, reason: error.message });
    }
  });

       
  // TTS status endpoint
  app.get('/api/tts/status', async (_req, res) => {
    try {
      const enterpriseMode = isEnterpriseMode();
      let binding;
      try {
        binding = await resolveModelBinding('tts', { supportedProtocols: ['openai-compatible', 'minimax', 'managed-media'] });
      } catch {
        // Resolution failure is not authoritative absence. Keep playback on the
        // configured path until the saved binding can be read or cleared.
        return res.json({ available: false, configuredBinding: true, enterpriseMode, error: 'Configured speech is unavailable' });
      }
      const { ttsService } = await getTtsModule();
      const managed = binding?.protocol === 'managed-media';
      const runtime = managed ? getPlatformModelRuntime?.() : null;
      const managedModel = binding?.model;
      const managedReady = managed && !enterpriseMode && runtime?.enabled?.() === true
        && managedTransportSchema.safeParse(runtime).success
        && z.function().safeParse(resolvePlatformIdentity).success
        && runtime.isMediaOperationConfigured?.(managedModel, 'speech') === true;
      const status = {
        configuredBinding: Boolean(binding),
        available: managed ? managedReady : Boolean(binding) || (!enterpriseMode && await ttsService.isAvailable()),
        enterpriseMode,
        voices: managed ? [binding?.parameters?.voice || 'Cherry'] : binding?.protocol === 'minimax' ? [binding.parameters.voice || 'male-qn-qingse'] : [
          'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
          'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
        ]
      };
      if (managed) {
        status.accountAuthorization = 'not_checked';
        status.modelCapability = 'not_checked';
      }
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: 'Failed to check TTS status' });
    }
  });

  // The startup probe runs concurrently with server bootstrap. An unusually
  // early status request waits for that same authoritative result.
  app.get('/api/tts/say/status', async (_req, res) => {
    res.json(await sayTTSCapability);
  });

  // macOS 'say' command TTS speak endpoint
  app.post('/api/tts/say/speak', async (req, res) => {
    try {
      const { text, rate = 200, language, languageSample } = req.body || {};
      let voice = typeof req.body?.voice === 'string' && req.body.voice.trim() ? req.body.voice.trim() : 'Samantha';
      
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }
      if (!sayRateSchema.safeParse(rate).success) {
        return res.status(400).json({ error: 'A positive numeric speech rate is required' });
      }
      
      // Check if we're on macOS
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'macOS say command not available on this platform' });
      }

      // `language: 'auto'`: keep the chosen voice while it speaks the text's
      // language, otherwise switch to an installed voice that does. A
      // language with no installed voice keeps the chosen voice — say still
      // reads the text, just with an accent — rather than failing.
      let resolvedLanguage = null;
      if (language === 'auto') {
        const capability = await sayTTSCapability;
        const voices = Array.isArray(capability?.voices) ? capability.voices : [];
        const sample = typeof languageSample === 'string' && languageSample.trim() ? languageSample.slice(0, 4000) : text;
        resolvedLanguage = detectTextLanguage(sample).language;
        const chosen = voices.find((entry) => entry.name === voice);
        if (languageOfLocale(chosen?.locale) !== resolvedLanguage) {
          const match = pickVoiceForLanguage(resolvedLanguage, voices);
          if (match) voice = match;
        }
      }
      
      console.log('[TTS-Say] Generating speech:', { textLength: text.length, voice, rate });

      // A private directory isolates concurrent requests and keeps text out of
      // the process argument list; execFile never interprets voice as shell.
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openchamber-say-'));
      let audioBuffer;
      try {
        const inputFile = path.join(tempDir, 'input.txt');
        const outputFile = path.join(tempDir, 'output.m4a');
        await writeFile(inputFile, text.trim(), { mode: 0o600 });
        await promisify(execFile)('say', ['-v', voice, '-r', String(rate), '-o', outputFile, '--data-format=aac', '-f', inputFile]);
        audioBuffer = await readFile(outputFile);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
      
      // Send audio response
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('X-Speech-Voice', speechVoiceHeaderValue(voice));
      if (resolvedLanguage) res.setHeader('X-Speech-Language', resolvedLanguage);
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
      
    } catch (error) {
      console.error('[TTS-Say] Error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Say command failed'
      });
    }
  });

  // Server-side STT: receive raw audio, proxy to OpenAI-compatible transcription endpoint
  app.post(
    '/api/stt/transcribe',
    express.raw({ type: (req) => (req.headers['content-type'] || '').startsWith('audio/'), limit: '20mb' }),
    async (req, res) => {
      let usesConfiguredProvider = false;
      try {
        const mimeType = (req.headers['content-type'] || 'audio/webm').split(',')[0].trim();
        const binding = await resolveModelBinding('stt-short', { supportedProtocols: ['openai-compatible', 'managed-media'] });
        usesConfiguredProvider = Boolean(binding);
        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Audio data is required' });
        }
        if (binding?.protocol === 'managed-media') {
          const runtime = getPlatformModelRuntime?.();
          if (!runtime?.mediaDispatch || typeof resolvePlatformIdentity !== 'function') {
            return res.status(503).json({ error: 'Managed media transport unavailable' });
          }
          if (runtime.isMediaOperationConfigured?.(binding.model, 'transcription') !== true) {
            return res.status(503).json({ code: 'platform_media_recovery_unavailable', error: 'Managed transcription is temporarily unavailable until interrupted requests can be recovered safely.' });
          }
          try {
            const identity = await resolvePlatformIdentity(req, res, { allowUrlToken: false });
            const admitted = await runtime.admitMediaTask(identity, { model: { providerID: 'unihub', id: binding.model } });
            const audioDataUri = 'data:' + mimeType + ';base64,' + req.body.toString('base64');
            const result = await runtime.mediaDispatch({
              identity,
              sessionID: admitted.sessionID,
              callID: 'stt_' + crypto.randomUUID(),
              model: binding.model,
              operation: 'transcription',
              inputs: { audioDataUri },
            });
            return res.json({ transcript: result.transcript ?? '' });
          } catch (error) {
            console.error('[STT] Managed media dispatch failed:', error.code ?? error.message);
            return res.status(error.status ?? 502).json({ error: error.code === 'platform_model_scope_restart_required' ? error.code : 'Managed media transport failed' });
          }
        }
        const { transcribeAudio } = await import('./stt.js');

        const baseURL = binding?.baseUrl || (typeof req.headers['x-base-url'] === 'string' ? req.headers['x-base-url'].trim() : '');
        const model = binding?.model || (typeof req.headers['x-model'] === 'string' && req.headers['x-model'].trim().length > 0
          ? req.headers['x-model'].trim()
          : 'deepdml/faster-whisper-large-v3-turbo-ct2');
        const language = typeof req.headers['x-language'] === 'string' && req.headers['x-language'].trim().length > 0
          ? req.headers['x-language'].trim()
          : undefined;
        const authHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].trim() : '';
        const apiKey = binding ? binding.apiKey : (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined) || readVoiceKey('stt');

        if (!baseURL) {
          return res.status(400).json({ error: 'X-Base-URL header is required' });
        }

        console.log('[STT] Transcribing audio:', {
          bytes: req.body.length,
          mimeType,
          model,
          baseURL,
          language,
          hasApiKey: !!apiKey,
        });

        const transcript = await transcribeAudio({
          audioBuffer: req.body,
          mimeType,
          model,
          baseURL,
          apiKey,
          language: binding?.parameters.language || language,
          configured: Boolean(binding),
        });

        res.json({ transcript: transcript ?? '' });
      } catch (error) {
        const failure = usesConfiguredProvider ? configuredProviderError('transcription') : error;
        console.error('[STT] Transcription failed:', failure.code || 'transcription_failed');
        if (!res.headersSent) {
          res.status(failure.status || 500).json({
            error: failure instanceof Error ? failure.message : 'Transcription failed',
            ...(failure.code ? { code: failure.code } : {}),
          });
        }
      }
    }
  );
}
