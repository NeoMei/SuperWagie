import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useNativeShortcutSync } from './useNativeShortcutSync';
import { getEffectiveShortcutCombo, ShortcutDispatcher, shortcutRegistry } from '@/lib/shortcuts';
import { acquireDesktopShortcutRecording, type DesktopShortcutSequenceState } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';

test('window synchronization follows registered handlers, rebinding, suspension and disposal', async () => {
  const dom = new Window({ url: 'http://native-shortcuts.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const sequence: DesktopShortcutSequenceState[] = [];
  const menu: Array<{ command: string; args: { shortcuts?: Record<string, string> } }> = [];
  Object.defineProperties(dom, {
    __OPENCHAMBER_ELECTRON__: { value: { runtime: 'electron' } },
    __OPENCHAMBER_PLATFORM__: { value: 'win32' },
    __OPENCHAMBER_DESKTOP__: { value: {
      setShortcutSequenceState: (value: DesktopShortcutSequenceState) => { sequence.push(value); return true; },
      invoke: async (command: string, args: { shortcuts?: Record<string, string> }) => { menu.push({ command, args }); return null; },
    } },
  });
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const previous = useUIStore.getState().shortcutOverrides;
  useUIStore.setState({ shortcutOverrides: {} });
  const dispatcher = new ShortcutDispatcher({ registry: shortcutRegistry, getBinding: id => getEffectiveShortcutCombo(id, useUIStore.getState().shortcutOverrides) });
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  const remove = shortcutRegistry.register('toggle_source_board', () => {});
  function Owner() { useNativeShortcutSync(dispatcher); return null; }
  try {
    await act(async () => root.render(<Owner />));
    expect(sequence.filter(value => value.type === 'leaders').at(-1)).toEqual({ type: 'leaders', chords: ['mod+k'] });
    dispatcher.dispatch(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true }));
    expect(sequence.at(-1)).toMatchObject({ type: 'pending' });
    const pending = sequence.at(-1);
    expect(pending?.type === 'pending' && pending.timeoutMs > 0).toBe(true);
    const resume = shortcutRegistry.suspend();
    expect(sequence.filter(value => value.type === 'leaders').at(-1)).toEqual({ type: 'leaders', chords: [] });
    expect(sequence.at(-1)).toEqual({ type: 'pending', timeoutMs: 0 });
    resume();
    await act(async () => useUIStore.setState({ shortcutOverrides: { toggle_source_board: 'ctrl+l b', zoom_in: 'mod+alt+u' } }));
    expect(sequence.filter(value => value.type === 'leaders').at(-1)).toEqual({ type: 'leaders', chords: ['ctrl+l'] });
    expect(menu.at(-1)?.args.shortcuts?.zoom_in).toBe('mod+alt+u');
    const first = acquireDesktopShortcutRecording();
    const second = acquireDesktopShortcutRecording();
    first();
    expect(sequence.at(-1)).toEqual({ type: 'recording', active: true });
    window.dispatchEvent(new Event('blur'));
    expect(sequence.at(-1)).toEqual({ type: 'recording', active: false });
    window.dispatchEvent(new Event('focus'));
    expect(sequence.at(-1)).toEqual({ type: 'recording', active: true });
    second(); second();
    expect(sequence.at(-1)).toEqual({ type: 'recording', active: false });
    await act(async () => root.unmount());
    expect(sequence.at(-1)).toEqual({ type: 'leaders', chords: [] });
  } finally {
    remove(); useUIStore.setState({ shortcutOverrides: previous });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
