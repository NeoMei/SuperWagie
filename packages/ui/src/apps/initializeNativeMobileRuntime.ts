import { syncDesktopSettings } from '@/lib/persistence';
import { readPlatformIdentitySession } from '@/lib/platformAccount';
import { captureRuntimeInstance, getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

const NATIVE_BOOTSTRAP_READ_TIMEOUT_MS = 2500;
let modelPreferencesOwner: (() => boolean) | undefined;

export const canSaveNativeMobileModelPreferences = (): boolean => modelPreferencesOwner?.() === true;

export const initializeNativeMobileRuntime = async (
  initializeApp: () => Promise<void>,
  isActive: () => boolean = () => true,
): Promise<void> => {
  // An unpaired webview would otherwise send API paths to its static origin.
  if (!getRuntimeApiBaseUrl()) return;
  const isCurrent = captureRuntimeInstance();
  const isActiveInstance = () => isActive() && isCurrent();
  const settings = canSaveNativeMobileModelPreferences() ? Promise.resolve() : syncDesktopSettings({
    onApplied: () => {
      if (isActiveInstance()) modelPreferencesOwner = isCurrent;
    },
  });
  // Older servers can lack this route. Keep their normal connection flow.
  const mode = readPlatformIdentitySession(AbortSignal.timeout(NATIVE_BOOTSTRAP_READ_TIMEOUT_MS)).catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => { timeout = setTimeout(resolve, NATIVE_BOOTSTRAP_READ_TIMEOUT_MS); });
  await Promise.all([mode, Promise.race([settings, deadline])]).finally(() => clearTimeout(timeout));
  if (isActiveInstance()) await initializeApp();
};
