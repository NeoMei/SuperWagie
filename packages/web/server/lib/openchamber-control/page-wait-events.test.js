import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createPageAnswers } from './render-page.js';
import { createPageWaitChangeHandler } from './page-wait-events.js';
import { createSessionRuntime } from '../opencode/session-runtime.js';
import { createNotificationTriggerRuntime } from '../notifications/runtime.js';
import { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';
import { notificationEventTag } from '../notifications/event-identity.js';
import { createEventNotificationRegistry } from '../../../../electron/event-notifications.mjs';

const createPageRuntime = () => {
  const delivered = new Map();
  const removed = [];
  const uiEvents = [];
  const controlFrames = [];
  const deliveryWaiters = [];
  const native = createEventNotificationRegistry({
    platform: 'darwin',
    remove: (ids) => {
      removed.push(...ids);
      for (const id of ids) delivered.delete(id);
    },
  });
  let sequence = 0;
  const emitter = createNotificationEmitterRuntime({
    getDesktopNotifyEnabled: () => true,
    getUiNotificationClients: () => new Set(),
    getOpenChamberEventClients: () => new Set([{ write: (frame) => controlFrames.push(frame) }]),
    getBroadcastGlobalUiEvent: () => (event) => uiEvents.push(event),
    onDesktopNotification: (event) => {
      const id = `delivered-${++sequence}`;
      delivered.set(id, event);
      native.track(event, id);
      deliveryWaiters.shift()?.(id);
    },
  });
  emitter.setOnDesktopNotificationWithdraw(native.withdraw);
  const notifications = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnQuestion: true }),
    buildTemplateVariables: async () => ({}),
    resolveNotificationTemplate: () => '',
    shouldApplyResolvedTemplateMessage: () => false,
    emitDesktopNotification: emitter.emitDesktopNotification,
    broadcastUiNotification: emitter.broadcastUiNotification,
    withdrawNotification: emitter.withdrawNotification,
  });
  const sessions = createSessionRuntime({ writeSseEvent: emitter.writeSseEvent, getNotificationClients: () => new Set() });
  const pages = createPageAnswers({
    onWaitChange: createPageWaitChangeHandler({
      sessionRuntime: sessions,
      broadcastOpenChamberUiEvent: (event) => uiEvents.push(event),
      maybeSendPushForTrigger: notifications.maybeSendPushForTrigger,
    }),
  });
  return {
    pages, sessions, delivered, removed, uiEvents, controlFrames,
    nextDelivery: () => new Promise((resolve) => deliveryWaiters.push(resolve)),
  };
};

test('server entrypoint composes the tested page lifecycle handler with the live session, UI and notification owners', async () => {
  const source = await readFile(new URL('../../index.js', import.meta.url), 'utf8');
  expect(source).toContain("import { createPageWaitChangeHandler } from './lib/openchamber-control/page-wait-events.js';");
  expect(source).toContain('onPageWaitChange: createPageWaitChangeHandler({ sessionRuntime, broadcastOpenChamberUiEvent, maybeSendPushForTrigger }),');
});

for (const settlement of ['answer', 'abort']) {
  test(`${settlement} retracts an already delivered page notification and preserves another page in the same session`, async () => {
    const fixture = createPageRuntime();
    const { pages, sessions, delivered, removed, uiEvents, controlFrames } = fixture;
    const unrelatedAbort = new AbortController();
    const targetAbort = new AbortController();
    try {
      const unrelatedDelivery = fixture.nextDelivery();
      const unrelatedPage = pages.wait({ sessionId: 'session', callId: 'other-page', title: 'Other question', directory: '/project', signal: unrelatedAbort.signal });
      // Observe abort rejection before fixture cleanup.
      const unrelatedResult = unrelatedPage.catch((error) => error);
      const unrelatedId = await unrelatedDelivery;

      const targetDelivery = fixture.nextDelivery();
      const targetPage = pages.wait({ sessionId: 'session', callId: 'target-page', title: 'Target question', directory: '/project', signal: targetAbort.signal });
      const targetResult = targetPage.catch((error) => error);
      const targetId = await targetDelivery;
      const targetTag = delivered.get(targetId).tag;
      expect(targetTag).toBe(notificationEventTag('page', { sessionId: 'session', requestId: 'target-page', directory: '/project' }));
      expect([...delivered.keys()]).toEqual([unrelatedId, targetId]);
      expect(sessions.getPendingBlockingRequestsSnapshot().session.pages.map((page) => page.id)).toEqual(['other-page', 'target-page']);

      if (settlement === 'answer') pages.answer({ sessionId: 'session', callId: 'target-page', summary: 'Chosen' });
      else targetAbort.abort();
      const result = await targetResult;
      if (settlement === 'answer') expect(result).toMatchObject({ answered: true, summary: 'Chosen' });
      else expect(result).toMatchObject({ statusCode: 499 });

      expect(removed).toEqual([targetId]);
      expect([...delivered.keys()]).toEqual([unrelatedId]);
      expect(sessions.getPendingBlockingRequestsSnapshot().session.pages.map((page) => page.id)).toEqual(['other-page']);
      expect(uiEvents.filter((event) => event.type === 'openchamber:page-settled')).toEqual([{
        type: 'openchamber:page-settled', properties: { sessionID: 'session', pageID: 'target-page', directory: '/project' },
      }]);
      expect(uiEvents.filter((event) => event.type === 'openchamber:notification-withdrawn')).toEqual([
        expect.objectContaining({ properties: expect.objectContaining({ tag: targetTag }) }),
      ]);
      expect(controlFrames.filter((frame) => frame.includes('openchamber:notification-withdrawn'))).toHaveLength(1);

      unrelatedAbort.abort();
      await unrelatedResult;
    } finally {
      targetAbort.abort();
      unrelatedAbort.abort();
      sessions.dispose();
    }
  });
}
