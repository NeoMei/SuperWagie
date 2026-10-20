/**
 * Visible identity for the desktop shell. Package names, IPC channels, the
 * data directory and `openchamber-ui://` stay as upstream so this branch keeps
 * taking upstream changes.
 */
export const APP_NAME = '灵犀智能体';

/** ASCII form for file names, logs and the packaged bundle name. */
export const APP_NAME_EN = 'SuperWagie';

/** Deep links are this product's own, so a side-by-side OpenChamber install wins nothing. */
export const DEEP_LINK_PROTOCOL = 'lingxi';

/**
 * Off until LingXi has a release feed. Upstream's feed would replace this
 * build with OpenChamber.
 */
export const UPDATES_ENABLED = false;
