import React from 'react';
import { captureRuntimeInstance, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { resolveSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

const getSettingsDirectory = () => {
  const projects = useProjectsStore.getState();
  return resolveSettingsDirectory(useUIStore.getState().settingsProjectPath, projects.projects, projects.activeProjectId);
};

/** Async agent work belongs to one mounted selection and Settings-directory visit. */
export const useAgentOperationOwner = () => {
  const generation = React.useRef(0);
  const mounted = React.useRef(false);
  const [visit, setVisit] = React.useState(0);
  React.useLayoutEffect(() => {
    mounted.current = true;
    setVisit(generation.current);
    let directory = getSettingsDirectory();
    const retire = () => {
      generation.current += 1;
      setVisit(generation.current);
    };
    const reconcileDirectory = () => {
      const next = getSettingsDirectory();
      if (next === directory) return;
      directory = next;
      retire();
    };
    const unsubscribeAgents = useAgentsStore.subscribe((state, previous) => {
      if (state.selectedAgentName !== previous.selectedAgentName || state.agentDraft !== previous.agentDraft) retire();
    });
    const unsubscribeUI = useUIStore.subscribe(reconcileDirectory);
    const unsubscribeProjects = useProjectsStore.subscribe(reconcileDirectory);
    let ownsRuntime = captureRuntimeInstance();
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      // Same-instance transport/auth refresh does not retire configuration work.
      if (!ownsRuntime()) { ownsRuntime = captureRuntimeInstance(); retire(); }
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribeAgents(); unsubscribeUI(); unsubscribeProjects(); unsubscribeRuntime();
    };
  }, []);
  const captureOwner = React.useCallback(() => {
    const current = visit;
    const ownsRuntime = captureRuntimeInstance();
    return () => mounted.current && current === generation.current && ownsRuntime();
  }, [visit]);
  return { captureOwner, visit };
};
