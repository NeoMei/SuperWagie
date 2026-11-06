import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { DesktopShortcutSequenceState } from '@/lib/desktop';

test('the mounted recorder captures native chords, blocks fixed owners and releases on cancel', async () => {
  const dom = new Window({ url: 'http://localhost/' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const capture: DesktopShortcutSequenceState[] = [];
  Object.defineProperties(dom, {
    __OPENCHAMBER_ELECTRON__: { value: { runtime: 'electron' } },
    __OPENCHAMBER_PLATFORM__: { value: 'darwin' },
    __OPENCHAMBER_DESKTOP__: { value: { setShortcutSequenceState: (value: DesktopShortcutSequenceState) => { capture.push(value); return true; } } },
  });
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent, getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { ShortcutRecordingDialog } = await import('./ShortcutRecordingDialog');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useI18nStore } = await import('@/lib/i18n/store');
  const { getCustomizableShortcutActions, shortcutRegistry } = await import('@/lib/shortcuts');
  const locale = useI18nStore.getState().locale;
  useI18nStore.getState().setLocale('en');
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  let saves = 0;
  const overrides = { toggle_sidebar: '__unassigned__' };
  function Recorder({ id }: { id: 'new_window' | 'save_file' }) {
    const [open, setOpen] = React.useState(true);
    const action = getCustomizableShortcutActions().find(item => item.id === id)!;
    return <ShortcutRecordingDialog action={open ? action : null} overrides={overrides} maxChords={id === 'new_window' ? 1 : 2} maxKeys={5} onSave={() => { saves += 1; }} onOpenChange={setOpen} />;
  }
  const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!;
  try {
    for (const id of ['new_window', 'save_file'] as const) {
      await act(async () => root.render(<I18nProvider><Recorder key={id} id={id} /></I18nProvider>));
      expect(shortcutRegistry.isSuspended()).toBe(true);
      expect(capture.at(-1)).toEqual({ type: 'recording', active: true });
      const recorder = document.querySelector<HTMLElement>('[role="dialog"] [tabindex="0"]')!;
      expect(recorder).not.toBeNull();
      await act(async () => recorder.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, bubbles: true, cancelable: true })));
      await act(async () => button('Confirm').click());
      expect(document.body.textContent).toContain('reserved by a desktop menu command');
      expect(saves).toBe(0);
      expect(button('Confirm').disabled).toBe(true);
      await act(async () => button('Cancel').click());
      expect(capture.at(-1)).toEqual({ type: 'recording', active: false });
      expect(shortcutRegistry.isSuspended()).toBe(false);
    }
    expect(overrides).toEqual({ toggle_sidebar: '__unassigned__' });
  } finally {
    await act(async () => root.unmount());
    useI18nStore.getState().setLocale(locale);
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
