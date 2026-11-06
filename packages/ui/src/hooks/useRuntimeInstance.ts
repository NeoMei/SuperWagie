import React from 'react';
import { captureRuntimeInstance, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

/** Re-renders on instance changes, including a batched A-to-B-to-A switch. */
export const useRuntimeInstance = (): (() => boolean) => {
  const [isCurrent, setIsCurrent] = React.useState(captureRuntimeInstance);
  React.useEffect(() => {
    const reconcile = () => setIsCurrent((previous) => previous() ? previous : captureRuntimeInstance());
    const unsubscribe = subscribeRuntimeEndpointChanged(reconcile);
    reconcile();
    return unsubscribe;
  }, []);
  return isCurrent;
};
