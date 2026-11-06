import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { parseMenuShortcutSnapshot, menuShortcutAccelerator, createWindowMenuShortcuts, isAppShortcutFrame, attachShortcutSequence } from './menu-shortcuts.mjs';

test('native snapshots parse aliases, missing and explicit empty bindings', () => {
  const map = parseMenuShortcutSnapshot({ shortcuts: { new_window: 'cmd+option+u', zoom_out: '', ghost: 5 } }, 'darwin');
  assert.equal(map.new_window, 'mod+alt+u');
  assert.equal(menuShortcutAccelerator('new_window', map), 'CommandOrControl+Alt+U');
  assert.equal(menuShortcutAccelerator('zoom_out', map), undefined);
  assert.equal(menuShortcutAccelerator('zoom_in', map), 'CommandOrControl+=');
  assert.deepEqual(parseMenuShortcutSnapshot({ shortcuts: {} }, 'win32'), {});
});

test('malformed maps and known values are rejected atomically', () => {
  for (const shortcuts of [null, [], true, 3, 'x', { new_window: 3 }, { new_window: null }, { new_window: undefined }]) {
    assert.throws(() => parseMenuShortcutSnapshot({ shortcuts }, 'darwin'));
  }
  for (const combo of ['mod+a+b', 'mod+k b', 'shift+b', 'f1', 'mod', 'foo+b', 'mod++b', '__unassigned__']) {
    assert.throws(() => parseMenuShortcutSnapshot({ shortcuts: { new_window: combo } }, 'darwin'), combo);
  }
  for (const args of [null, undefined, [], 'x', {}]) assert.throws(() => parseMenuShortcutSnapshot(args, 'darwin'));
});

test('fixed reservations and physical duplicate native accelerators cannot be replaced', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const combo of ['mod+b', 'mod+shift+f', 'mod+w']) {
      assert.throws(() => parseMenuShortcutSnapshot({ shortcuts: { new_window: combo } }, platform));
    }
    assert.throws(() => parseMenuShortcutSnapshot({ shortcuts: { new_window: 'mod+0' } }, platform));
    assert.doesNotThrow(() => parseMenuShortcutSnapshot({ shortcuts: { new_window: 'mod+0', zoom_reset: '' } }, platform));
  }
  assert.doesNotThrow(() => parseMenuShortcutSnapshot({ shortcuts: { new_window: 'ctrl+b' } }, 'darwin'));
  assert.throws(() => parseMenuShortcutSnapshot({ shortcuts: { new_window: 'ctrl+b' } }, 'win32'));
});

const windowFixture = (id = 1) => {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  const frame = { parent: null, origin: 'openchamber-ui://app', url: 'openchamber-ui://app/' };
  const ignored = [];
  Object.assign(contents, { mainFrame: frame, isDestroyed: () => false, setIgnoreMenuShortcuts: value => ignored.push(value) });
  Object.assign(window, { id, webContents: contents, isDestroyed: () => false, isFocused: () => true });
  return { window, contents, frame, ignored, event: { sender: contents, senderFrame: frame } };
};

test('only the current app-owned top frame can mutate native shortcut state', () => {
  const f = windowFixture();
  assert.equal(isAppShortcutFrame(f.event, f.window), true);
  for (const frame of [null, { ...f.frame }, { ...f.frame, parent: f.frame }]) {
    assert.equal(isAppShortcutFrame({ ...f.event, senderFrame: frame }, f.window), false);
  }
  for (const origin of ['https://foreign.test', 'null', 'openchamber-ui://app.evil', 'http://127.0.0.1:5173']) {
    f.frame.origin = origin; f.frame.url = origin + '/';
    assert.equal(isAppShortcutFrame(f.event, f.window), false);
  }
  assert.equal(isAppShortcutFrame(f.event, f.window, 'http://127.0.0.1:5173'), true);
  f.frame.url = 'http://127.0.0.1:5174/';
  assert.equal(isAppShortcutFrame(f.event, f.window, 'http://127.0.0.1:5173'), false);
});

test('focused window owns both menu language and bindings, invalid updates retain them', () => {
  const a = windowFixture(1).window, b = windowFixture(2).window;
  let focused = a;
  const applied = [];
  const menus = createWindowMenuShortcuts({ platform: 'darwin', getFocusedWindow: () => focused, apply: value => applied.push(value) });
  menus.attach(a); menus.attach(b);
  menus.setLocale(a, 'zh-CN');
  menus.setShortcuts(a, { shortcuts: { zoom_in: 'mod+alt+u' } });
  const count = applied.length;
  menus.setShortcuts(b, { shortcuts: { zoom_in: 'mod+alt+y' } }); menus.setLocale(b, 'en');
  assert.equal(applied.length, count);
  assert.throws(() => menus.setShortcuts(a, { shortcuts: { zoom_in: 42 } }));
  assert.equal(applied.length, count);
  menus.setShortcuts(a, { shortcuts: { zoom_in: 'mod+alt+u' } });
  assert.equal(applied.length, count);
  focused = b; b.emit('focus');
  assert.equal(applied.at(-1).locale, 'en'); assert.equal(applied.at(-1).shortcuts.zoom_in, 'mod+alt+y');
  focused = a; a.emit('focus');
  assert.equal(applied.at(-1).locale, 'zh-CN'); assert.equal(applied.at(-1).shortcuts.zoom_in, 'mod+alt+u');
});

test('native input prearms before renderer acknowledgement and preserves recording ownership', () => {
  const f = windowFixture();
  const owner = attachShortcutSequence(f.window, { platform: 'darwin' });
  assert.equal(owner.update({ type: 'leaders', chords: ['mod+k'] }), true);
  f.contents.emit('before-input-event', {}, { type: 'keyDown', key: 'k', code: 'KeyK', meta: true });
  assert.equal(f.ignored.at(-1), true);
  f.contents.emit('before-input-event', {}, { type: 'keyDown', key: 'b', code: 'KeyB', meta: true });
  assert.equal(f.ignored.at(-1), true);
  owner.update({ type: 'pending', timeoutMs: 0 }); assert.equal(f.ignored.at(-1), false);
  owner.update({ type: 'recording', active: true }); assert.equal(f.ignored.at(-1), true);
  owner.update({ type: 'pending', timeoutMs: 0 }); assert.equal(f.ignored.at(-1), true);
  assert.equal(owner.update({ type: 'pending', timeoutMs: 3001 }), false);
  assert.equal(owner.update({ type: 'recording', active: 'true' }), false);
  owner.update({ type: 'recording', active: false }); assert.equal(f.ignored.at(-1), false);
  owner.dispose(); assert.equal(f.contents.listenerCount('before-input-event'), 0);
});

test('invalid sequence updates retain accepted leaders and recording state', () => {
  const f = windowFixture();
  const owner = attachShortcutSequence(f.window, { platform: 'darwin' });
  try {
    assert.equal(owner.update({ type: 'leaders', chords: ['mod+k'] }), true);
    assert.equal(owner.update({ type: 'recording', active: true }), true);
    for (const value of [
      null, [], {}, { type: 'unknown', active: false },
      { type: 'recording' }, { type: 'recording', active: false, extra: true },
      { type: 'recording', active: 0 },
      { type: 'leaders', chords: [3] }, { type: 'leaders', chords: ['mod+k', 'mod++b'] },
      { type: 'leaders', chords: Array(257).fill('mod+k') },
      { type: 'pending', timeoutMs: -1 }, { type: 'pending', timeoutMs: 0.5 },
      { type: 'pending', timeoutMs: 3001 }, { type: 'pending', timeoutMs: '0' },
      { type: 'pending', timeoutMs: 0, extra: true },
    ]) {
      const calls = f.ignored.length;
      assert.equal(owner.update(value), false);
      assert.equal(f.ignored.length, calls, 'rejected payload must not alter native capture');
      assert.equal(f.ignored.at(-1), true);
    }
    owner.update({ type: 'recording', active: false });
    f.contents.emit('before-input-event', {}, { type: 'keyDown', key: 'k', code: 'KeyK', meta: true });
    assert.equal(f.ignored.at(-1), true, 'rejected leader updates retain accepted leaders');
  } finally { owner.dispose(); }
});

test('invalid locale updates preserve the accepted focused menu', () => {
  const f = windowFixture();
  const menus = createWindowMenuShortcuts({ platform: 'darwin', getFocusedWindow: () => f.window, apply() {} });
  menus.attach(f.window);
  try {
    menus.setLocale(f.window, 'zh-CN');
    for (const locale of [null, undefined, [], {}, 3, false]) {
      assert.throws(() => menus.setLocale(f.window, locale));
      assert.equal(menus.read(f.window).locale, 'zh-CN');
    }
    menus.setLocale(f.window, 'unsupported-locale');
    assert.equal(menus.read(f.window).locale, 'en');
  } finally { f.window.emit('closed'); }
});

test('timeout, blur, navigation and teardown release only their own native capture', async () => {
  const f = windowFixture(), other = windowFixture(2);
  const owner = attachShortcutSequence(f.window, { platform: 'win32' });
  const second = attachShortcutSequence(other.window, { platform: 'win32' });
  second.update({ type: 'recording', active: true });
  owner.update({ type: 'pending', timeoutMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(f.ignored.at(-1), false);
  owner.update({ type: 'recording', active: true }); f.window.emit('blur'); assert.equal(f.ignored.at(-1), false);
  assert.equal(other.ignored.at(-1), true);
  owner.update({ type: 'leaders', chords: ['ctrl+k'] });
  owner.update({ type: 'recording', active: true });
  f.contents.emit('did-start-navigation', {}, 'openchamber-ui://app/', false, true); assert.equal(f.ignored.at(-1), false);
  f.contents.emit('before-input-event', {}, { type: 'keyDown', key: 'k', control: true }); assert.equal(f.ignored.at(-1), false);
  owner.update({ type: 'recording', active: true }); f.contents.emit('render-process-gone'); assert.equal(f.ignored.at(-1), false);
  owner.dispose(); second.dispose();
});

test('menu disposal never reads webContents from an already destroyed BrowserWindow', () => {
  const f = windowFixture();
  const menus = createWindowMenuShortcuts({ platform: 'darwin', getFocusedWindow: () => f.window, apply() {} });
  menus.attach(f.window);
  Object.defineProperty(f.window, 'webContents', { get() { throw new TypeError('Object has been destroyed'); } });
  assert.doesNotThrow(() => f.window.emit('closed'));
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0);
  assert.equal(menus.has(f.window), false);
});

test('native leaders match renderer Latin, non-Latin and Option layout semantics', () => {
  const f = windowFixture();
  const owner = attachShortcutSequence(f.window, { platform: 'darwin' });
  owner.update({ type: 'leaders', chords: ['mod+k', 'mod+alt+1', 'mod+alt+[', 'mod+shift+plus'] });
  const cases = [
    [{ key: 'k', code: 'KeyT', meta: true }, true],
    [{ key: 't', code: 'KeyK', meta: true }, false],
    [{ key: 'л', code: 'KeyK', meta: true }, true],
    [{ key: '¡', code: 'Digit1', meta: true, alt: true }, true],
    [{ key: '“', code: 'BracketLeft', meta: true, alt: true }, true],
    [{ key: '+', code: 'Equal', meta: true, shift: true }, true],
  ];
  for (const [input, expected] of cases) {
    owner.update({ type: 'pending', timeoutMs: 0 });
    f.contents.emit('before-input-event', {}, { type: 'keyDown', ...input });
    assert.equal(f.ignored.at(-1), expected, JSON.stringify(input));
  }
  owner.dispose();
});

test('same-document navigation preserves menu, leaders and recording; document replacement clears them', () => {
  const f = windowFixture();
  const applied = [];
  const menus = createWindowMenuShortcuts({ platform: 'darwin', getFocusedWindow: () => f.window, apply: value => applied.push(value) });
  menus.attach(f.window);
  const owner = attachShortcutSequence(f.window, { platform: 'darwin' });
  try {
    menus.setLocale(f.window, 'zh-CN');
    menus.setShortcuts(f.window, { shortcuts: { zoom_in: 'mod+alt+u' } });
    owner.update({ type: 'leaders', chords: ['mod+k'] });
    owner.update({ type: 'recording', active: true });
    const accepted = { locale: 'zh-CN', shortcuts: { zoom_in: 'mod+alt+u' } };
    const appliedCount = applied.length;

    f.contents.emit('did-start-navigation', {}, 'openchamber-ui://app/settings#shortcuts', true, true);
    assert.deepEqual(menus.read(f.window), accepted);
    assert.equal(applied.length, appliedCount);
    assert.equal(f.ignored.at(-1), true);
    owner.update({ type: 'pending', timeoutMs: 0 });
    assert.equal(f.ignored.at(-1), true, 'same-document navigation preserves recording independently of pending state');

    owner.update({ type: 'recording', active: false });
    f.contents.emit('before-input-event', {}, { type: 'keyDown', key: 'k', code: 'KeyK', meta: true });
    assert.equal(f.ignored.at(-1), true, 'registered leaders remain active without renderer republication');
    f.contents.emit('did-start-navigation', {}, 'openchamber-ui://app/session/next', true, true);
    assert.equal(f.ignored.at(-1), true, 'an active sequence keeps its bounded pending capture');
    f.window.emit('focus');
    assert.deepEqual(applied.at(-1), accepted);
    assert.equal(applied.length, appliedCount);

    owner.update({ type: 'recording', active: true });
    f.contents.emit('did-start-navigation', {}, 'openchamber-ui://app/', false, true);
    assert.deepEqual(menus.read(f.window), { locale: 'en', shortcuts: {} });
    assert.deepEqual(applied.at(-1), { locale: 'en', shortcuts: {} });
    assert.equal(f.ignored.at(-1), false);
    f.contents.emit('before-input-event', {}, { type: 'keyDown', key: 'k', code: 'KeyK', meta: true });
    assert.equal(f.ignored.at(-1), false, 'replacement document must register its own leaders');
  } finally {
    owner.dispose();
    f.window.emit('closed');
  }
});
