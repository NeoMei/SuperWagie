import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventNotificationRegistry } from './event-notifications.mjs';

test('macOS removes only the exact event and runtime while preserving unrelated notifications', () => {
  const removed = [];
  const registry = createEventNotificationRegistry({ platform: 'darwin', remove: (ids) => removed.push(ids) });
  registry.track({ tag: 'event-a', runtimeKey: 'local' }, 'target');
  registry.track({ tag: 'event-b', runtimeKey: 'local' }, 'unrelated');
  registry.track({ tag: 'event-a', runtimeKey: 'host:other' }, 'other-host');
  assert.deepEqual(registry.withdraw({ tag: 'event-a', runtimeKey: 'local' }), { status: 'withdrawn', count: 1 });
  assert.deepEqual(removed, [['target']]);
  assert.deepEqual(registry.withdraw({ tag: 'missing', runtimeKey: 'local' }), { status: 'unknown' });
  assert.deepEqual(registry.withdraw({ tag: 'event-b', runtimeKey: 'local' }), { status: 'withdrawn', count: 1 });
});
test('Windows and failed native removal report unsupported or unknown explicitly', () => {
  let removed = false;
  const windows = createEventNotificationRegistry({ platform: 'win32', remove: () => { removed = true; } });
  windows.track({ tag: 'event' }, 'notification');
  assert.deepEqual(windows.withdraw({ tag: 'event' }), { status: 'unsupported' });
  assert.equal(removed, false);
  const mac = createEventNotificationRegistry({ platform: 'darwin', remove: () => { throw new Error('native unavailable'); } });
  mac.track({ tag: 'event' }, 'notification');
  assert.deepEqual(mac.withdraw({ tag: 'event' }), { status: 'unknown' });
});
