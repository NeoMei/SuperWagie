/**
 * Local read-aloud worker process.
 *
 * Hosts sherpa-onnx offline TTS inference in a separate process so synthesis
 * never blocks the main OpenChamber server. Communicates with the parent over
 * child_process IPC (advanced serialization, so Buffers survive the trip as
 * Uint8Array). Transcription uses the server-resolved LLMRouter ASR binding
 * and has no local recognizer in this worker.
 *
 * Request/response protocol (parent -> worker):
 *   { type: 'tts.synthesize', requestId, modelsDir, modelId, text, speakerId?, speed? }
 * Worker -> parent:
 *   { type: 'response', requestId, ok, result?, error? }
 */

import { SherpaTtsEngine } from './sherpa-tts.js';
import { getLocalTtsModelDir, getLocalTtsModelSpec } from './model-catalog.js';
import { pcm16ToWav } from '../audio.js';

process.title = 'OpenChamber Dictation';

const ttsEngines = new Map();
let ipcClosing = false;

function sendToParent(message) {
  if (ipcClosing || !process.connected || !process.send) {
    return;
  }
  try {
    process.send(message, (error) => {
      if (error) {
        ipcClosing = true;
      }
    });
  } catch {
    ipcClosing = true;
  }
}

function sendOk(requestId, result) {
  sendToParent({ type: 'response', requestId, ok: true, ...(result !== undefined ? { result } : {}) });
}

function getTtsEngine(modelsDir, modelId) {
  const key = `${modelsDir}:${modelId}`;
  const existing = ttsEngines.get(key);
  if (existing) {
    return existing;
  }
  const spec = getLocalTtsModelSpec(modelId);
  const created = new SherpaTtsEngine({
    modelDir: getLocalTtsModelDir(modelsDir, modelId),
    type: spec.type,
    files: spec.files,
    lexicon: spec.lexicon,
    numThreads: 2,
  });
  ttsEngines.set(key, created);
  return created;
}

async function handleRequest(message) {
  switch (message.type) {
    case 'tts.synthesize': {
      const engine = getTtsEngine(message.modelsDir, message.modelId);
      const { pcm16, sampleRate } = engine.synthesize(message.text, {
        speakerId: message.speakerId,
        speed: message.speed,
      });
      sendOk(message.requestId, {
        audio: pcm16ToWav(pcm16, sampleRate),
        format: 'audio/wav',
      });
      return;
    }
    default: {
      throw new Error(`Unknown dictation worker request: ${message?.type}`);
    }
  }
}

process.on('message', (message) => {
  void handleRequest(message).catch((error) => {
    sendToParent({
      type: 'response',
      requestId: message?.requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'Dictation worker request failed',
    });
  });
});

process.once('disconnect', () => {
  ipcClosing = true;
  for (const tts of ttsEngines.values()) {
    tts.free();
  }
  process.exit(0);
});
