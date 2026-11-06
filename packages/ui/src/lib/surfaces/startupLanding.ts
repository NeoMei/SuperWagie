import { captureRuntimeInstance } from '@/lib/runtime-switch';

function createStartupLanding() {
    let pending = true;
    const isCurrentRuntime = captureRuntimeInstance();
    return {
        get pending() { return pending && isCurrentRuntime(); },
        retire() { pending = false; },
        apply(open: () => void) {
            if (!pending || !isCurrentRuntime()) return;
            pending = false;
            open();
        },
    };
}

// A layout remount, catalog refresh or runtime switch is still the same launch.
const launches = new WeakMap<Window, ReturnType<typeof createStartupLanding>>();

export function getStartupLanding(target: Window) {
    let landing = launches.get(target);
    if (!landing) {
        landing = createStartupLanding();
        launches.set(target, landing);
    }
    return landing;
}

/** Explicit navigation can arrive before MainLayout or the guest catalog. */
export function retireStartupLanding(): void {
    if (typeof window !== 'undefined') getStartupLanding(window).retire();
}
