import type React from 'react';
import { z } from 'zod';
import { getDesktopWindowVisibility, isDesktopShell } from '@/lib/desktop';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const NATIVE_WINDOW_VISIBILITY_EVENT = 'openchamber:window-visibility';

interface ShimmerConditions {
    allowed: () => boolean;
    dispose: () => void;
}

interface NativeVisibilityEvent {
    detail: unknown;
}

const nativeVisibilityEventSchema = z.object({ detail: z.boolean() });
const domViewSchema = z.custom<Window & typeof globalThis>((value) => 'CustomEvent' in Object(value));

/** Reads the environment inputs and reports each later change. */
const readConditions = (element: HTMLButtonElement | null, onChange: () => void): ShimmerConditions => {
    const disposers: Array<() => void> = [];
    const preference = globalThis.matchMedia?.(REDUCED_MOTION_QUERY);
    const ownerDocument = element?.ownerDocument ?? globalThis.document;
    const view: Window | typeof globalThis = ownerDocument?.defaultView ?? globalThis;
    const desktopShell = isDesktopShell();
    let reducedMotion = preference?.matches ?? false;
    let inView = true;
    // Desktop visibility events arrive on a DOM window, while a plain test
    // process has no native window to attach them to.
    const nativeView = domViewSchema.safeParse(view);
    let nativeWindowVisible = !desktopShell || !nativeView.success;
    let disposed = false;
    let nativeVisibilityRevision = 0;

    if (preference) {
        const motionChanged = (event: MediaQueryListEvent) => {
            reducedMotion = event.matches;
            onChange();
        };
        preference.addEventListener('change', motionChanged);
        disposers.push(() => preference.removeEventListener('change', motionChanged));
    }

    if (ownerDocument) {
        ownerDocument.addEventListener('visibilitychange', onChange);
        disposers.push(() => ownerDocument.removeEventListener('visibilitychange', onChange));

        const Observer = ownerDocument.defaultView?.IntersectionObserver;
        if (element && Observer) {
            const observer = new Observer((entries) => {
                inView = entries.at(-1)?.isIntersecting ?? false;
                onChange();
            });
            observer.observe(element);
            disposers.push(() => observer.disconnect());
        }
    }

    if (desktopShell && nativeView.success) {
        const windowView = nativeView.data;
        const onNativeVisibility = (event: Event) => {
            if (!(event instanceof windowView.CustomEvent)) return;
            const parsed = nativeVisibilityEventSchema.safeParse(event satisfies NativeVisibilityEvent);
            if (!parsed.success) return;
            nativeVisibilityRevision += 1;
            nativeWindowVisible = parsed.data.detail;
            onChange();
        };
        windowView.addEventListener(NATIVE_WINDOW_VISIBILITY_EVENT, onNativeVisibility);
        disposers.push(() => windowView.removeEventListener(NATIVE_WINDOW_VISIBILITY_EVENT, onNativeVisibility));

        void getDesktopWindowVisibility().then((visible) => {
            if (disposed || nativeVisibilityRevision !== 0) return;
            nativeWindowVisible = visible === true;
            onChange();
        }).catch(() => undefined);
    }

    return {
        allowed: () => !reducedMotion
            && (ownerDocument?.visibilityState ?? 'visible') !== 'hidden'
            && nativeWindowVisible
            && inView,
        dispose: () => {
            disposed = true;
            disposers.forEach((dispose) => dispose());
        },
    };
};

/** The initial state reads motion and page visibility; the effect adds viewport tracking. */
export const isShimmerAllowed = (): boolean => {
    const conditions = readConditions(null, () => undefined);
    try {
        return conditions.allowed();
    } finally {
        conditions.dispose();
    }
};

/** Keeps a mounted header's shimmer permission current until it unmounts. */
export const watchHeaderShimmer = (
    element: HTMLButtonElement | null,
    setAllowed: React.Dispatch<React.SetStateAction<boolean>>,
): (() => void) => {
    const update = (conditions: ShimmerConditions) => setAllowed(conditions.allowed());
    const conditions = readConditions(element, () => update(conditions));
    update(conditions);
    return conditions.dispose;
};
