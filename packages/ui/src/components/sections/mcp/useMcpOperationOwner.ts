import React from 'react';
import { resolveSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { captureRuntimeInstance, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

const getDirectory = () => {
  const projects = useProjectsStore.getState();
  return resolveSettingsDirectory(useUIStore.getState().settingsProjectPath, projects.projects, projects.activeProjectId);
};

/** Rendered MCP actions belong to a mounted selection and effective-directory visit. */
export const useMcpOperationOwner = () => {
  const generation = React.useRef(0);
  const scopeGeneration = React.useRef(0);
  const mounted = React.useRef(false);
  const [visit, setVisit] = React.useState(0);
  const scope = scopeGeneration.current;
  const ownsRuntime = React.useMemo(captureRuntimeInstance, [visit]);
  const initialRuntime = React.useRef(ownsRuntime);
  const observed = React.useRef({ directory: getDirectory(), selection: useMcpConfigStore.getState() });

  React.useLayoutEffect(() => {
    mounted.current = true;
    setVisit(generation.current);
    const retire = (scopeChanged: boolean) => {
      if (scopeChanged) scopeGeneration.current += 1;
      generation.current += 1;
      setVisit(generation.current);
    };
    const reconcile = () => {
      const directory = getDirectory();
      const selection = useMcpConfigStore.getState();
      const previous = observed.current;
      observed.current = { directory, selection };
      if (directory !== previous.directory) retire(true);
      else if (selection.selectedMcpName !== previous.selection.selectedMcpName || selection.mcpDraft !== previous.selection.mcpDraft) retire(false);
    };
    let currentRuntime = initialRuntime.current;
    const reconcileRuntime = () => {
      if (currentRuntime()) return;
      currentRuntime = captureRuntimeInstance();
      retire(true);
    };
    const unsubscribeConfig = useMcpConfigStore.subscribe(reconcile);
    const unsubscribeUI = useUIStore.subscribe(reconcile);
    const unsubscribeProjects = useProjectsStore.subscribe(reconcile);
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(reconcileRuntime);
    reconcile();
    reconcileRuntime();
    return () => {
      mounted.current = false;
      generation.current += 1;
      scopeGeneration.current += 1;
      unsubscribeConfig(); unsubscribeUI(); unsubscribeProjects(); unsubscribeRuntime();
    };
  }, []);

  const ownsVisit = React.useCallback(() => mounted.current && visit === generation.current && ownsRuntime(), [ownsRuntime, visit]);
  // DELETE's own selection clear retires the render, while its issued operation may finish.
  const ownsScope = React.useCallback(() => mounted.current && scope === scopeGeneration.current && ownsRuntime(), [ownsRuntime, scope]);
  return { visit, scope, ownsVisit, ownsScope };
};
