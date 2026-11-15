import { createContext } from 'react';
import type { ActivityGroups } from '../lib/turns/activityGroups';
import type { StreamPhase } from '../message/types';

export const ActivityGroupsContext = createContext<ActivityGroups | null>(null);

/** Live phase belongs to the source message, even when an earlier row owns its group. */
export const ActivityGroupStreamContext = createContext<{ messageId: string | null; phase: StreamPhase | null } | null>(null);
