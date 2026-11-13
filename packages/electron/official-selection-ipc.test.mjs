import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isAppShortcutFrame } from './menu-shortcuts.mjs';
const { createOfficialSelectionIpc } = await import(process.env.OC_OFFICIAL_IPC_MODULE || './official-selection-ipc.mjs');

const fixture = () => {
  const frame = { url: 'openchamber-ui://app/index.html', origin: 'openchamber-ui://app', parent: null };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  const calls = [];
  let controller = {
    select: async (request) => { calls.push(request); return { selected: request.isCurrent() }; },
    revoke: async (request) => { calls.push(request); return { revoked: request.isCurrent() }; },
    creationApproval: async (request) => { calls.push(request); return { nativeApproval: request.isCurrent() }; },
  };
  const invoke = createOfficialSelectionIpc({
    isFrameAllowed: (candidate) => isAppShortcutFrame(candidate, window, 'http://127.0.0.1:5180'),
    isLocalTarget: (target) => target === 'http://127.0.0.1:57123',
    getController: () => controller, resolveAuthentication: async () => ({ kind: 'bearer', token: 'native-owned-test-credential' }),
  });
  return { event, frame, sender, calls, invoke, setController: (value) => { controller = value; },
    request: () => ({ operationId: crypto.randomUUID(), apiBaseUrl: 'http://127.0.0.1:57123', input: { projectId: 'a' } }) };
};
test('only tracked current app top frames invoke the embedded selection capability', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke(f.event, 'desktop_official_select', f.request()), { selected: true });
  const badFrames = [
    { ...f.frame, origin: 'https://remote.example', url: 'https://remote.example/' },
    { ...f.frame, parent: f.frame },
    { ...f.frame },
  ];
  for (const frame of badFrames) {
    await assert.rejects(f.invoke({ ...f.event, senderFrame: frame }, 'desktop_official_select', f.request()));
  }
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.invoke(f.event, 'desktop_official_select', { ...f.request(), apiBaseUrl: 'https://remote.example' }));
  f.setController(null);
  await assert.rejects(f.invoke(f.event, 'desktop_official_select', f.request()));
});
test('creation approval uses the same actual top-frame authority and excludes remote targets', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke(f.event, 'desktop_creation_approval', f.request()), { nativeApproval: true });
  await assert.rejects(f.invoke({ ...f.event, senderFrame: { ...f.frame, parent: f.frame } }, 'desktop_creation_approval', f.request()));
  await assert.rejects(f.invoke(f.event, 'desktop_creation_approval', { ...f.request(), apiBaseUrl: 'https://remote.example' }));
  assert.equal(f.calls.length, 1);
});
test('creation admission rejects a lease canceled or replaced while its controller response is awaited', async () => {
  for (const reason of ['cancel', 'frame', 'controller']) {
    const f = fixture();
    const request = f.request();
    f.setController({ creationApproval: async () => {
      if (reason === 'cancel') await f.invoke(f.event, 'desktop_official_selection_cancel', { operationId: request.operationId });
      if (reason === 'frame') f.sender.mainFrame = { ...f.frame };
      if (reason === 'controller') f.setController(null);
      return { type: 'claim', dispatch: true };
    } });
    await assert.rejects(f.invoke(f.event, 'desktop_creation_approval', request));
  }
});
test('HMR app frame has the same narrow authority and revoke keeps native account credentials private', async () => {
  const f = fixture();
  f.frame.origin = 'http://127.0.0.1:5180'; f.frame.url = 'http://127.0.0.1:5180/';
  const request = f.request(); delete request.input; request.id = crypto.randomUUID();
  assert.deepEqual(await f.invoke(f.event, 'desktop_official_revoke', request), { revoked: true });
  assert.deepEqual(f.calls[0].authentication, { kind: 'bearer', token: 'native-owned-test-credential' });
});
test('cancel, frame replacement and embedded runtime replacement retire pending authority', async () => {
  for (const reason of ['cancel', 'frame', 'runtime']) {
    const f = fixture(); let release; const blocked = new Promise((resolve) => { release = resolve; });
    let started; const entering = new Promise((resolve) => { started = resolve; });
    f.setController({ select: async (request) => { started(); await blocked; return { selected: request.isCurrent() }; } });
    const request = f.request(); const pending = f.invoke(f.event, 'desktop_official_select', request); await entering;
    if (reason === 'cancel') await f.invoke(f.event, 'desktop_official_selection_cancel', { operationId: request.operationId });
    if (reason === 'frame') f.sender.mainFrame = { ...f.frame };
    if (reason === 'runtime') f.setController(null);
    release(); assert.deepEqual(await pending, { selected: false });
  }
});
