import { z } from 'zod';

const integer = z.string().max(1024).regex(/^(0|[1-9]\d*)$/);
const scopeSchema = z.object({
  account_id: z.string(), origin_product_id: z.literal('superwagie'),
  instance_id: z.string().min(1), visibility: z.enum(['actor', 'account']), actor_id: z.string().optional(), source: z.string().optional(),
});
const pageSchema = z.object({
  scope: scopeSchema, financial_details: z.boolean(), total: integer, unknown_time: integer,
  has_more: z.boolean(), next_cursor: z.string().min(1).max(4096).optional(),
  items: z.array(z.object({
    call_id: z.string().min(1), account_id: z.string(), actor_id: z.string(),
    origin_product_id: z.literal('superwagie'), instance_id: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
  })).max(100),
});
const DAY_MS = 86_400_000;
const MAX_PAGES = 50;

export class PlatformUsageActivityError extends Error {}

/** Read every page in a fixed UTC calendar window, with a bounded live traversal. */
export const readPlatformUsageActivity = async ({ request, accountId, actorId, now }) => {
  const to = new Date(now);
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - 364 * DAY_MS);
  const days = Array.from({ length: 365 }, (_, index) => ({ date: new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10), calls: 0n }));
  // UniHub accepts at most 90 days per report. Read the newest window first so
  // a bounded partial result still includes the most recent activity.
  const windows = [];
  for (let start = from.getTime(); start < to.getTime(); start += 90 * DAY_MS) windows.unshift({ from: start, to: Math.min(start + 90 * DAY_MS, to.getTime()) });
  const byDate = new Map(days.map((day) => [day.date, day]));
  const seenCalls = new Set();
  const seenCursors = new Set();
  let binding;
  let visibility = 'actor';
  let unknownTime = 0n;
  let pageCount = 0;
  let complete = true;
  for (const window of windows) {
    if (pageCount >= MAX_PAGES) { complete = false; break; }
    let cursor;
    let initialTotal;
    let latestTotal = '0';
    let stableTotal = true;
    let exhausted = false;
    const initialSize = seenCalls.size;
    while (pageCount < MAX_PAGES) {
      pageCount += 1;
      const query = new URLSearchParams({ limit: '100', from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() });
      if (cursor) query.set('cursor', cursor);
      const parsed = pageSchema.safeParse(await request(`/v1/accounts/${encodeURIComponent(accountId)}/calls?${query}`));
      if (!parsed.success) throw new PlatformUsageActivityError('Invalid activity response');
      const page = parsed.data;
      const scope = page.scope;
      if (scope.account_id !== accountId || (scope.visibility === 'actor' && scope.actor_id !== actorId)) throw new PlatformUsageActivityError('Activity scope changed');
      const nextBinding = JSON.stringify([scope.account_id, scope.origin_product_id, scope.instance_id, scope.visibility, scope.actor_id, scope.source, page.financial_details]);
      if (binding !== undefined && binding !== nextBinding) throw new PlatformUsageActivityError('Activity scope changed');
      binding = nextBinding;
      visibility = scope.visibility;
      initialTotal ??= page.total;
      latestTotal = page.total;
      stableTotal &&= initialTotal === latestTotal;
      if (BigInt(page.unknown_time) > unknownTime) unknownTime = BigInt(page.unknown_time);
      for (const call of page.items) {
        const time = Date.parse(call.created_at);
        if (call.account_id !== accountId || call.instance_id !== scope.instance_id
          || (scope.visibility === 'actor' && call.actor_id !== actorId)
          || time < window.from || time >= window.to || seenCalls.has(call.call_id)) throw new PlatformUsageActivityError('Invalid activity record');
        const day = byDate.get(new Date(time).toISOString().slice(0, 10));
        if (!day) throw new PlatformUsageActivityError('Invalid activity date');
        seenCalls.add(call.call_id);
        day.calls += 1n;
      }
      if (!page.has_more) { exhausted = true; break; }
      if (!page.next_cursor || page.items.length === 0 || seenCursors.has(page.next_cursor)) throw new PlatformUsageActivityError('Invalid activity cursor');
      cursor = page.next_cursor;
      seenCursors.add(cursor);
    }
    // Each window has its own live total and pagination position. A limit or
    // changing total cannot turn unread calendar dates into authoritative zero.
    complete &&= exhausted && stableTotal && BigInt(seenCalls.size - initialSize) === BigInt(latestTotal);
  }
  return {
    visibility, from: from.toISOString(), to: to.toISOString(), asOf: to.toISOString(),
    days: days.map((day) => ({ date: day.date, calls: day.calls.toString() })),
    total: BigInt(seenCalls.size).toString(), complete, unknownTime: unknownTime.toString(),
  };
};
