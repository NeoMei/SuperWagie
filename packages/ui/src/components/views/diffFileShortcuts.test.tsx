import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useDiffFileShortcuts } from './diffFileShortcuts';
import { getEffectiveShortcutCombo, ShortcutDispatcher, shortcutRegistry } from '@/lib/shortcuts';

test('configured diff stepping respects visibility, input ownership and nonwrapping file order', async () => {
  const dom = new Window({ url: 'http://diff.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, KeyboardEvent: dom.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const selected: string[] = [];
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  const dispatcher = new ShortcutDispatcher({ registry: shortcutRegistry, getBinding: id => getEffectiveShortcutCombo(id, { diff_next_file: 'ctrl+y' }) });
  function Owner({ visible, currentPath }: { visible: boolean; currentPath: string }) {
    useDiffFileShortcuts({ visible, files: [{ path: 'a' }, { path: 'b' }], currentPath, select: path => selected.push(path) });
    return null;
  }
  const press = (target: HTMLElement = document.body, key = 'y', ctrlKey = true) => {
    const event = new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey, altKey: !ctrlKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return dispatcher.dispatch(event);
  };
  try {
    await act(async () => root.render(<Owner visible currentPath="a" />));
    expect(press()).toBe(true); expect(selected).toEqual(['b']);
    const input = document.body.appendChild(document.createElement('input'));
    expect(press(input)).toBe(false);
    const dialog = document.body.appendChild(document.createElement('div')); dialog.setAttribute('role', 'dialog');
    expect(press(dialog)).toBe(false);
    expect(press(document.body, 'ArrowDown', false)).toBe(false);
    await act(async () => root.render(<Owner visible={false} currentPath="a" />));
    expect(press()).toBe(false);
    await act(async () => root.render(<Owner visible currentPath="b" />));
    press(); expect(selected).toEqual(['b']);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    await dom.happyDOM.close();
  }
});
