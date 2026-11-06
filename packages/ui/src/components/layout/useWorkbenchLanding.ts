import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { getStartupLanding } from '@/lib/surfaces/startupLanding';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const interactionEvents = ['pointerdown', 'keydown', 'click', 'popstate'];

const hasOpenPage = (state: ReturnType<typeof useUIStore.getState>) => Boolean(
    state.openGuestPageId || state.isScheduledTasksDialogOpen || state.isArchivePageOpen
    || state.isIntegrationsCatalogOpen || state.isUsageStatsPageOpen || state.isSourceBoardOpen
    || state.isOverviewOpen || state.worktreesPageProjectId || state.spacesPageProjectId
    || state.runOverviewKey || state.isSettingsDialogOpen || state.creationIntent,
);

export function useWorkbenchLanding(guestPages: ReadonlyArray<{ id: string }>): void {
    const workbenchId = guestPages.find((guest) => guest.id === 'openchamber-builtin-workbench')?.id;
    React.useLayoutEffect(() => {
        const landing = getStartupLanding(window);
        if (!landing.pending) return;
        let timer: number | undefined;
        const cleanup = () => {
            if (timer !== undefined) window.clearTimeout(timer);
            interactionEvents.forEach((event) => window.removeEventListener(event, retire, true));
            unsubscribe();
            unsubscribeRuntime();
        };
        const retire = () => {
            landing.retire();
            cleanup();
        };
        // Capture before controls stop propagation, including before catalog discovery.
        interactionEvents.forEach((event) => window.addEventListener(event, retire, true));
        const unsubscribe = useUIStore.subscribe((state) => {
            if (hasOpenPage(state)) retire();
        });
        const unsubscribeRuntime = subscribeRuntimeEndpointChanged((detail) => {
            if (detail.runtimeKey !== detail.previousRuntimeKey) retire();
        });
        if (hasOpenPage(useUIStore.getState())) {
            retire();
            return cleanup;
        }
        if (workbenchId) {
            // Automatic startup session/draft restoration closes main pages. Keep
            // its existing settle delay, while explicit navigation retires authority.
            timer = window.setTimeout(() => {
                cleanup();
                landing.apply(() => useUIStore.getState().setOpenGuestPage(workbenchId));
            }, 1500);
        }
        return cleanup;
    }, [workbenchId]);
}
