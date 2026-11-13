import React from 'react';
import { Button } from '@/components/ui/button';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { PlatformAccountGate } from '@/components/auth/PlatformAccountGate';
import { useI18n } from '@/lib/i18n';
import { MobileOfficialEntry } from './MobileOfficialEntry';

import { mobileOfficialMode, mobileOfficialProject } from './mobileOfficialRoute';

/** The read-only root has an isolated account namespace and no full mobile application. */
export const MobileApplicationBoundary: React.FC<React.PropsWithChildren<{ native: boolean; search: string }>> = ({ native, search, children }) => {
  const { t } = useI18n();
  if (!native && mobileOfficialMode(search)) {
    return <SessionAuthGate deferRuntimeBootstrap><MobileOfficialEntry requestedProject={mobileOfficialProject(search)} /></SessionAuthGate>;
  }
  const app = <PlatformAccountGate unsupported unsupportedActions={!native ? <Button variant="outline" asChild className="mt-5"><a href="?view=official">{t('mobile.official.readOnly')}</a></Button> : null}>{children}</PlatformAccountGate>;
  return native ? app : <SessionAuthGate deferRuntimeBootstrap>{app}</SessionAuthGate>;
};
