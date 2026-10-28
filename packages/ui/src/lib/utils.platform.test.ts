import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { eventMatchesShortcut, formatShortcutForDisplay } from './shortcuts';
import { getRevealLabelKey, isMacOS, isWindows } from './utils';

describe('client operating system', () => {
  const globals = ['window', 'navigator', 'KeyboardEvent'] as const;
  const originalDescriptors = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let browser: Window | undefined;

  afterEach(() => {
    browser?.close();
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  function installClient(userAgent: string, nativePlatform?: string) {
    browser = new Window();
    Object.defineProperty(browser.navigator, 'userAgent', { configurable: true, value: userAgent });
    Object.defineProperty(browser, '__OPENCHAMBER_PLATFORM__', { value: nativePlatform });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator });
    Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: browser.KeyboardEvent });
  }

  test('the Windows shell uses Ctrl and File Explorer even with a Mac user agent', () => {
    installClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'win32');
    expect(isWindows()).toBe(true);
    expect(isMacOS()).toBe(false);
    expect(getRevealLabelKey()).toBe('common.revealPath.fileExplorer');
    expect(formatShortcutForDisplay('mod+shift+n')).toBe('Ctrl + Shift + N');
    expect(eventMatchesShortcut(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }), 'mod+n')).toBe(true);
    expect(eventMatchesShortcut(new KeyboardEvent('keydown', { key: 'n', metaKey: true }), 'mod+n')).toBe(false);
  });

  test('the Mac shell retains Command and Finder even with a Windows user agent', () => {
    installClient('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'darwin');
    expect(isMacOS()).toBe(true);
    expect(isWindows()).toBe(false);
    expect(getRevealLabelKey()).toBe('common.revealPath.finder');
    expect(formatShortcutForDisplay('mod+n')).toBe('⌘ + N');
    expect(eventMatchesShortcut(new KeyboardEvent('keydown', { key: 'n', metaKey: true }), 'mod+n')).toBe(true);
  });

  test('the Linux shell uses the generic file manager despite a Mac user agent', () => {
    installClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'linux');
    expect(isMacOS()).toBe(false);
    expect(isWindows()).toBe(false);
    expect(getRevealLabelKey()).toBe('common.revealPath.fileManager');
  });

  test('browser clients use their own operating system', () => {
    installClient('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(isWindows()).toBe(true);
    expect(getRevealLabelKey()).toBe('common.revealPath.fileExplorer');
  });
});
