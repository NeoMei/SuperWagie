import React from 'react';
import { getGuidanceStep } from '@/lib/product-help/guidance';
import { observeGuidanceTarget } from '@/lib/product-help/guidance-dom';
import { useProductHelpGuidanceStore } from '@/lib/product-help/guidance-store';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

/** Mount once in the desktop shell; the settings dialog can share the same guide. */
export function GuidanceHighlight(): React.ReactNode {
  const session = useProductHelpGuidanceStore((state) => state.session);
  const hasSession = session !== null;
  const active = session !== null && session.status !== 'unavailable' && session.status !== 'completed';
  const requestId = session?.requestId;
  const step = session ? getGuidanceStep(session) : null;
  const itemId = step?.itemId;
  const scroll = step?.action !== 'appearance.language.changed';

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => useProductHelpGuidanceStore.getState().stop()), []);
  React.useEffect(() => {
    if (!active || requestId === undefined || !itemId) return;
    const stopObserving = observeGuidanceTarget({
      document,
      itemId,
      scroll,
      onReady: () => useProductHelpGuidanceStore.getState().markReady(requestId),
      onUnavailable: (reason) => useProductHelpGuidanceStore.getState().markUnavailable(requestId, reason),
    });
    return stopObserving;
  }, [active, requestId, itemId, scroll]);

  React.useEffect(() => {
    if (!hasSession) return;
    return useUIStore.subscribe((state, previous) => {
      const current = useProductHelpGuidanceStore.getState().session;
      const destination = current ? getGuidanceStep(current).destination : null;
      if ((destination?.kind === 'settings' && previous.isSettingsDialogOpen && !state.isSettingsDialogOpen)
        || (destination?.kind === 'about' && previous.isAboutDialogOpen && !state.isAboutDialogOpen)) {
        useProductHelpGuidanceStore.getState().stop();
      }
    });
  }, [hasSession]);

  return <style>{`
    [data-product-help-highlight="true"] {
      outline: 2px solid var(--status-info);
      outline-offset: 4px;
      border-radius: 6px;
      background-color: var(--status-info-background);
    }
    [data-product-help-target][data-product-help-highlight="true"] {
      outline: none;
    }
    [data-product-help-target][data-product-help-highlight="true"]::after {
      content: '';
      position: absolute;
      inset: 1px;
      z-index: 40;
      pointer-events: none;
      border: 2px solid var(--status-info);
      border-radius: 6px;
    }
  `}</style>;
}
