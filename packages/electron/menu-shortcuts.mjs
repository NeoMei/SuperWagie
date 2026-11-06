import { z } from 'zod';
import policy from '../ui/src/lib/shortcuts/native-menu-policy.json' with { type: 'json' };
import { convertShortcutComboToAccelerator } from './mini-chat-global-shortcut.mjs';
import { normalizeMenuLocale } from './menu-locales.mjs';

const aliases = { cmd: 'mod', command: 'mod', meta: 'mod', option: 'alt', control: 'ctrl', win: 'super', ',': 'comma', '.': 'period', '-': 'minus', '+': 'plus', esc: 'escape' };
const modifiers = ['mod', 'ctrl', 'super', 'shift', 'alt'];
const supportedKey = /^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|arrow(?:up|down|left|right)|space|tab|escape|backspace|delete|insert|home|end|pageup|pagedown|comma|period|plus|minus|enter|[/;'[\]\\`=])$/;
const menuSnapshotSchema = z.object({
  shortcuts: z.object(Object.fromEntries(Object.keys(policy.defaults).map(id => [id, z.string().optional()]))),
});
const menuLocaleSchema = z.string();
const sequenceStateSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('leaders'), chords: z.array(z.string()).max(256) }),
  z.strictObject({ type: z.literal('pending'), timeoutMs: z.number().int().min(0).max(3000) }),
  z.strictObject({ type: z.literal('recording'), active: z.boolean() }),
]);

const parseChord = (value, requireModifier = true) => {
  if (!value.trim() || /\s/.test(value.trim())) return null;
  const parts = value.toLowerCase().trim().split('+').map(part => aliases[part] ?? part);
  if (parts.some(part => !part)) return null;
  const keys = parts.filter(part => !modifiers.includes(part));
  if (keys.length !== 1 || !supportedKey.test(keys[0])) return null;
  const held = modifiers.filter(modifier => parts.includes(modifier));
  if (requireModifier && !held.some(modifier => modifier !== 'shift')) return null;
  return [...held, keys[0]].join('+');
};

const applies = (scope, platform) => scope === 'all' || scope === platform
  || (scope === 'non-mac' && platform !== 'darwin') || (scope === 'non-win' && platform !== 'win32');
const physicalChord = (combo, platform) => [...new Set(combo.split('+').flatMap(part => part === 'mod' ? (platform === 'darwin' ? 'super' : 'ctrl') : part === 'plus' ? ['shift', '='] : part))].sort().join('+');
const available = (id, platform) => platform !== 'darwin' || !['previous_project', 'next_project'].includes(id);

/** Invalid snapshots never receive authority, including when one known value is bad. */
export function parseMenuShortcutSnapshot(args, platform = process.platform) {
  const snapshot = menuSnapshotSchema.safeParse(args);
  if (!snapshot.success) throw new Error('Invalid native shortcut map');
  const parsed = {};
  for (const [id, value] of Object.entries(snapshot.data.shortcuts)) {
    if (value === undefined) throw new Error('Invalid native shortcut binding');
    if (value === '') { parsed[id] = ''; continue; }
    const combo = parseChord(value);
    if (!combo) throw new Error('Invalid native shortcut binding');
    parsed[id] = combo;
  }
  const occupied = new Set(policy.fixed.filter(item => applies(item.platform, platform)).map(item => physicalChord(item.combo, platform)));
  for (const [id, fallback] of Object.entries(policy.defaults)) {
    if (!available(id, platform)) continue;
    const combo = parsed[id] ?? fallback;
    if (!combo) continue;
    const physical = physicalChord(combo, platform);
    if (occupied.has(physical)) throw new Error('Native shortcut conflicts with another menu command');
    occupied.add(physical);
  }
  return parsed;
}

export function menuShortcutAccelerator(id, shortcuts = {}) {
  const combo = shortcuts[id] ?? policy.defaults[id];
  return combo ? convertShortcutComboToAccelerator(combo) ?? undefined : undefined;
}

/** A window's background hydration cannot replace the focused window's menu. */
export function createWindowMenuShortcuts({ platform, getFocusedWindow, apply }) {
  const windows = new WeakMap();
  let lastApplied = '';
  const refresh = window => {
    if (window !== getFocusedWindow()) return;
    const value = windows.get(window);
    if (!value) return;
    const identity = JSON.stringify(value);
    if (identity === lastApplied) return;
    lastApplied = identity;
    apply(value);
  };
  return {
    attach(window) {
      if (windows.has(window)) return;
      const contents = window.webContents;
      windows.set(window, { locale: 'en', shortcuts: {} });
      const focus = () => refresh(window);
      const reset = (_event, _url, inPlace, isMainFrame) => {
        if (!isMainFrame || inPlace) return;
        windows.set(window, { locale: 'en', shortcuts: {} });
        refresh(window);
      };
      window.on('focus', focus);
      contents.on('did-start-navigation', reset);
      window.once('closed', () => {
        windows.delete(window);
        window.removeListener('focus', focus);
        contents.removeListener('did-start-navigation', reset);
      });
      refresh(window);
    },
    has: window => windows.has(window),
    read: window => windows.get(window) ?? { locale: 'en', shortcuts: {} },
    setShortcuts(window, args) {
      const shortcuts = parseMenuShortcutSnapshot(args, platform);
      const previous = windows.get(window);
      if (!previous) throw new Error('Unknown shortcut window');
      windows.set(window, { ...previous, shortcuts });
      refresh(window);
    },
    setLocale(window, locale) {
      const previous = windows.get(window);
      const parsed = menuLocaleSchema.safeParse(locale);
      if (!previous || !parsed.success) throw new Error('Invalid menu locale');
      windows.set(window, { ...previous, locale: normalizeMenuLocale(parsed.data) });
      refresh(window);
    },
  };
}

/** This capability is restricted separately from generic desktop invoke and runtime config. */
export function isAppShortcutFrame(event, window, hmrOrigin = '') {
  try {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.sender.isDestroyed()) return false;
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || frame !== event.sender.mainFrame) return false;
    const url = new URL(frame.url);
    if (frame.origin === 'openchamber-ui://app') {
      return url.protocol === 'openchamber-ui:' && url.host === 'app' && !url.username && !url.password;
    }
    return Boolean(hmrOrigin && frame.origin === hmrOrigin && url.origin === hmrOrigin);
  } catch { return false; }
}

// Keep layout resolution aligned with shared shortcuts.resolveShortcutEventKey.
// Latin layouts retain character meaning; Option and non-Latin symbols use code.
const codeKeys = new Map([
  ['Comma', ','], ['Period', '.'], ['Backslash', '\\'], ['Slash', '/'],
  ['Backquote', '`'], ['BracketLeft', '['], ['BracketRight', ']'],
  ['Semicolon', ';'], ['Quote', "'"], ['Minus', '-'], ['Equal', '='],
]);
const inputChord = (input, platform) => {
  const held = [];
  if (input.meta) held.push(platform === 'darwin' ? 'mod' : 'super');
  if (input.control) held.push(platform === 'darwin' ? 'ctrl' : 'mod');
  if (input.shift) held.push('shift');
  if (input.alt) held.push('alt');
  const raw = String(input.key).toLowerCase();
  const fromCode = /^Key[A-Z]$/.test(input.code ?? '') ? input.code.slice(3).toLowerCase()
    : /^Digit\d$/.test(input.code ?? '') ? input.code.slice(5) : codeKeys.get(input.code);
  const resolved = input.alt || (raw.length === 1 && raw.charCodeAt(0) > 127) ? fromCode ?? raw : raw;
  const key = aliases[resolved] ?? (resolved === ' ' ? 'space' : resolved);
  return physicalChord([...held, key].join('+'), platform);
};

/** Main prearms on native input, including input queued before the renderer handles its leader. */
export function attachShortcutSequence(window, { platform = process.platform } = {}) {
  const contents = window.webContents;
  let leaders = new Set();
  let pending = false;
  let recording = false;
  let timer;
  let disposed = false;
  const apply = () => {
    if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(Boolean(recording || pending));
  };
  const clearPending = () => { clearTimeout(timer); timer = undefined; pending = false; apply(); };
  const arm = timeoutMs => {
    clearTimeout(timer);
    pending = true;
    apply();
    timer = setTimeout(clearPending, timeoutMs);
    timer.unref?.();
  };
  const reset = () => { recording = false; clearPending(); };
  const navigate = (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) { leaders.clear(); reset(); }
  };
  const crash = () => { leaders.clear(); reset(); };
  const beforeInput = (_event, input) => {
    if (disposed || input.type !== 'keyDown' || input.isAutoRepeat || recording || pending) return;
    if (leaders.has(inputChord(input, platform))) arm(3000);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    leaders.clear(); reset();
    window.removeListener('blur', reset);
    window.removeListener('closed', dispose);
    contents.removeListener('before-input-event', beforeInput);
    contents.removeListener('did-start-navigation', navigate);
    contents.removeListener('render-process-gone', crash);
    contents.removeListener('destroyed', dispose);
  };
  contents.on('before-input-event', beforeInput);
  contents.on('did-start-navigation', navigate);
  contents.on('render-process-gone', crash);
  contents.on('destroyed', dispose);
  window.on('blur', reset);
  window.on('closed', dispose);
  return {
    dispose,
    update(input) {
      if (disposed) return false;
      const parsedState = sequenceStateSchema.safeParse(input);
      if (!parsedState.success) return false;
      const value = parsedState.data;
      if (value.type === 'leaders') {
        const parsed = value.chords.map(chord => parseChord(chord, false));
        if (parsed.some(chord => chord === null)) return false;
        const next = new Set(parsed.map(chord => physicalChord(chord, platform)));
        if (next.size !== leaders.size || [...next].some(chord => !leaders.has(chord))) clearPending();
        leaders = next;
        if (!leaders.size) clearPending();
        return true;
      }
      if (value.type === 'pending') {
        if (value.timeoutMs > 0 && !window.isFocused()) return false;
        if (value.timeoutMs) arm(value.timeoutMs); else clearPending();
        return true;
      }
      if (value.active && !window.isFocused()) return false;
      recording = value.active;
      clearPending();
      return true;
    },
  };
}
