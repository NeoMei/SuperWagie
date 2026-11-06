import React from 'react';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { capturePluginsOwner, getPluginsConfigDirectory, usePluginsStore } from '@/stores/usePluginsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

const selectedTarget = (state: ReturnType<typeof usePluginsStore.getState>) => {
  const entry = state.entries.find((item) => item.id === state.selectedId);
  if (entry) return JSON.stringify([entry.id, entry.kind, entry.scope, entry.sourcePath]);
  const file = state.files.find((item) => item.id === state.selectedId);
  return file ? JSON.stringify([file.id, file.kind, file.scope, file.fileName, file.absolutePath]) : null;
};

/** Rendered plugin actions retain their mounted directory, selection and target visit. */
export const usePluginOperationOwner = (identity = '') => {
  const generation = React.useRef(0);
  const scopeGeneration = React.useRef(0);
  const mounted = React.useRef(false);
  const [visit, setVisit] = React.useState(0);
  const scope = scopeGeneration.current;
  const ownsConfig = React.useMemo(capturePluginsOwner, [visit, identity]);
  const renderedIdentity = React.useRef({ identity, visit: 0 });
  if (renderedIdentity.current.identity !== identity) {
    renderedIdentity.current = { identity, visit: renderedIdentity.current.visit + 1 };
  }
  const targetVisit = renderedIdentity.current.visit;
  const observed = React.useRef({ directory: getPluginsConfigDirectory(), state: usePluginsStore.getState() });

  React.useLayoutEffect(() => {
    mounted.current = true;
    const retire = (scopeChanged: boolean) => {
      if (scopeChanged) scopeGeneration.current += 1;
      generation.current += 1;
      setVisit(generation.current);
    };
    const reconcile = () => {
      const directory = getPluginsConfigDirectory();
      const state = usePluginsStore.getState();
      const previous = observed.current;
      observed.current = { directory, state };
      if (directory !== previous.directory) retire(true);
      else if (state.selectedId !== previous.state.selectedId) retire(false);
      else if (state.loadedDirectory === directory && state.loadedRuntimeKey === getRuntimeKey()
        && (state.loadedOwner?.() ?? true) && selectedTarget(state) !== selectedTarget(previous.state)) retire(false);
    };
    let runtime = captureRuntimeInstance();
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      if (runtime()) return;
      runtime = captureRuntimeInstance();
      retire(true);
    });
    const unsubscribePlugins = usePluginsStore.subscribe(reconcile);
    const unsubscribeProjects = useProjectsStore.subscribe(reconcile);
    reconcile();
    return () => {
      mounted.current = false;
      generation.current += 1;
      scopeGeneration.current += 1;
      unsubscribeRuntime(); unsubscribePlugins(); unsubscribeProjects();
    };
  }, []);

  const ownsVisit = React.useCallback(() => mounted.current && visit === generation.current
    && renderedIdentity.current.visit === targetVisit && ownsConfig(), [ownsConfig, targetVisit, visit]);
  // DELETE may finish after its catalog removes the record and clears selection.
  const ownsScope = React.useCallback(() => mounted.current && scope === scopeGeneration.current
    && renderedIdentity.current.visit === targetVisit && ownsConfig(), [ownsConfig, scope, targetVisit]);
  return { visit, scope, ownsVisit, ownsScope };
};
