import { create } from 'zustand';
import { isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useUIStore } from '@/stores/useUIStore';
import { createGuidanceState, getGuidanceLocation, type GuidanceState } from './guidance';
import { getSettingsPageMeta } from '@/lib/settings/metadata';
import { useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { isProductHelpSurfaceSupported, navigateProductHelpSurface } from './surface-navigation';

export const useProductHelpGuidanceStore = create<GuidanceState>(createGuidanceState({
  isSupported: (target) => {
    if (isVSCodeRuntime() || isMobileSurfaceRuntime()) return false;
    const { destination } = getGuidanceLocation(target);
    if (destination.kind === 'surface') return isProductHelpSurfaceSupported(destination.surface);
    if (destination.kind === 'about') return true;
    const enterpriseMode = useEnterprisePolicyStore.getState().enterpriseMode || useRoutingStore.getState().enterpriseMode;
    return (target !== 'knowledge' || isDesktopShell()) && (getSettingsPageMeta(destination.page)?.isAvailable?.({
      isVSCode: false, isMobile: false, isDesktop: isDesktopShell(), isWeb: isWebRuntime(),
      routingAvailable: useUIStore.getState().routingFeatureAvailable,
      enterpriseMode, jevBlockedByEnterprise: enterpriseMode && !useRoutingStore.getState().jevAvailable,
    }) ?? true);
  },
  navigate: (step) => {
    if (step.destination.kind === 'surface') return navigateProductHelpSurface(step.destination.surface);
    const ui = useUIStore.getState();
    if (step.destination.kind === 'about') {
      ui.setSettingsDialogOpen(false);
      ui.setAboutDialogOpen(true);
      return;
    }
    ui.setAboutDialogOpen(false);
    ui.requestSettingsJump(step.destination.page, step.itemId.startsWith('settings-page.') ? null : step.itemId);
    ui.setSettingsDialogOpen(true);
  },
}));

/** Capture before a user action. Only the matching guide attempt can consume its result. */
export const beginGuidanceAction: GuidanceState['beginAction'] = (action) =>
  useProductHelpGuidanceStore.getState().beginAction(action);

/** Called by the owning control after observing the actual result; never passes form values. */
export const reportGuidanceAction: GuidanceState['reportAction'] = (token, outcome) =>
  useProductHelpGuidanceStore.getState().reportAction(token, outcome);
