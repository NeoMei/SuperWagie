import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
    localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
})) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { ComposerStopCoin } = await import('./ComposerStopCoin');

afterAll(async () => {
    await browser.happyDOM.close();
    for (const [name, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

describe('ComposerStopCoin', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        browser.happyDOM.settings.device.prefersReducedMotion = 'no-preference';
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
    });

    test('pauses its orbit for reduced motion and a hidden page while the coin stays visible', async () => {
        const preference = browser.matchMedia('(prefers-reduced-motion: reduce)');
        const media = spyOn(browser, 'matchMedia').mockReturnValue(preference);
        const coin = () => host.querySelector('[data-composer-stop-coin]');
        const expectVisibleCoin = (paused: boolean) => {
            const control = coin();
            expect(control).not.toBeNull();
            const base = control?.querySelector<HTMLElement>('[data-composer-stop-coin-base]');
            expect(control?.hasAttribute('data-composer-stop-coin-paused')).toBe(paused);
            expect(base).not.toBeNull();
            expect(control?.querySelector('[data-composer-stop-coin-orbit]')).not.toBeNull();
            expect(control?.querySelector('[data-composer-stop-coin-square]')).not.toBeNull();
            expect(base?.style.boxShadow).toBe('inset 0 0 0 1px var(--oc-brand-signal)');
        };

        try {
            await act(async () => root.render(<ComposerStopCoin />));
            expectVisibleCoin(false);

            await act(async () => {
                browser.happyDOM.settings.device.prefersReducedMotion = 'reduce';
                preference.dispatchEvent(new browser.Event('change'));
            });
            expectVisibleCoin(true);

            await act(async () => {
                browser.happyDOM.settings.device.prefersReducedMotion = 'no-preference';
                preference.dispatchEvent(new browser.Event('change'));
            });
            expectVisibleCoin(false);

            await act(async () => {
                Object.defineProperty(document, 'hidden', { configurable: true, value: true });
                document.dispatchEvent(new Event('visibilitychange'));
            });
            expectVisibleCoin(true);

            await act(async () => {
                Object.defineProperty(document, 'hidden', { configurable: true, value: false });
                document.dispatchEvent(new Event('visibilitychange'));
            });
            expectVisibleCoin(false);
        } finally {
            media.mockRestore();
        }
    });
});
