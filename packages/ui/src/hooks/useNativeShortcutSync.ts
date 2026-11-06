import React from 'react';
import { canUseElectronDesktopIPC, invokeDesktop, setDesktopShortcutSequenceState } from '@/lib/desktop';
import { getNativeMenuShortcutCombos, type ShortcutDispatcher } from '@/lib/shortcuts';
import { hasActiveSelectionToolbar, subscribeActiveSelectionToolbar } from '@/lib/addSelectionToChat';
import { useUIStore } from '@/stores/useUIStore';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

/** One owner per renderer window, including Mini Chat's independent registry. */
export function useNativeShortcutSync(dispatcher: ShortcutDispatcher, selectionDispatcher?: ShortcutDispatcher): void {
  React.useEffect(() => {
    if (!canUseElectronDesktopIPC()) return;
    let lastLeaders = '';
    let lastMenu = '';
    let reportTimer: ReturnType<typeof setTimeout> | undefined;
    const activeDispatcher = () => selectionDispatcher && hasActiveSelectionToolbar() ? selectionDispatcher : dispatcher;
    const publish = () => {
      const active = activeDispatcher();
      const chords = active.getLeaderChords();
      const key = JSON.stringify(chords);
      if (key !== lastLeaders) {
        lastLeaders = key;
        setDesktopShortcutSequenceState({ type: 'leaders', chords });
      }
      setDesktopShortcutSequenceState({ type: 'pending', timeoutMs: Math.min(3000, active.getPendingTimeout()) });
    };
    const clear = () => {
      dispatcher.clear(); selectionDispatcher?.clear();
      setDesktopShortcutSequenceState({ type: 'pending', timeoutMs: 0 });
    };
    const syncMenu = () => {
      const shortcuts = getNativeMenuShortcutCombos(useUIStore.getState().shortcutOverrides);
      const key = JSON.stringify(shortcuts);
      if (key === lastMenu) return;
      lastMenu = key;
      void invokeDesktop('desktop_set_menu_shortcuts', { shortcuts }).catch(error => {
        if (lastMenu === key) lastMenu = '';
        console.warn('[shortcuts] native menu update failed', error);
      });
    };
    // A local input handler can stop propagation before any dispatcher sees a
    // prearmed leader. Release that provisional capture after the DOM event ends.
    const afterKey = () => {
      clearTimeout(reportTimer);
      reportTimer = setTimeout(publish, 0);
    };
    const unregister = dispatcher.subscribe(publish);
    const unregisterSelection = selectionDispatcher?.subscribe(publish);
    const unregisterToolbar = subscribeActiveSelectionToolbar(() => { clear(); publish(); });
    const unregisterStore = useUIStore.subscribe((state, previous) => {
      if (state.shortcutOverrides === previous.shortcutOverrides) return;
      clear(); publish(); syncMenu();
    });
    const unregisterRuntime = subscribeRuntimeEndpointWillChange(clear);
    const focus = () => { publish(); syncMenu(); };
    window.addEventListener('keydown', afterKey, true);
    window.addEventListener('blur', clear);
    window.addEventListener('focus', focus);
    publish(); syncMenu();
    return () => {
      clearTimeout(reportTimer);
      unregister(); unregisterSelection?.(); unregisterToolbar(); unregisterStore(); unregisterRuntime();
      window.removeEventListener('keydown', afterKey, true);
      window.removeEventListener('blur', clear);
      window.removeEventListener('focus', focus);
      clear();
      setDesktopShortcutSequenceState({ type: 'leaders', chords: [] });
    };
  }, [dispatcher, selectionDispatcher]);
}
