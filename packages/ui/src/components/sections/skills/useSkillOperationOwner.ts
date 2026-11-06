import React from 'react';
import { captureRuntimeInstance, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { resolveSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

const settingsDirectory = () => {
  const projects = useProjectsStore.getState();
  return resolveSettingsDirectory(useUIStore.getState().settingsProjectPath, projects.projects, projects.activeProjectId);
};

/** Skill actions belong to the rendered Settings visit, including before its next commit. */
export const useSkillOperationOwner = (followSelection = true) => {
  const generation = React.useRef(0);
  const mounted = React.useRef(false);
  const [visit, setVisit] = React.useState(0);
  React.useLayoutEffect(() => {
    mounted.current = true;
    setVisit(generation.current);
    const retire = () => { generation.current += 1; setVisit(generation.current); };
    let directory = settingsDirectory();
    const reconcileDirectory = () => {
      const next = settingsDirectory();
      if (next !== directory) { directory = next; retire(); }
    };
    const unsubscribeSkills = useSkillsStore.subscribe((state, previous) => {
      if (followSelection && (state.selectedSkillName !== previous.selectedSkillName || state.skillDraft !== previous.skillDraft)) retire();
    });
    const unsubscribeUI = useUIStore.subscribe(reconcileDirectory);
    const unsubscribeProjects = useProjectsStore.subscribe(reconcileDirectory);
    let ownsRuntime = captureRuntimeInstance();
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      if (!ownsRuntime()) { ownsRuntime = captureRuntimeInstance(); retire(); }
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribeSkills(); unsubscribeUI(); unsubscribeProjects(); unsubscribeRuntime();
    };
  }, [followSelection]);
  const captureOwner = React.useCallback(() => {
    const current = visit;
    const ownsRuntime = captureRuntimeInstance();
    return () => mounted.current && current === generation.current && ownsRuntime();
  }, [visit]);
  return { captureOwner, visit };
};
