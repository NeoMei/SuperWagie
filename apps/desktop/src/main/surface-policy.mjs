import { randomBytes } from 'node:crypto';

const CHANNELS = new Set([
  'workspace:choose-project',
  'workspace:activate-project',
  'workspace:query',
  'workspace:command',
  'workspace:draft',
  'workspace:checkpoint-ready',
  'workspace:subscribe',
]);
const PAYLOAD_KEYS = ['body', 'sequence', 'surfaceIdentity', 'surfaceNonce'];
const TRUSTED_ORIGIN = 'superwagie-app://surface/index.html';

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export class SurfacePolicy {
  constructor() {
    this.records = new Map();
    this.counter = 0;
  }

  issue() {
    return Object.freeze({
      identity: `app_ui:surface-${++this.counter}`,
      nonce: randomBytes(24).toString('hex'),
    });
  }

  register(webContents, credentials = this.issue()) {
    if (!webContents || !Number.isSafeInteger(webContents.id)) throw new Error('SURFACE_INVALID');
    const record = {
      identity: credentials.identity,
      nonce: credentials.nonce,
      lastSequence: 0,
      webContents,
    };
    this.records.set(webContents.id, record);
    return credentials;
  }

  destroy(webContents) {
    if (webContents) this.records.delete(webContents.id);
  }

  acceptsWebContentsId(webContentsId) {
    const record = this.records.get(webContentsId);
    return Boolean(record && !record.webContents.isDestroyed());
  }

  validate(channel, event, payload) {
    if (!CHANNELS.has(channel)) throw new Error('SURFACE_CHANNEL_REJECTED');
    const record = this.records.get(event?.sender?.id);
    if (!record || record.webContents !== event.sender) throw new Error('SURFACE_IDENTITY_REJECTED');
    if (event.sender.isDestroyed()) throw new Error('SURFACE_DESTROYED');
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('SURFACE_MAIN_FRAME_REQUIRED');
    if (event.sender.mainFrame?.url !== TRUSTED_ORIGIN) throw new Error('SURFACE_ORIGIN_REJECTED');
    if (!exactKeys(payload, PAYLOAD_KEYS)
      || !payload.body || typeof payload.body !== 'object' || Array.isArray(payload.body)
      || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1) {
      throw new Error('SURFACE_PAYLOAD_REJECTED');
    }
    if (payload.surfaceIdentity !== record.identity || payload.surfaceNonce !== record.nonce) {
      throw new Error('SURFACE_IDENTITY_REJECTED');
    }
    if (payload.sequence <= record.lastSequence) throw new Error('SURFACE_REPLAY_REJECTED');
    record.lastSequence = payload.sequence;
    return payload.body;
  }
}

export const SURFACE_CHANNELS = Object.freeze([...CHANNELS]);
