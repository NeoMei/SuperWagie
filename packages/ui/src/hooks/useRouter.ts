import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { listenForNotificationNavigation } from '@/lib/router/notificationNavigation';
import type { RouteState, AppRouteState } from '@/lib/router';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { retireStartupLanding } from '@/lib/surfaces/startupLanding';
import { captureRuntimeInstance } from '@/lib/runtime-switch';

/**
 * Check if running in VS Code webview context.
 */
function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}

/**
 * Hook that provides bidirectional URL routing for OpenChamber.
 *
 * On mount:
 * - Parses URL parameters and applies them to app state
 * - Sets up subscriptions to sync state changes back to URL
 * - Listens for browser back/forward navigation
 *
 * Works in:
 * - Web: Full bidirectional sync
 * - Desktop: Full bidirectional sync
 * - VS Code: State-only (no URL updates, reads initial params)
 */
export function useRouter(): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);
  const cancelPendingSurfaceRef = React.useRef<(() => void) | null>(null);

  // Get store actions (stable references)
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRoute = React.useCallback(
    (route: RouteState) => {
      if (isApplyingRouteRef.current) {
        return;
      }

      cancelPendingSurfaceRef.current?.();
      isApplyingRouteRef.current = true;

      if (route.sessionId || route.settingsPath || route.tab || route.diffFile) retireStartupLanding();

      try {
        // Selection publishes synchronously. Directory confirmation may wait
        // for the global list and must not postpone Settings or URL changes.
        const sessionReady = route.sessionId ? openSessionLink(route.sessionId, route.messageId) : null;
        void sessionReady?.catch((error) => {
          console.error('[Router] session navigation failed:', error);
        });

        // 2. Handle settings first because it is a full-screen overlay.
        if (route.settingsPath) {
          setSettingsPage(resolveSettingsSlug(route.settingsPath));
          setSettingsDialogOpen(true);
          // Do not process a route view while settings is open.
          return;
        }

        // Close settings if URL has no settings section
        if (useUIStore.getState().isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }

        const applySurface = () => {
          if (route.tab && route.tab !== 'chat') {
            const directory = useDirectoryStore.getState().currentDirectory;
            if (directory) {
              const mode: ContextPanelMode = route.tab === 'files' ? 'file' : route.tab;
              useUIStore.getState().openContextSurface(directory, mode);
            }
          }
          if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
            navigateToDiff(route.diffFile);
          }
        };
        if ((!route.tab || route.tab === 'chat') && !route.diffFile) return;
        if (!sessionReady) {
          applySurface();
          return;
        }

        // Legacy workspace links need the session's confirmed directory.
        // Any later navigation retires this pending surface, including an
        // away-and-back choice whose final state matches the initial one.
        const isCurrentRuntime = captureRuntimeInstance();
        let cancelled = false;
        const cancel = () => {
          cancelled = true;
          unsubscribeUI();
          unsubscribeSession();
          if (cancelPendingSurfaceRef.current === cancel) cancelPendingSurfaceRef.current = null;
        };
        const unsubscribeUI = useUIStore.subscribe((state, previous) => {
          if (state.isSettingsDialogOpen !== previous.isSettingsDialogOpen
            || state.settingsPage !== previous.settingsPage
            || state.contextPanelByDirectory !== previous.contextPanelByDirectory
            || state.pendingDiffFile !== previous.pendingDiffFile) cancel();
        });
        const unsubscribeSession = useSessionUIStore.subscribe((state, previous) => {
          if (state.currentSessionId !== previous.currentSessionId) cancel();
        });
        cancelPendingSurfaceRef.current = cancel;
        void sessionReady.then(() => {
          const apply = !cancelled && isCurrentRuntime()
            && useSessionUIStore.getState().currentSessionId === route.sessionId;
          cancel();
          if (apply) applySurface();
        }).catch((error) => {
          cancel();
          console.error('[Router] workspace navigation failed:', error);
        });
      } finally {
        isApplyingRouteRef.current = false;
      }
    },
    [setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  /**
   * Get current app state for URL serialization.
   */
  const getCurrentAppState = React.useCallback((): AppRouteState => {
    const sessionState = useSessionUIStore.getState();
    const uiState = useUIStore.getState();

    return {
      sessionId: sessionState.currentSessionId,
      isSettingsOpen: uiState.isSettingsDialogOpen,
      settingsPath: uiState.settingsPage,
    };
  }, []);

  /**
   * Sync current app state to URL.
   */
  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (isVSCode || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppState();
      updateBrowserURL(state, options);
    },
    [isVSCode, getCurrentAppState]
  );

  // Initialize: parse URL and apply route on mount
  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Only process if URL has route params
    if (!hasRouteParams()) {
      // No route params. The launch may already have reopened the last
      // session (App selects it before this effect runs, so the session
      // subscription below never sees that change): name it in the URL
      // without adding a history entry.
      syncURLFromState({ replace: true });
      return;
    }

    const route = parseRoute();

    applyRoute(route);
    // Session selection and Settings are already published. Later user choices
    // must never be replaced by the captured startup URL after a network read.
    if (!isVSCode) {
      updateBrowserURL(getCurrentAppState(), { replace: true, force: true });
    }
  }, [applyRoute, getCurrentAppState, isVSCode, syncURLFromState]);

  React.useEffect(() => {
    if (isVSCode) return;

    return listenForNotificationNavigation((target) => {
      // Do not acknowledge a route during a synchronous route application.
      if (isApplyingRouteRef.current) return false;
      const route = parseRoute(target.searchParams);
      window.history.pushState({}, '', target.href);
      // Acceptance acknowledges ownership, not completion of session fetching.
      // Slow network reads must not cause the worker to reload a responsive app.
      applyRoute(route);
      return true;
    });
  }, [applyRoute, isVSCode]);

  React.useEffect(() => () => cancelPendingSurfaceRef.current?.(), []);

  // Subscribe to session changes
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSessionId: string | null = useSessionUIStore.getState().currentSessionId;

    const unsubscribe = useSessionUIStore.subscribe((state) => {
      const sessionId = state.currentSessionId;

      // Skip if no change or if we're currently applying a route
      if (sessionId === prevSessionId || isApplyingRouteRef.current) {
        return;
      }

      prevSessionId = sessionId;
      syncURLFromState();
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  // Subscribe to UI store changes (view, settings)
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;

    const unsubscribe = useUIStore.subscribe((state) => {
      // Skip if we're currently applying a route
      if (isApplyingRouteRef.current) {
        return;
      }

      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;

      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;

      if (settingsOpenChanged || settingsPathChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  // Listen for browser back/forward navigation
  React.useEffect(() => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    const handlePopState = () => {
      retireStartupLanding();
      cancelPendingSurfaceRef.current?.();
      // Parse the new URL and apply it
      const route = parseRoute();

      // Check if this is a route with any params, or if we should restore defaults
      if (hasRouteParams()) {
        applyRoute(route);
      } else {
        // URL has no route params - this might be a "back to home" navigation
        // Close settings if open, keep current session
        const uiState = useUIStore.getState();
        if (uiState.isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode, setSettingsDialogOpen]);
}
