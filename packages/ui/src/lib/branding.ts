/**
 * The product identity a person sees. Package names, the data directory, IPC
 * channel names and the `openchamber-ui://` protocol stay as upstream so this
 * branch keeps taking upstream changes; only the visible name lives here.
 */
export const APP_NAME = '犇马';

/** ASCII form for build metadata, file names and logs. */
export const APP_NAME_EN = 'SuperWagie';

/** Deep links belong to this product, so a side-by-side OpenChamber install wins nothing. */
export const DEEP_LINK_SCHEME = 'lingxi';

/**
 * Server/web updates stay off: the server's update check would offer an
 * upstream OpenChamber release. This flag keeps that path disabled.
 */
export const SELF_UPDATES_ENABLED = false;

/**
 * The desktop app checks and installs its own releases: Windows auto-installs,
 * macOS opens the DMG (no Developer ID signature, so no auto-install).
 */
export const DESKTOP_SELF_UPDATES_ENABLED = true;
