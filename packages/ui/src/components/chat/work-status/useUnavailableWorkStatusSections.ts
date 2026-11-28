import React from 'react';
import { useSessionTodosStore } from '@/stores/useSessionTodosStore';
import { isWorkflowEnabled } from '@/lib/workflows/availability';
import { useUIStore } from '@/stores/useUIStore';
import type { WorkStatusSectionId } from './sections';

/**
 * Built-in sections of features this build may not have. A section of a
 * feature the build lacks is listed nowhere, the sections dialog included, so
 * an unreleased feature does not show up by name.
 *
 * The phone's Status tab also leaves out Usage: the phone has its own Usage
 * page, which reads better there than the panel's compact rows.
 */
export const useUnavailableWorkStatusSections = (sessionId: string | null, directory: string | null): readonly WorkStatusSectionId[] => {
  const workflows = useUIStore(isWorkflowEnabled);
  const isMobile = useUIStore((state) => state.isMobile);
  const tasks = useSessionTodosStore((state) => {
    const entry = sessionId ? state.entries[sessionId] : undefined;
    return entry && entry.directory === directory ? entry.state : undefined;
  });
  return React.useMemo(() => [
    ...(isMobile ? ['usage' as const] : []),
    ...(workflows ? [] : ['workflows' as const]),
    ...(tasks === 'off' || tasks === 'unsupported' || tasks === undefined ? ['tasks' as const] : []),
  ], [isMobile, tasks, workflows]);
};
