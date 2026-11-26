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
  if (native) return <>{children}</>;
  const legacyView = mobileOfficialMode(search)
    ? <MobileOfficialEntry requestedProject={mobileOfficialProject(search)} />
    : <PlatformAccountGate unsupported unsupportedActions={<Button variant="outline" asChild className="mt-5"><a href="?view=official">{t('mobile.official.readOnly')}</a></Button>} />;
  return (
    <SessionAuthGate deferRuntimeBootstrap>
      <PlatformAccountGate legacyView={legacyView}>{children}</PlatformAccountGate>
    </SessionAuthGate>
  );
};
