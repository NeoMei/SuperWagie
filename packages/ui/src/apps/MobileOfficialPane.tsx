import React from 'react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { MobileOfficialView } from './MobileOfficialView';

export const MobileOfficialPane: React.FC<{ visible: boolean }> = ({ visible }) => {
  const directory = useEffectiveDirectory();
  const projectId = useProjectsStore((state) => state.projects.find((project) => project.path === directory)?.id ?? null);
  return <MobileOfficialView visible={visible} projectId={projectId} />;
};
