import React from 'react';
import { resolveSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { captureRuntimeInstance, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

const getDirectory = () => {
  const projects = useProjectsStore.getState();
  return resolveSettingsDirectory(useUIStore.getState().settingsProjectPath, projects.projects, projects.activeProjectId);
};

/** Custom-provider fields and mutations belong to one mounted editor visit. */
export const useCustomProviderOperationOwner = () => {
  const generation = React.useRef(0);
  const scopeGeneration = React.useRef(0);
  const mounted = React.useRef(false);
  const [visit, setVisit] = React.useState(0);
  const scope = scopeGeneration.current;
  const ownsRuntime = React.useMemo(captureRuntimeInstance, [scope]);
  const initialRuntime = React.useRef(ownsRuntime);
  const observedDirectory = React.useRef(getDirectory());
  const retireEditor = React.useCallback(() => {
    generation.current += 1;
    setVisit(generation.current);
  }, []);

  React.useLayoutEffect(() => {
    mounted.current = true;
    setVisit(generation.current);
    const reconcileDirectory = () => {
      const directory = getDirectory();
      if (directory === observedDirectory.current) return;
      observedDirectory.current = directory;
      scopeGeneration.current += 1;
      retireEditor();
    };
    let currentRuntime = initialRuntime.current;
    const reconcileRuntime = () => {
      if (currentRuntime()) return;
      currentRuntime = captureRuntimeInstance();
      scopeGeneration.current += 1;
      retireEditor();
    };
    const unsubscribeUI = useUIStore.subscribe(reconcileDirectory);
    const unsubscribeProjects = useProjectsStore.subscribe(reconcileDirectory);
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(reconcileRuntime);
    reconcileDirectory();
    reconcileRuntime();
    return () => {
      mounted.current = false;
      generation.current += 1;
      scopeGeneration.current += 1;
      unsubscribeUI(); unsubscribeProjects(); unsubscribeRuntime();
    };
  }, [retireEditor]);

  const ownsVisit = React.useCallback(() => mounted.current && visit === generation.current && ownsRuntime(), [ownsRuntime, visit]);
  const ownsScope = React.useCallback(() => mounted.current && scope === scopeGeneration.current && ownsRuntime(), [ownsRuntime, scope]);
  return { visit, scope, ownsVisit, ownsScope, retireEditor };
};
