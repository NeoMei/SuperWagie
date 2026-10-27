import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from '../../../ui/node_modules/happy-dom/lib/index.js';
import { installNoteReorder } from './note-reorder.ts';

const windows: Window[] = [];
const cleanups: Array<() => void> = [];
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const browser of windows.splice(0)) await browser.happyDOM.close();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});

const waitForHold = () => new Promise<void>((resolve) => setTimeout(resolve, 220));

const mountNotes = () => {
  const browser = new Window();
  windows.push(browser);
  for (const [name, value] of Object.entries({
    document: browser.document, PointerEvent: browser.PointerEvent,
    KeyboardEvent: browser.KeyboardEvent, DOMRect: browser.DOMRect,
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const list = document.createElement('div');
  list.innerHTML = ['a', 'b', 'c', 'd'].map((id) => `<div class="note" data-note-id="${id}"><button class="note-drag"><span>Move</span></button><div class="note-body">Note ${id}</div><button class="note-del">Delete</button></div>`).join('');
  document.body.append(list);
  const cards = [...list.querySelectorAll<HTMLElement>('.note')];
  const bounds = [new DOMRect(0, 0, 80, 60), new DOMRect(100, 0, 120, 60), new DOMRect(0, 80, 100, 60), new DOMRect(120, 80, 100, 60)];
  spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 160));
  cards.forEach((card, index) => spyOn(card, 'getBoundingClientRect').mockReturnValue(bounds[index]!));
  spyOn(document, 'elementFromPoint').mockImplementation((x, y) => cards.find((_, index) => {
    const rect = bounds[index]!;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }) ?? list);
  const moves: Array<[string, string]> = [];
  const cleanup = installNoteReorder(list, (activeId, targetId) => moves.push([activeId, targetId]));
  cleanups.push(cleanup);
  const card = (index: number): HTMLElement => {
    const value = cards[index];
    if (!value) throw new Error('Missing note');
    return value;
  };
  const handle = (index: number): HTMLButtonElement => {
    const value = card(index).querySelector<HTMLButtonElement>('.note-drag');
    if (!value) throw new Error('Missing drag handle');
    return value;
  };
  const pointer = (target: EventTarget, type: string, x: number, y: number, pointerType = 'mouse', pointerId = 1) => {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType, pointerId, button: 0, isPrimary: true });
    target.dispatchEvent(event);
    return event;
  };
  const key = (target: EventTarget, value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
  };
  return { browser, list, cards, card, handle, pointer, key, moves, cleanup };
};

describe('workbench note reordering', () => {
  test('keeps clicks, body selection and delete separate from mouse dragging', () => {
    const { list, card, handle, pointer, moves } = mountNotes();
    pointer(handle(0), 'pointerdown', 20, 20);
    pointer(document, 'pointermove', 27, 20);
    expect(card(0).classList.contains('is-dragging')).toBe(false);
    pointer(document, 'pointerup', 130, 20);
    for (const selector of ['.note-body', '.note-del']) {
      const control = list.querySelector(selector);
      if (!control) throw new Error('Missing note content');
      expect(pointer(control, 'pointerdown', 20, 20).defaultPrevented).toBe(false);
      expect(pointer(document, 'pointermove', 130, 100).defaultPrevented).toBe(false);
      pointer(document, 'pointerup', 130, 100);
    }
    let deletes = 0;
    const remove = card(0).querySelector<HTMLButtonElement>('.note-del');
    remove?.addEventListener('click', () => { deletes++; });
    remove?.click();
    expect(deletes).toBe(1);
    expect(moves).toEqual([]);
  });

  test('moves across wrapped rows once on release and preserves the dragged size', () => {
    const { list, card, handle, pointer, moves } = mountNotes();
    card(0).style.transform = 'rotate(2deg)';
    card(0).style.pointerEvents = 'auto';
    pointer(handle(0).firstElementChild!, 'pointerdown', 20, 20);
    pointer(document, 'pointermove', 20, 100);
    expect(card(0).classList.contains('is-dragging')).toBe(true);
    expect(card(2).classList.contains('is-drop-target')).toBe(true);
    expect(card(0).style.transform).toContain('translate');
    expect(card(0).style.transform).not.toMatch(/scale|rotate/);
    expect([...list.children].map((node) => node.getAttribute('data-note-id'))).toEqual(['a', 'b', 'c', 'd']);
    expect(moves).toEqual([]);
    pointer(document, 'pointerup', 20, 100);
    pointer(document, 'pointerup', 20, 100);
    expect(moves).toEqual([['a', 'c']]);
    expect(list.querySelector('.is-dragging, .is-drop-target')).toBeNull();
    expect(card(0).style.transform).toBe('rotate(2deg)');
    expect(card(0).style.pointerEvents).toBe('auto');
  });

  test('uses the release position and cancels a drop outside the notes grid', () => {
    const { list, handle, pointer, moves } = mountNotes();
    pointer(handle(0), 'pointerdown', 20, 20);
    pointer(document, 'pointermove', 130, 100);
    expect(list.querySelector('.is-drop-target')?.getAttribute('data-note-id')).toBe('d');
    pointer(document, 'pointerup', 300, 100);
    expect(moves).toEqual([]);
    expect(list.querySelector('.is-dragging, .is-drop-target')).toBeNull();
  });

  test.each(['touch', 'pen'])('%s starts after a hold and commits once', async (pointerType) => {
    const { card, handle, pointer, moves } = mountNotes();
    pointer(handle(0), 'pointerdown', 20, 20, pointerType);
    pointer(document, 'pointermove', 23, 22, pointerType);
    expect(card(0).classList.contains('is-dragging')).toBe(false);
    await waitForHold();
    expect(card(0).classList.contains('is-dragging')).toBe(true);
    pointer(document, 'pointermove', 130, 100, pointerType);
    pointer(document, 'pointerup', 130, 100, pointerType);
    expect(moves).toEqual([['a', 'd']]);
  });

  test('touch taps and swipes before the hold leave the list untouched', async () => {
    const { list, handle, pointer, moves } = mountNotes();
    pointer(handle(0), 'pointerdown', 20, 20, 'touch');
    pointer(document, 'pointerup', 20, 20, 'touch');
    pointer(handle(0), 'pointerdown', 20, 20, 'touch');
    expect(pointer(document, 'pointermove', 20, 28, 'touch').defaultPrevented).toBe(false);
    await waitForHold();
    pointer(document, 'pointerup', 130, 100, 'touch');
    expect(list.querySelector('.is-dragging, .is-drop-target')).toBeNull();
    expect(moves).toEqual([]);
  });

  test.each(['pointercancel', 'lostpointercapture', 'Escape', 'cleanup'])('%s cancels an active drag and clears its listeners', (reason) => {
    const { list, card, handle, pointer, key, moves, cleanup } = mountNotes();
    pointer(handle(0), 'pointerdown', 20, 20);
    pointer(document, 'pointermove', 130, 100);
    if (reason === 'Escape') key(document, 'Escape');
    else if (reason === 'cleanup') cleanup();
    else pointer(handle(0), reason, 130, 100);
    pointer(document, 'pointermove', 20, 100);
    pointer(document, 'pointerup', 20, 100);
    expect(moves).toEqual([]);
    expect(list.querySelector('.is-dragging, .is-drop-target')).toBeNull();
    expect(card(0).style.transform).toBe('');
    expect(card(0).style.pointerEvents).toBe('');
  });

  test('cleanup cancels a pending hold before a redraw', async () => {
    const { list, handle, pointer, moves, cleanup } = mountNotes();
    pointer(handle(0), 'pointerdown', 20, 20, 'touch');
    cleanup();
    await waitForHold();
    pointer(document, 'pointerup', 130, 100, 'touch');
    expect(list.querySelector('.is-dragging')).toBeNull();
    expect(moves).toEqual([]);
  });

  test.each([
    ['ArrowUp', 'a'], ['ArrowDown', 'c'], ['ArrowLeft', 'a'], ['ArrowRight', 'c'],
  ])('reorders the focused handle with %s', (arrow, targetId) => {
    const { handle, key, moves } = mountNotes();
    expect(key(handle(1), arrow).defaultPrevented).toBe(true);
    expect(moves).toEqual([['b', targetId]]);
  });

  test('mirrors horizontal arrows in RTL and leaves input keys and shortcuts alone', () => {
    const { list, handle, key, moves } = mountNotes();
    list.style.direction = 'rtl';
    key(handle(1), 'ArrowLeft');
    key(handle(1), 'ArrowRight');
    expect(moves).toEqual([['b', 'c'], ['b', 'a']]);
    const input = document.createElement('input');
    list.append(input);
    for (const event of [key(input, 'ArrowDown'), key(handle(1), 'Enter'), key(handle(1), 'ArrowDown', { ctrlKey: true })]) {
      expect(event.defaultPrevented).toBe(false);
    }
    key(handle(0), 'ArrowUp');
    expect(moves).toHaveLength(2);
  });
});
