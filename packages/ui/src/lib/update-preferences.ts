// Device-local update preferences. They live in localStorage, not the server
// settings file: auto-checking and skipping a version are properties of this
// installation, not of the workspace it connects to.

export const AUTO_CHECK_UPDATES_KEY = 'oc.updates.autoCheck';
export const SKIPPED_UPDATE_VERSION_KEY = 'oc.updates.skippedVersion';

const storage = (): Storage | null => {
  const win = globalThis.window;
  if (!win) return null;
  try {
    return win.localStorage;
  } catch {
    return null;
  }
};

export const isAutoCheckEnabled = (): boolean => storage()?.getItem(AUTO_CHECK_UPDATES_KEY) !== '0';

export const setAutoCheckEnabled = (enabled: boolean): void => {
  try {
    storage()?.setItem(AUTO_CHECK_UPDATES_KEY, enabled ? '1' : '0');
  } catch {
    // A full or disabled storage only means the choice is not remembered.
  }
};

export const getSkippedUpdateVersion = (): string => storage()?.getItem(SKIPPED_UPDATE_VERSION_KEY)?.trim() ?? '';

export const skipUpdateVersion = (version: string): void => {
  const value = version.trim();
  if (!value) return;
  try {
    storage()?.setItem(SKIPPED_UPDATE_VERSION_KEY, value);
  } catch {
    // ignored, see setAutoCheckEnabled
  }
};

export const clearSkippedUpdate = (): void => {
  try {
    storage()?.removeItem(SKIPPED_UPDATE_VERSION_KEY);
  } catch {
    // ignored
  }
};
