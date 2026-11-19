import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const callIDSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const waveTypes = new Set(['audio/wav', 'audio/wave', 'audio/x-wav']);
function isPcmWave(audio) {
  if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return false;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const length = audio.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + length > audio.length) return false;
    if (audio.toString('ascii', offset, offset + 4) === 'fmt ') {
      return length >= 16 && audio.readUInt16LE(data) === 1 && audio.readUInt16LE(data + 14) === 16;
    }
    offset = data + length + (length % 2);
  }
  return false;
}
const publicErrors = new Map([
  ['invalid_media_request', 'Invalid audio request'],
  ['managed_audio_wav_required', 'Managed transcription requires PCM WAV audio'],
  ['native_media_too_large', 'Audio request is too large'],
  ['platform_auth_required', 'UniHub account login is required'],
  ['platform_media_recovery_unavailable', 'Managed media recovery is temporarily unavailable'],
  ['platform_model_scope_restart_required', 'Sign in again to restore managed media access'],
  ['platform_reconciliation_required', 'The original request is still being reconciled'],
  ['platform_model_credits_required', 'Product credits are insufficient'],
  ['product_membership_expired', 'Product membership has expired'],
]);

function refuse(code, status) {
  throw Object.assign(new Error(code), { code, status });
}

export function managedAudioCallID(value, prefix) {
  const parsed = callIDSchema.safeParse(value ?? (prefix + '_' + randomUUID()));
  if (!parsed.success) refuse('invalid_media_request', 400);
  return parsed.data;
}

export function managedAudioFailure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  const message = publicErrors.get(error?.code);
  return {
    status,
    body: message ? { code: error.code, error: message } : { error: 'Managed media transport failed' },
  };
}

export async function transcribeManagedAudio({ runtime, identity, model, callID, audio, mimeType }) {
  if (!identity) refuse('platform_auth_required', 401);
  const type = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (!waveTypes.has(type) || !isPcmWave(audio)) refuse('managed_audio_wav_required', 415);
  const admitted = await runtime.admitMediaTask(identity, { model: { providerID: 'unihub', id: model } });
  const result = await runtime.mediaDispatch({
    identity,
    sessionID: admitted.sessionID,
    callID,
    model,
    operation: 'transcription',
    inputs: { audioDataUri: 'data:audio/wav;base64,' + audio.toString('base64') },
  });
  return result.transcript;
}
