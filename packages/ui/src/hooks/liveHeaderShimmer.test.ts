import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';
import { isShimmerAllowed, watchHeaderShimmer } from './liveHeaderShimmer';

const originals = new Map<string, PropertyDescriptor | undefined>();
type TestWindow = Window & typeof globalThis;
const domWindowSchema = z.custom<TestWindow>((value) => value instanceof Window);

const nativeVisibility = (dom: TestWindow, detail: boolean | string): void => {
    const event = new dom.CustomEvent('openchamber:window-visibility', { detail });
    // SAFETY: Happy DOM creates this window's own CustomEvent, so it satisfies
    // the window's dispatchEvent parameter even though Node's Event differs.
    dom.dispatchEvent(event as Parameters<TestWindow['dispatchEvent']>[0]);
};

const withDOM = async (desktop: boolean, run: (dom: TestWindow) => Promise<void> | void) => {
    const dom = new Window({ url: 'http://shimmer.test' });
    Object.defineProperty(dom.document, 'visibilityState', { configurable: true, value: 'visible' });
    const bridge = desktop ? {
        invoke: (command: string) => command === 'desktop_get_current_window_state'
            ? { visible: true }
            : null,
    } : undefined;
    Object.defineProperties(dom, {
        __OPENCHAMBER_ELECTRON__: { value: desktop ? { runtime: 'electron' } : undefined },
        __OPENCHAMBER_DESKTOP__: { value: bridge },
    });
    const globals = {
        window: dom,
        document: dom.document,
        navigator: dom.navigator,
        CustomEvent: dom.CustomEvent,
        Event: dom.Event,
        matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    } as const;
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    try {
        await run(domWindowSchema.parse(dom));
    } finally {
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        originals.clear();
        await dom.happyDOM.close();
    }
};

describe('live header shimmer', () => {
    test('web visibility uses the document, viewport and motion preference only', async () => {
        await withDOM(false, () => {
            expect(isShimmerAllowed()).toBe(true);
            expect(watchHeaderShimmer(null, () => undefined)()).toBeUndefined();
        });
    });

    test('Electron native visibility events update the permission and cleanup removes the listener', async () => {
        await withDOM(true, async (dom) => {
            const permissions: boolean[] = [];
            const dispose = watchHeaderShimmer(null, (value) => {
                if (value === true || value === false) permissions.push(value);
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(permissions).toContain(true);
            nativeVisibility(dom, false);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(permissions.at(-1)).toBe(false);
            nativeVisibility(dom, true);
            expect(permissions.at(-1)).toBe(true);

            const beforeCleanup = permissions.length;
            dispose();
            nativeVisibility(dom, false);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(permissions).toHaveLength(beforeCleanup);
            nativeVisibility(dom, 'hidden');
            expect(permissions).toHaveLength(beforeCleanup);
        });
    });
});
