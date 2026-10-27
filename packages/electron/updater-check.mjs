import { z } from 'zod';

const MISSING_UPDATE_FEED_RE =
  /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i;

const isMissingUpdateFeedError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_UPDATE_FEED_RE.test(message);
};

export const checkForDesktopUpdate = async ({ autoUpdater, currentVersion, pendingUpdate, compareVersions }) => {
  let updateResult;
  try {
    updateResult = await autoUpdater.checkForUpdates();
  } catch (error) {
    // Before the first Linux (or platform) release publishes its feed, electron-updater
    // returns 404 for latest-*.yml. Treat that as authoritative "no update" instead of
    // surfacing a hard failure that looks like a broken updater.
    if (isMissingUpdateFeedError(error)) {
      return {
        available: false,
        updateInfo: null,
        updateResult: null,
        nextVersion: currentVersion,
        pendingUpdate: null,
      };
    }
    const detail = error instanceof Error && error.message ? error.message : 'network';
    throw new Error(`E_UPDATE:checkFailed:${detail}`, { cause: error });
  }

  const updateInfo = updateResult?.updateInfo;
  const nextVersion =
    (typeof updateInfo?.version === 'string' && updateInfo.version) ||
    currentVersion;
  const available = compareVersions(nextVersion, currentVersion) > 0;
  return {
    available,
    updateInfo,
    updateResult,
    nextVersion,
    pendingUpdate: available ? { version: nextVersion, electronUpdate: updateResult } : null,
  };
};

const LATEST_JSON_URL =
  'https://github.com/NeoMei/SuperWagie-Open/releases/latest/download/latest.json';

const MAC_FEED_SCHEMA = z.object({
  version: z.string().min(1),
  notes: z.string().optional(),
  publishedAt: z.string().optional(),
  mac: z.object({
    url: z.string().url(),
    // Present once the release ships a ZIP the app can install itself from.
    zip: z.object({
      url: z.string().url(),
      sha256: z.string().min(1),
      size: z.number().int().nonnegative(),
    }).optional(),
  }),
}).passthrough();

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

const RELEASE_NOTES_FEED_SCHEMA = z.object({
  version: z.string(),
  notes: z.string(),
});

/**
 * Older Windows manifests omit releaseNotes. Read the offered SuperWagie
 * release's feed, keeping both locale blocks for the renderer to select.
 * A missing note never changes update availability or uses upstream notes.
 */
export const fetchDesktopUpdateNotes = async ({ version, fetchImpl = fetch }) => {
  if (!SEMVER_RE.test(version)) return null;
  const feedUrl = `https://github.com/NeoMei/SuperWagie-Open/releases/download/v${encodeURIComponent(version)}/latest.json`;
  try {
    const response = await fetchImpl(feedUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = RELEASE_NOTES_FEED_SCHEMA.safeParse(await response.json());
    if (!parsed.success || parsed.data.version !== version) return null;
    return parsed.data.notes.trim() ? parsed.data.notes : null;
  } catch {
    return null;
  }
};

/**
 * macOS check: read the static feed from the latest SuperWagie release. There
 * is no auto-install, because an ad-hoc build cannot satisfy Squirrel.Mac's
 * code-signature check, so the caller opens the DMG URL instead.
 */
export const checkForMacUpdate = async ({
  currentVersion,
  compareVersions,
  fetchImpl = fetch,
  feedUrl = LATEST_JSON_URL,
  releaseBaseUrl = 'https://github.com/NeoMei/SuperWagie-Open/releases/tag/v',
} = {}) => {
  let response;
  try {
    response = await fetchImpl(feedUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`E_UPDATE:checkFailed:${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  // A feed that is not on the latest release yet is authoritative "no update",
  // exactly like electron-updater's missing-manifest handling.
  if (response.status === 404) {
    return {
      available: false,
      currentVersion,
      version: null,
      body: null,
      date: null,
      releaseUrl: null,
      downloadUrl: null,
    };
  }
  if (!response.ok) {
    throw new Error(`E_UPDATE:checkFailed:HTTP ${response.status}`);
  }

  const parsed = MAC_FEED_SCHEMA.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('E_UPDATE:feedInvalid:');
  const version = parsed.data.version.trim().replace(/^v/, '');
  const downloadUrl = parsed.data.mac.url;
  if (!SEMVER_RE.test(version)) throw new Error('E_UPDATE:feedInvalid:');

  const available = compareVersions(version, currentVersion) > 0;
  return {
    available,
    currentVersion,
    version: available ? version : null,
    body: parsed.data.notes?.trim() ? parsed.data.notes : null,
    date: parsed.data.publishedAt ?? null,
    releaseUrl: `${releaseBaseUrl}${version}`,
    downloadUrl: available ? downloadUrl : null,
    zipUrl: available ? parsed.data.mac.zip?.url ?? null : null,
    zipSha256: available ? parsed.data.mac.zip?.sha256 ?? null : null,
    zipSize: available ? parsed.data.mac.zip?.size ?? null : null,
    // A release without a ZIP can only be installed by hand, the way it was
    // downloaded: the DMG stays the action then.
    installBlocked: available && !parsed.data.mac.zip ? 'manual-install' : undefined,
  };
};
