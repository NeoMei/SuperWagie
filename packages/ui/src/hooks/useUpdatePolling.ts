import React from 'react';

import { DESKTOP_SELF_UPDATES_ENABLED } from '@/lib/branding';
import { isElectronShell } from '@/lib/desktop';
import { getSkippedUpdateVersion, isAutoCheckEnabled } from '@/lib/update-preferences';
import { useUpdateStore } from '@/stores/useUpdateStore';

const FIRST_CHECK_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

const isWindows = (): boolean => window.navigator.platform.toLowerCase().includes('win');

/**
 * Background checks for the packaged desktop app. Windows downloads silently
 * and the dialog opens when the installer is ready; macOS only marks the
 * update available and the dialog opens for the DMG link. Reading the setting
 * on every tick means turning it off takes effect without a restart. Web,
 * VS Code and mobile never self-update from this feed.
 */
export function useUpdatePolling() {
  React.useEffect(() => {
    if (!DESKTOP_SELF_UPDATES_ENABLED || !isElectronShell()) return;

    let disposed = false;
    let timer: number | null = null;

    const check = async () => {
      if (disposed || !isAutoCheckEnabled()) return;
      const before = useUpdateStore.getState();
      if (before.checking || before.downloading) return;

      await before.checkForUpdates();
      if (disposed) return;

      const after = useUpdateStore.getState();
      const version = after.info?.version;
      if (!after.available || !version || getSkippedUpdateVersion() === version) return;
      if (!isWindows() || after.downloaded || after.downloading) return;
      void after.downloadUpdate();
    };

    const schedule = (delayMs: number) => {
      if (disposed) return;
      timer = window.setTimeout(async () => {
        await check();
        schedule(CHECK_INTERVAL_MS);
      }, delayMs);
    };

    schedule(FIRST_CHECK_MS);

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
}
