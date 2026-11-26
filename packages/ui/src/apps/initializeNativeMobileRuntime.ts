import { readPlatformIdentitySession } from '@/lib/platformAccount';
import { captureRuntimeInstance, getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

const PLATFORM_MODE_TIMEOUT_MS = 2500;

export const initializeNativeMobileRuntime = async (
  initializeApp: () => Promise<void>,
  isActive: () => boolean = () => true,
): Promise<void> => {
  // An unpaired webview would otherwise send API paths to its static origin.
  if (!getRuntimeApiBaseUrl()) return;
  const isCurrent = captureRuntimeInstance();
  // Older servers can lack this route. Keep their normal connection flow.
  await readPlatformIdentitySession(AbortSignal.timeout(PLATFORM_MODE_TIMEOUT_MS)).catch(() => undefined);
  if (isActive() && isCurrent()) await initializeApp();
};
