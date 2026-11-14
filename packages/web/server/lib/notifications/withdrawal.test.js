import { expect, test } from 'bun:test';
import { createNotificationEmitterRuntime } from './emitter-runtime.js';
import { createNotificationTriggerRuntime } from './runtime.js';
import { notificationEventTag } from './event-identity.js';

test('one event-scoped withdrawal reaches native and live SSE/global clients without a success promise for offline push', () => {
  const native = []; const control = []; const global = [];
  const runtime = createNotificationEmitterRuntime({ process: { stdout: { write() { throw new Error('not a supported retract channel'); } } }, getDesktopNotifyEnabled: () => true, getUiNotificationClients: () => new Set(), getOpenChamberEventClients: () => new Set([{ write: (value) => control.push(value) }]), getBroadcastGlobalUiEvent: () => (event) => global.push(event) });
  runtime.setOnDesktopNotificationWithdraw((event) => { native.push(event); return { status: 'withdrawn' }; });
  expect(runtime.withdrawNotification({ tag: 'target-event' })).toEqual({ native: 'withdrawn', connectedClients: 'unknown', push: 'unsupported' });
  expect(native).toEqual([{ tag: 'target-event' }]);
  expect(global).toHaveLength(1);
  expect(global[0]).toMatchObject({ type: 'openchamber:notification-withdrawn', properties: { tag: 'target-event' } });
  expect(control).toHaveLength(1);
});
test('authoritative replies retract only their exact request; omitted identity cannot retract a whole session', async () => {
  const withdrawn = [];
  const runtime = createNotificationTriggerRuntime({ withdrawNotification: (event) => withdrawn.push(event), buildOpenCodeUrl: (value) => value, getOpenCodeAuthHeaders: () => ({}) });
  await runtime.maybeSendPushForTrigger({ type: 'permission.replied', properties: { sessionID: 'session', requestID: 'request-a', directory: '/project' } });
  const expected = notificationEventTag('permission', { sessionId: 'session', requestId: 'request-a', directory: '/project' });
  expect(withdrawn).toEqual([{ tag: expected }]);
  expect(expected).not.toBe(notificationEventTag('permission', { sessionId: 'session', requestId: 'request-b', directory: '/project' }));
  expect(expected).not.toBe(notificationEventTag('permission', { sessionId: 'session', requestId: 'request-a', directory: '/other' }));
  await runtime.maybeSendPushForTrigger({ type: 'permission.replied', properties: { sessionID: 'session' } });
  expect(withdrawn).toHaveLength(1);
  await runtime.maybeSendPushForTrigger({ type: 'form.settled', properties: { sessionID: 'session', formID: 'form-a', directory: '/project' } });
  expect(withdrawn).toHaveLength(2);
});
