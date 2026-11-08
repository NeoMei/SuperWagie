import { z } from 'zod';
import { requestPlatformAccount } from './platformAccount';

const count = z.string().max(1024).regex(/^(0|[1-9]\d*)$/);
const activitySchema = z.object({
  visibility: z.enum(['actor', 'account']),
  from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), asOf: z.iso.datetime({ offset: true }),
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), calls: count })).length(365),
  total: count, complete: z.boolean(), unknownTime: count,
}).refine((activity) => {
  const from = Date.parse(activity.from);
  const to = Date.parse(activity.to);
  return from < to && from % 86_400_000 === 0 && Math.floor(to / 86_400_000) === from / 86_400_000 + 364
    && activity.days.every((day, index) => day.date === new Date(from + index * 86_400_000).toISOString().slice(0, 10))
    && activity.days.reduce((total, day) => total + BigInt(day.calls), 0n) === BigInt(activity.total);
});

export type PlatformUsageActivity = z.infer<typeof activitySchema>;

export const readPlatformUsageActivity = (accountId: string) => requestPlatformAccount(
  `/api/platform-account/usage/${encodeURIComponent(accountId)}/activity`, activitySchema,
);
