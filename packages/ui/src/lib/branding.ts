/**
 * The product identity a person sees. Package names, the data directory, IPC
 * channel names and the `openchamber-ui://` protocol stay as upstream so this
 * branch keeps taking upstream changes; only the visible name lives here.
 */
export const APP_NAME = '灵犀智能体';

/** ASCII form for build metadata, file names and logs. */
export const APP_NAME_EN = 'SuperWagie';

/** Deep links belong to this product, so a side-by-side OpenChamber install wins nothing. */
export const DEEP_LINK_SCHEME = 'lingxi';

/**
 * Self-updates stay off until LingXi has a release repository of its own.
 * Upstream's feed would replace this build with OpenChamber.
 */
export const SELF_UPDATES_ENABLED = false;
