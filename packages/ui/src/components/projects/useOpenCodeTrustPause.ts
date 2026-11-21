import React from 'react';
import { folderTrust, reviewOpenCodeFolder } from '@/lib/opencodeTrust';
import { useConfigStore } from '@/stores/useConfigStore';
import { useChildStoreManager } from '@/sync/sync-context';

export const useOpenCodeTrustPausedDirectory = (directories: readonly (string | null | undefined)[]): string | null => React.useSyncExternalStore(
  folderTrust.subscribe,
  () => directories.find((directory) => folderTrust.isPaused(directory)) ?? null,
  () => null,
);

export const useReviewOpenCodeFolder = () => {
  const childStores = useChildStoreManager();
  return React.useCallback(async (directory: string) => {
    if (!await reviewOpenCodeFolder(directory)) return;
    childStores.requestBootstrap({ directory, priority: 'selected', reason: 'action-demand', force: true });
    const config = useConfigStore.getState();
    void config.loadAgents({ directory, source: 'folderTrust', fresh: true });
    void config.loadProviders({ directory, source: 'folderTrust', fresh: true });
  }, [childStores]);
};
