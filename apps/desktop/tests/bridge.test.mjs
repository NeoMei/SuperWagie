import test from 'node:test';
import assert from 'node:assert/strict';

import { SurfacePolicy } from '../src/main/surface-policy.mjs';

function fixture() {
  const policy = new SurfacePolicy();
  const sender = {
    id: 41,
    isDestroyed: () => false,
    mainFrame: { url: 'superwagie-app://surface/index.html' },
  };
  const credentials = policy.register(sender);
  const event = { sender, senderFrame: sender.mainFrame };
  const payload = (sequence, body = {}) => ({
    surfaceIdentity: credentials.identity,
    surfaceNonce: credentials.nonce,
    sequence,
    body,
  });
  return { policy, sender, event, payload };
}

test('surface policy accepts one authenticated top-frame call', () => {
  const { policy, event, payload } = fixture();
  assert.deepEqual(policy.validate('workspace:query', event, payload(1)), {});
});

test('surface policy rejects child frames, wrong origins, destroyed senders and replay', () => {
  const { policy, sender, event, payload } = fixture();
  assert.throws(() => policy.validate('workspace:query', { ...event, senderFrame: {} }, payload(1)), /SURFACE_MAIN_FRAME_REQUIRED/);
  sender.mainFrame.url = 'https://attacker.invalid/';
  assert.throws(() => policy.validate('workspace:query', event, payload(1)), /SURFACE_ORIGIN_REJECTED/);
  sender.mainFrame.url = 'superwagie-app://surface/index.html';
  sender.isDestroyed = () => true;
  assert.throws(() => policy.validate('workspace:query', event, payload(1)), /SURFACE_DESTROYED/);
  sender.isDestroyed = () => false;
  policy.validate('workspace:query', event, payload(1));
  assert.throws(() => policy.validate('workspace:query', event, payload(1)), /SURFACE_REPLAY_REJECTED/);
});

test('surface policy rejects forged fields and unknown methods', () => {
  const { policy, event, payload } = fixture();
  assert.throws(() => policy.validate('workspace:anything', event, payload(1)), /SURFACE_CHANNEL_REJECTED/);
  assert.throws(() => policy.validate('workspace:query', event, { ...payload(1), actor: 'owner' }), /SURFACE_PAYLOAD_REJECTED/);
  assert.throws(() => policy.validate('workspace:query', event, { ...payload(1), surfaceNonce: 'forged' }), /SURFACE_IDENTITY_REJECTED/);
});
