import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { observeGuidanceTarget } from './guidance-dom';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  document: browser.document,
  MutationObserver: browser.MutationObserver,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function anchor(id: string) {
  const element = document.createElement('section');
  element.dataset.settingsItem = id;
  const rect = new browser.DOMRect(10, 10, 100, 50);
  Object.defineProperty(element, 'getClientRects', { value: () => [rect] });
  const scroll = spyOn(element, 'scrollIntoView').mockImplementation(() => {});
  cleanups.push(() => scroll.mockRestore());
  document.body.append(element);
  return { element, scroll };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 35));

describe('product help target highlighting', () => {
  test('highlights the real anchor, scrolls once, and removes the highlight on cleanup', async () => {
    const { element, scroll } = anchor('models.overview');
    const lookups = spyOn(document, 'querySelectorAll');
    cleanups.push(() => lookups.mockRestore());
    let ready = 0;
    const failures: string[] = [];
    const stop = observeGuidanceTarget({
      document, itemId: 'models.overview',
      onReady: () => { ready += 1; }, onUnavailable: (reason) => failures.push(reason),
    });
    cleanups.push(stop);
    expect(element.dataset.productHelpHighlight).toBe('true');
    expect(ready).toBe(1);
    expect(scroll.mock.calls).toHaveLength(1);
    expect(lookups.mock.calls.filter(([selector]) => selector.startsWith('[data-settings-item='))).toHaveLength(1);
    document.body.append(document.createElement('p'));
    await settle();
    expect(ready).toBe(1);
    expect(scroll.mock.calls).toHaveLength(1);
    expect(lookups.mock.calls.filter(([selector]) => selector.startsWith('[data-settings-item='))).toHaveLength(1);
    stop();
    expect(element.hasAttribute('data-product-help-highlight')).toBe(false);
    expect(failures).toEqual([]);
  });

  test('waits for an asynchronously mounted anchor', async () => {
    let ready = 0;
    const stop = observeGuidanceTarget({
      document, itemId: 'appearance.language',
      onReady: () => { ready += 1; }, onUnavailable: () => {},
    });
    cleanups.push(stop);
    expect(ready).toBe(0);
    const { element } = anchor('appearance.language');
    await settle();
    expect(ready).toBe(1);
    expect(element.dataset.productHelpHighlight).toBe('true');
  });

  test('hidden targets are not presented as successful navigation', async () => {
    const { element } = anchor('models.overview');
    element.hidden = true;
    let ready = 0;
    const failures: string[] = [];
    cleanups.push(observeGuidanceTarget({
      document, itemId: 'models.overview', timeoutMs: 10,
      onReady: () => { ready += 1; }, onUnavailable: (reason) => failures.push(reason),
    }));
    await settle();
    expect(ready).toBe(0);
    expect(failures).toEqual(['not-found']);
    expect(element.hasAttribute('data-product-help-highlight')).toBe(false);
  });

  test('navigation away invalidates the active step and cleans the detached target', async () => {
    const { element } = anchor('models.overview');
    const failures: string[] = [];
    cleanups.push(observeGuidanceTarget({
      document, itemId: 'models.overview',
      onReady: () => {}, onUnavailable: (reason) => failures.push(reason),
    }));
    element.remove();
    await settle();
    expect(failures).toEqual(['hidden']);
    expect(element.hasAttribute('data-product-help-highlight')).toBe(false);
  });

  test('ending before the target arrives cancels lookup and failure callbacks', async () => {
    const events: string[] = [];
    const stop = observeGuidanceTarget({
      document, itemId: 'models.overview', timeoutMs: 10,
      onReady: () => events.push('ready'), onUnavailable: (reason) => events.push(reason),
    });
    stop();
    const { element } = anchor('models.overview');
    await settle();
    expect(events).toEqual([]);
    expect(element.hasAttribute('data-product-help-highlight')).toBe(false);
  });

  test('can keep an open picker in place without scrolling its anchor', () => {
    const { element, scroll } = anchor('appearance.language');
    cleanups.push(observeGuidanceTarget({
      document, itemId: 'appearance.language', scroll: false,
      onReady: () => {}, onUnavailable: () => {},
    }));
    expect(scroll.mock.calls).toHaveLength(0);
    expect(element.dataset.productHelpHighlight).toBe('true');
  });

  test('replacing the same anchor keeps its step and cleans the previous node', async () => {
    const original = anchor('appearance.language');
    const events: string[] = [];
    cleanups.push(observeGuidanceTarget({
      document, itemId: 'appearance.language',
      onReady: () => events.push('ready'), onUnavailable: (reason) => events.push(reason),
    }));
    original.element.remove();
    const replacement = anchor('appearance.language');
    await settle();
    expect(events).toEqual(['ready', 'ready']);
    expect(original.element.hasAttribute('data-product-help-highlight')).toBe(false);
    expect(replacement.element.dataset.productHelpHighlight).toBe('true');
  });

  test('a failed step stays unavailable until an explicit retry observes it again', async () => {
    const original = anchor('appearance.language');
    const events: string[] = [];
    cleanups.push(observeGuidanceTarget({
      document, itemId: 'appearance.language',
      onReady: () => events.push('ready'), onUnavailable: (reason) => events.push(reason),
    }));
    original.element.hidden = true;
    await settle();
    original.element.hidden = false;
    await settle();
    expect(events).toEqual(['ready', 'hidden']);
    expect(original.element.hasAttribute('data-product-help-highlight')).toBe(false);
    cleanups.push(observeGuidanceTarget({
      document, itemId: 'appearance.language',
      onReady: () => events.push('retried'), onUnavailable: (reason) => events.push(reason),
    }));
    expect(events).toEqual(['ready', 'hidden', 'retried']);
    expect(original.element.dataset.productHelpHighlight).toBe('true');
  });
});
