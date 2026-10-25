import { create } from 'zustand';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useUIStore } from '@/stores/useUIStore';
import { createGuidanceState, type GuidanceState } from './guidance';

export const useProductHelpGuidanceStore = create<GuidanceState>(createGuidanceState({
  isSupported: (target) => !isVSCodeRuntime()
    && !isMobileSurfaceRuntime()
    && (target !== 'knowledge' || isDesktopShell()),
  navigate: (step) => {
    const ui = useUIStore.getState();
    ui.requestSettingsJump(step.page, step.itemId);
    ui.setSettingsDialogOpen(true);
  },
}));

/** Capture before a user action. Only the matching guide attempt can consume its result. */
export const beginGuidanceAction: GuidanceState['beginAction'] = (action) =>
  useProductHelpGuidanceStore.getState().beginAction(action);

/** Called by the owning control after observing the actual result; never passes form values. */
export const reportGuidanceAction: GuidanceState['reportAction'] = (token, outcome) =>
  useProductHelpGuidanceStore.getState().reportAction(token, outcome);
