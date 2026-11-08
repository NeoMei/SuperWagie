import { z } from 'zod';
import { requestPlatformAccount } from './platformAccount';

const count = z.string().max(1024).regex(/^(0|[1-9]\d*)$/);
const timestamp = z.iso.datetime({ offset: true });
const activitySchema = z.object({
  visibility: z.enum(['actor', 'account']),
  from: timestamp, to: timestamp, asOf: timestamp,
  days: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), calls: count,
    coverage: z.enum(['unknown', 'partial', 'complete']).optional(),
  }).refine((day) => day.coverage !== 'unknown' || day.calls === '0')).length(365),
  total: count, complete: z.boolean(), unknownTime: count,
  savedAt: timestamp.nullable().optional(),
  sync: z.object({ status: z.enum(['synced', 'syncing', 'failed']), lastSuccessAt: timestamp.nullable() }).optional(),
}).refine((activity) => {
  const from = Date.parse(activity.from);
  const to = Date.parse(activity.to);
  return from < to && from % 86_400_000 === 0 && Math.floor(to / 86_400_000) === from / 86_400_000 + 364
    && activity.days.every((day, index) => day.date === new Date(from + index * 86_400_000).toISOString().slice(0, 10))
    && activity.days.reduce((total, day) => total + BigInt(day.calls), 0n) === BigInt(activity.total);
}).refine((activity) => {
  const localSnapshot = activity.savedAt !== undefined || activity.sync !== undefined || activity.days.some((day) => day.coverage !== undefined);
  return !localSnapshot || (activity.savedAt !== undefined && activity.sync !== undefined
    && activity.days.every((day) => day.coverage !== undefined)
    && activity.complete === activity.days.every((day) => day.coverage === 'complete'));
}).transform((activity) => ({
  ...activity,
  days: activity.days.map((day) => ({ ...day, coverage: day.coverage ?? (activity.complete ? 'complete' : day.calls === '0' ? 'unknown' : 'partial') })),
  savedAt: activity.savedAt ?? null,
  // A published v2.7.75 server has no local snapshot or synchronization metadata.
  sync: activity.sync ?? null,
}));

export type PlatformUsageActivity = z.infer<typeof activitySchema>;

export const readPlatformUsageActivity = (accountId: string) => requestPlatformAccount(
  `/api/platform-account/usage/${encodeURIComponent(accountId)}/activity`, activitySchema,
);
