import { describe, expect, test } from 'bun:test';

// The module listens on `window`; tests run without a DOM.
Object.assign(globalThis, { window: new EventTarget() });

const { registerCloseTabTarget } = await import('./closeTabTarget');

describe('close tab target', () => {
  test('Cmd/Ctrl+W reaches the most recently registered surface, then the one before it', () => {
    const closed: string[] = [];
    const releaseFirst = registerCloseTabTarget(() => closed.push('first'));
    const releaseSecond = registerCloseTabTarget(() => closed.push('second'));

    window.dispatchEvent(new Event('openchamber:close-tab'));
    releaseSecond();
    window.dispatchEvent(new Event('openchamber:close-tab'));
    releaseFirst();
    window.dispatchEvent(new Event('openchamber:close-tab'));

    expect(closed).toEqual(['second', 'first']);
  });
});

test('covering settings stay the target when a file registers later', () => {
  const closed: string[] = [];
  const releaseSettings = registerCloseTabTarget(() => closed.push('settings'), 1);
  const releaseFile = registerCloseTabTarget(() => closed.push('file'));
  window.dispatchEvent(new Event('openchamber:close-tab'));
  releaseSettings();
  window.dispatchEvent(new Event('openchamber:close-tab'));
  releaseFile();
  expect(closed).toEqual(['settings', 'file']);
});
