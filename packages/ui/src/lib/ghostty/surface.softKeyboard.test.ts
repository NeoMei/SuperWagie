import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { GhosttyTerminalSurface } from './surface';

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const DEL = '\x7f';

let dom: Window | null = null;
let surface: GhosttyTerminalSurface | null = null;

afterEach(() => {
  surface?.dispose();
  surface = null;
  dom?.happyDOM.abort();
  dom = null;
});

/** A real surface with the real WebAssembly encoder; painting is stubbed out. */
async function createSurface(userAgent: string, sized = false) {
  const happyWindow = new Window({ url: 'http://localhost/' });
  dom = happyWindow;
  Object.defineProperty(happyWindow.navigator, 'userAgent', { value: userAgent });
  Object.defineProperty(happyWindow.HTMLCanvasElement.prototype, 'getContext', {
    value: function (this: HTMLCanvasElement) {
      return {
        canvas: this,
        setTransform() {}, resetTransform() {}, save() {}, restore() {},
        beginPath() {}, rect() {}, clip() {}, fillText() {}, strokeRect() {},
        fillRect() {},
        measureText: () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 }),
      };
    },
  });
  Object.defineProperty(happyWindow.document, 'fonts', {
    value: { load: async () => [], add() {}, addEventListener() {}, removeEventListener() {} },
  });
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    ResizeObserver: happyWindow.ResizeObserver,
    KeyboardEvent: happyWindow.KeyboardEvent,
    InputEvent: happyWindow.InputEvent,
    CompositionEvent: happyWindow.CompositionEvent,
  });
  const sent: string[] = [];
  const mount = document.createElement('div');
  let width = 328;
  Object.defineProperty(mount, 'clientWidth', { get: () => sized ? width : 0 });
  Object.defineProperty(mount, 'clientHeight', { get: () => sized ? 120 : 0 });
  surface = await GhosttyTerminalSurface.create(mount, {
    visible: sized,
    labels: { input: 'Terminal input', scrollbar: 'Terminal scrollback' },
    theme: {
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
    },
    onData: (data) => sent.push(data),
    onResize() {},
  });
  const field = surface.input;
  const key = (type: 'keydown' | 'keyup', init: { key: string; code: string; keyCode: number }) => {
    const event = new KeyboardEvent(type, { ...init, cancelable: true });
    field.dispatchEvent(event);
    return event;
  };
  /**
   * What Chrome fires after it changed the field: the value is already the
   * result of the edit, and the caret sits after the inserted text.
   */
  const edited = (value: string, init: InputEventInit, caret = value.length) => {
    field.value = value;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new InputEvent('input', init));
  };
  const composition = (type: 'compositionstart' | 'compositionupdate' | 'compositionend', data: string) => {
    // happy-dom's CompositionEvent drops its init.
    field.dispatchEvent(Object.assign(new CompositionEvent(type), { data }));
  };
  return {
    sent, field, key, edited, composition, terminal: surface, mount,
    resize: (nextWidth: number) => { width = nextWidth; surface?.fit(); },
    flush: () => new Promise<void>((resolve) => happyWindow.requestAnimationFrame(() => resolve())),
    write: (data: string) => surface?.write(data),
  };
}

// Sequences recorded on an Android 15 emulator with Gboard 14.2, Chrome 124 and Chromium 158.
const IME_KEY = { key: 'Unidentified', code: '', keyCode: 229 };
const GBOARD_DEL_KEY = { key: 'Backspace', code: '', keyCode: 8 };

describe('soft keyboard Backspace on Android', () => {
  test('keeps one space before the caret so the keyboard always has something to delete', async () => {
    const { field } = await createSurface(ANDROID_UA);
    expect(field.value).toBe(' ');
    expect(field.selectionStart).toBe(1);
  });

  test('a Backspace Gboard makes by deleting its own typing sends one DEL', async () => {
    const { sent, field, key, edited } = await createSurface(ANDROID_UA);
    for (let press = 0; press < 3; press += 1) {
      key('keydown', IME_KEY);
      edited('', { inputType: 'deleteContentBackward', data: null });
      key('keyup', IME_KEY);
    }
    expect(sent).toEqual([DEL, DEL, DEL]);
    expect(field.value).toBe(' ');
  });

  test('the sequence from the issue report sends one DEL and leaves beforeinput uncancelled', async () => {
    const { sent, field, key, edited } = await createSurface(ANDROID_UA);
    key('keydown', { key: 'Process', code: '', keyCode: 229 });
    const before = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: true });
    field.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual([DEL]);
  });

  test('a Backspace key without a code sends one DEL through the edit it makes', async () => {
    const { sent, key, edited } = await createSurface(ANDROID_UA);
    const press = key('keydown', GBOARD_DEL_KEY);
    // Nothing to encode, so the browser keeps its default and deletes the space.
    expect(press.defaultPrevented).toBe(false);
    edited('', { inputType: 'deleteContentBackward', data: null });
    key('keyup', GBOARD_DEL_KEY);
    expect(sent).toEqual([DEL]);
  });

  test('a hardware Backspace with a code is encoded once and keeps the space', async () => {
    const { sent, field, key } = await createSurface(ANDROID_UA);
    const press = key('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    key('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    expect(press.defaultPrevented).toBe(true);
    expect(sent).toEqual([DEL]);
    expect(field.value).toBe(' ');
  });

  test('typed text, Enter and suggestions reach the shell without the space', async () => {
    const { sent, field, key, edited } = await createSurface(ANDROID_UA);
    for (const [value, data] of [[' l', 'l'], [' s', 's'], [' ach ', 'ach ']]) {
      key('keydown', IME_KEY);
      edited(value, { inputType: 'insertText', data });
      key('keyup', IME_KEY);
    }
    // Gboard's Enter: an empty IME key pair, then Enter, which Chrome inserts as a line break.
    key('keydown', IME_KEY);
    key('keyup', IME_KEY);
    key('keydown', { key: 'Enter', code: '', keyCode: 13 });
    edited(' \n', { inputType: 'insertLineBreak', data: null });
    expect(sent).toEqual(['l', 's', 'ach ', '\n']);
    expect(field.value).toBe(' ');
  });

  test('the next key puts the caret back after the space when a swipe moved it', async () => {
    const { field, key } = await createSurface(ANDROID_UA);
    // Gboard's space-bar swipe: the caret moves with no event.
    field.setSelectionRange(0, 0);
    key('keydown', GBOARD_DEL_KEY);
    expect(field.selectionStart).toBe(1);
  });

  test('text inserted in front of the space arrives without it, its own spaces kept', async () => {
    const { sent, edited } = await createSurface(ANDROID_UA);
    edited('x ', { inputType: 'insertText', data: 'x' }, 1);
    edited(' foo ', { inputType: 'insertText', data: ' foo' }, 4);
    expect(sent).toEqual(['x', ' foo']);
  });

  test('a copy with nothing selected keeps the space for the next Backspace', async () => {
    const { sent, field, edited } = await createSurface(ANDROID_UA);
    field.dispatchEvent(new Event('copy'));
    expect(field.value).toBe(' ');
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual([DEL]);
  });

  test('composition owns its own deletions and commits once without the space', async () => {
    const { sent, field, edited, composition } = await createSurface(ANDROID_UA);
    composition('compositionstart', '');
    edited(' ni', { inputType: 'insertCompositionText', data: 'ni', isComposing: true });
    edited(' n', { inputType: 'deleteContentBackward', data: null, isComposing: true });
    edited(' ni', { inputType: 'insertCompositionText', data: 'ni', isComposing: true });
    edited(' 你', { inputType: 'insertCompositionText', data: '你', isComposing: true });
    composition('compositionend', '你');
    // Chrome may echo the commit as a plain input right after compositionend.
    edited(' 你', { inputType: 'insertFromComposition', data: '你' });
    expect(sent).toEqual(['你']);
    expect(field.value).toBe(' ');
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual(['你', DEL]);
  });

  test('a program that asks for Kitty release events gets the release too', async () => {
    const { sent, edited, write } = await createSurface(ANDROID_UA);
    // Kitty flags: disambiguate, report events, report all keys as escape codes.
    write('\x1b[>11u');
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual(['\x1b[127u\x1b[127;1:3u']);
  });
});

describe('Backspace elsewhere', () => {
  test('desktop keeps an empty field and encodes the key once', async () => {
    const { sent, field, key } = await createSurface(MAC_UA);
    expect(field.value).toBe('');
    const press = key('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    key('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    expect(press.defaultPrevented).toBe(true);
    expect(sent).toEqual([DEL]);
  });

  test('desktop leaves deletion edits alone, as before', async () => {
    // Desktop IMEs delete inside their own composition; only Android rests on a space.
    const { sent, field, key, edited } = await createSurface(MAC_UA);
    key('keydown', { key: 'Process', code: '', keyCode: 229 });
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual([]);
    expect(field.value).toBe('');
  });


  test('iOS keeps an empty field and plain typing', async () => {
    const { sent, field, edited } = await createSurface(IPHONE_UA);
    expect(field.value).toBe('');
    edited('a', { inputType: 'insertText', data: 'a' });
    expect(sent).toEqual(['a']);
  });
});

describe('text being composed', () => {
  const shown = (terminal: GhosttyTerminalSurface) => (terminal.preedit.hidden ? null : terminal.preedit.textContent);

  test('shows every update and sends the chosen word once on commit', async () => {
    const { sent, edited, composition, terminal } = await createSurface(MAC_UA);
    expect(shown(terminal)).toBeNull();
    composition('compositionstart', '');
    composition('compositionupdate', 'nihaoya');
    edited('nihaoya', { inputType: 'insertCompositionText', data: 'nihaoya', isComposing: true });
    expect(shown(terminal)).toBe('nihaoya');
    composition('compositionupdate', 'nihaoy');
    expect(shown(terminal)).toBe('nihaoy');
    expect(sent).toEqual([]);
    composition('compositionupdate', '你好呀');
    edited('你好呀', { inputType: 'insertCompositionText', data: '你好呀', isComposing: true });
    composition('compositionend', '你好呀');
    edited('你好呀', { inputType: 'insertFromComposition', data: '你好呀' });
    expect(shown(terminal)).toBeNull();
    expect(sent).toEqual(['你好呀']);
  });

  test('a cancelled composition clears the display and sends nothing', async () => {
    const { sent, edited, composition, terminal } = await createSurface(MAC_UA);
    composition('compositionstart', '');
    composition('compositionupdate', 'ni');
    edited('ni', { inputType: 'insertCompositionText', data: 'ni', isComposing: true });
    expect(shown(terminal)).toBe('ni');
    composition('compositionupdate', '');
    edited('', { inputType: 'deleteCompositionText', data: null, isComposing: true });
    composition('compositionend', '');
    expect(shown(terminal)).toBeNull();
    expect(sent).toEqual([]);
  });

  test('deleting every letter hides the display while composition is still open', async () => {
    const { composition, terminal } = await createSurface(MAC_UA);
    composition('compositionstart', '');
    composition('compositionupdate', 'n');
    composition('compositionupdate', '');
    expect(shown(terminal)).toBeNull();
  });

  test('Android shows the composed text without its resting space', async () => {
    const { sent, edited, composition, terminal } = await createSurface(ANDROID_UA);
    composition('compositionstart', '');
    composition('compositionupdate', 'ni');
    edited(' ni', { inputType: 'insertCompositionText', data: 'ni', isComposing: true });
    expect(shown(terminal)).toBe('ni');
    edited(' 你', { inputType: 'insertCompositionText', data: '你', isComposing: true });
    composition('compositionend', '你');
    expect(shown(terminal)).toBeNull();
    expect(sent).toEqual(['你']);
  });

  test('uses the terminal colors and follows a theme switch', async () => {
    const { terminal } = await createSurface(MAC_UA);
    expect(terminal.preedit.style.color).toBe('rgb(255, 255, 255)');
    expect(terminal.preedit.style.backgroundColor).toBe('rgb(0, 0, 0)');
    terminal.setTheme({
      foreground: { r: 20, g: 20, b: 20 },
      background: { r: 250, g: 250, b: 250 },
      cursor: { r: 20, g: 20, b: 20 },
    });
    expect(terminal.preedit.style.color).toBe('rgb(20, 20, 20)');
    expect(terminal.preedit.style.backgroundColor).toBe('rgb(250, 250, 250)');
  });

  test('copying a terminal selection preserves the candidate and its single commit', async () => {
    const { field, edited, composition, terminal, sent, flush } = await createSurface(MAC_UA, true);
    terminal.write('copy_token');
    await flush();
    expect(terminal.selectWordAt(5, 5)).toBe(true);
    composition('compositionstart', '');
    composition('compositionupdate', 'ni');
    edited('ni', { inputType: 'insertCompositionText', data: 'ni', isComposing: true });
    // Exercise the menu copy event without touching the system clipboard.
    const copied: string[][] = [];
    const clipboardData = { setData: (type: string, text: string) => copied.push([type, text]) };
    const caret = [field.selectionStart, field.selectionEnd];
    const copy = Object.assign(new Event('copy', { cancelable: true }), { clipboardData });
    field.dispatchEvent(copy);
    expect(copied).toEqual([['text/plain', 'copy_token']]);
    expect(copy.defaultPrevented).toBe(true);
    expect(field.value).toBe('ni');
    expect([field.selectionStart, field.selectionEnd]).toEqual(caret);
    composition('compositionend', 'ni');
    edited('ni', { inputType: 'insertFromComposition', data: 'ni' });
    expect(sent).toEqual(['ni']);
  });

  test('dispose removes the display', async () => {
    const { terminal, composition, sent } = await createSurface(MAC_UA);
    composition('compositionstart', '');
    composition('compositionupdate', 'ni');
    const { preedit } = terminal;
    const { input } = terminal;
    terminal.dispose();
    expect(preedit.parentElement).toBeNull();
    input.dispatchEvent(Object.assign(new CompositionEvent('compositionupdate'), { data: 'late' }));
    input.dispatchEvent(Object.assign(new CompositionEvent('compositionend'), { data: 'late' }));
    expect(preedit.textContent).not.toBe('late');
    expect(sent).toEqual([]);
  });
});

// The real WASM supplies cursor/scroll state. happy-dom supplies explicit layout widths.
describe('composition geometry', () => {
  test('tracks cursor, hidden cursor, resize, font and viewport scroll', async () => {
    const { terminal, composition, flush, resize, mount } = await createSurface(MAC_UA, true);
    Object.defineProperty(terminal.preedit, 'offsetWidth', { get: () => 48 });
    Object.defineProperty(terminal.preedit, 'scrollWidth', { get: () => 96 });
    composition('compositionstart', '');
    composition('compositionupdate', '你好');
    mount.dir = 'rtl';
    expect(terminal.preedit.dir).toBe('ltr');
    expect(terminal.preedit.style.left).toBe('4px');
    terminal.write('\x1b[2;40H\x1b[?25l');
    await flush();
    expect(terminal.preedit.style.left).toBe('276px');
    expect(terminal.preedit.style.top).toBe('22px');
    expect(terminal.preedit.style.visibility).toBe('');
    expect(terminal.preedit.scrollLeft).toBe(96);
    resize(168);
    expect(Number.parseFloat(terminal.preedit.style.left)).toBeLessThanOrEqual(mount.clientWidth - 4 - 48);
    await terminal.setFont({ size: 20 });
    expect(terminal.preedit.style.font).toContain('20px');
    expect(terminal.preedit.style.lineHeight).toBe('27px');
    terminal.write('\x1b[?25h' + '\r\nline'.repeat(20));
    await flush();
    terminal.scrollLines(-10);
    await flush();
    expect(terminal.preedit.style.visibility).toBe('hidden');
    terminal.scrollToBottom();
    await flush();
    expect(terminal.preedit.style.visibility).toBe('');
  });
});
