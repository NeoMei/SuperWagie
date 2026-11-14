import React, { lazy, Suspense } from 'react';
import type { RuntimeAPIs } from '@/lib/api/types';
const MobileApp = lazy(() => import('./MobileApp').then((module) => ({ default: module.MobileApp })));

export const MobileBusinessApplication: React.FC<{ apis: RuntimeAPIs }> = ({ apis }) => <Suspense><MobileApp apis={apis} /></Suspense>;
