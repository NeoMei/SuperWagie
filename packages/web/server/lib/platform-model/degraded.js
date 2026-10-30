import { createProductPlatformModelRuntime, PlatformModelError } from './runtime.js';
import { PlatformStoreLockError } from './store.js';

// Not wired to server startup: session dispatchers and background workers also
// write directly to OpenCode and must be fenced before this can be enabled.
export const createUnavailablePlatformModelRuntime = (reason) => {
  if (!['platform_store_busy', 'platform_store_lock_unavailable'].includes(reason)) throw new TypeError('invalid platform lock failure');
  const unavailable = () => { throw new PlatformModelError(reason, 503); };
  const unavailableAsync = async () => unavailable();
  return {
    unavailableReason: () => reason,
    enabled: () => false,
    providerConfig: () => ({}),
    createChildEnv: () => ({}),
    authorizeSession: unavailable,
    status: unavailable,
    defaultMediaModel: unavailable,
    admit: unavailableAsync,
    reconcile: unavailableAsync,
    mediaCredential: unavailableAsync,
    mediaCall: unavailableAsync,
    mediaDispatch: unavailableAsync,
    admitMediaTask: unavailableAsync,
    materializePlugin: unavailableAsync,
    close: async () => {},
  };
};

export const createResilientPlatformModelRuntime = async (options) => {
  try { return await createProductPlatformModelRuntime(options); }
  catch (error) {
    if (!(error instanceof PlatformStoreLockError)) throw error;
    return createUnavailablePlatformModelRuntime(error.code);
  }
};
