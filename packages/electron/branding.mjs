/**
 * Visible identity for the desktop shell. Package names, IPC channels, the
 * data directory and `openchamber-ui://` stay as upstream so this branch keeps
 * taking upstream changes.
 */
export const APP_NAME = '犇马';

/** ASCII form for file names, logs and the packaged bundle name. */
export const APP_NAME_EN = 'SuperWagie';

/** Deep links are this product's own, so a side-by-side OpenChamber install wins nothing. */
export const DEEP_LINK_PROTOCOL = 'lingxi';

/**
 * On: Windows installs updates from the SuperWagie release feed. macOS only
 * checks the feed and opens the DMG (the ad-hoc build cannot self-install).
 */
export const UPDATES_ENABLED = true;
