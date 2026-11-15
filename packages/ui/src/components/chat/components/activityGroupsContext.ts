import { createContext } from 'react';
import type { ActivityGroups } from '../lib/turns/activityGroups';

export const ActivityGroupsContext = createContext<ActivityGroups | null>(null);
