import React from 'react';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionTodosStore } from '@/stores/useSessionTodosStore';

/** Reads only while this session is mounted; failures keep the last supported list. */
export const useLoadSessionTodos = (sessionId: string | null, directory: string | null, visible: boolean): void => {
  const failures = useSessionTodosStore((state) => sessionId ? state.entries[sessionId]?.failures ?? 0 : 0);
  const epoch = useSessionTodosStore((state) => state.epoch);
  React.useEffect(() => {
    if (!visible || !sessionId || !directory || isVSCodeRuntime()) return;
    const runtimeKey = getRuntimeKey();
    return useSessionTodosStore.getState().watch(sessionId, directory, () => runtimeKey === getRuntimeKey());
  }, [directory, epoch, sessionId, visible]);
  React.useEffect(() => {
    if (!visible || !sessionId || !directory || failures === 0 || isVSCodeRuntime()) return;
    const runtimeKey = getRuntimeKey();
    const timer = window.setTimeout(() => {
      void useSessionTodosStore.getState().load(sessionId, directory, () => runtimeKey === getRuntimeKey()).catch(() => {});
    }, Math.min(30_000, 2000 * 2 ** (failures - 1)));
    return () => window.clearTimeout(timer);
  }, [directory, failures, sessionId, visible]);
};
