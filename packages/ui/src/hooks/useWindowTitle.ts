import React from 'react';

import { APP_NAME } from '@/lib/branding';
import { isDesktopShell } from '@/lib/desktop';
import { setDesktopWindowTitle } from '@/lib/desktopNative';

/**
 * The window carries the product name only. Project and instance labels used to
 * be prefixed here; a branded client must not put a folder name or a host name
 * in its title bar.
 */
export const useWindowTitle = () => {
  React.useEffect(() => {
    document.title = APP_NAME;

    if (!isDesktopShell()) {
      return;
    }

    // macOS titles come from the window itself; Windows and Linux take the
    // renderer's title through the native bridge.
    const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
    if (isMac) {
      return;
    }

    void setDesktopWindowTitle(APP_NAME).catch(() => {});
  }, []);
};
