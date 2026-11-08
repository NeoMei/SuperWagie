import { z } from 'zod';
import { openUsageActivityJournal } from './usage-activity-journal.js';

const DAY_MS = 86_400_000;
const integer = z.string().max(1024).regex(/^(0|[1-9]\d*)$/);
const timestamp = z.iso.datetime({ offset: true });
const ownerSchema = z.object({ issuer: z.string().min(1), api: z.string().min(1), clientId: z.string().min(1), userId: z.string().min(1), accountId: z.string().min(1) }).strict();
const pageSchema = z.object({
  scope: z.object({ account_id: z.string(), origin_product_id: z.literal('superwagie'), instance_id: z.string().min(1), visibility: z.enum(['actor', 'account']), actor_id: z.string().optional(), source: z.string().optional() }),
  filter: z.object({ from: timestamp, to: timestamp, instance_id: z.string(), origin_product_id: z.literal('superwagie'), source: z.string().optional(), model: z.string().optional(), asset: z.string().optional() }),
  financial_details: z.boolean(), total: integer, unknown_time: integer, as_of: timestamp,
  accuracy: z.literal('exact_for_query_snapshot'), consistency: z.literal('live'),
});

export class PlatformUsageActivityError extends Error {
  constructor(message, code = 'platform_response_invalid', status = 502) { super(message); this.code = code; this.status = status; }
}
const dayStart = (time) => Math.floor(time / DAY_MS) * DAY_MS;
const dateAt = (time) => new Date(time).toISOString().slice(0, 10);
const inactive = () => new PlatformUsageActivityError('Activity session is no longer active', 'platform_session_changed', 409);
const matchesMillisecond = (value, expected) => Date.parse(value) === expected && !/[1-9]/.test((/\.(\d+)/.exec(value)?.[1] ?? '').slice(3));

/** The report total is exact for its transaction even when only one row is returned. */
export const readPlatformUsageActivityDay = async ({ request, ownerBase, date, now, assertCurrent, signal }) => {
  const owner = ownerSchema.parse(ownerBase);
  const from = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(from) || dateAt(from) !== date || from > now) throw new PlatformUsageActivityError('Invalid activity date');
  const to = Math.min(from + DAY_MS, Math.max(now, from + 1));
  const query = new URLSearchParams({ limit: '1', from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  assertCurrent();
  signal?.throwIfAborted();
  const raw = await request(`/v1/accounts/${encodeURIComponent(owner.accountId)}/calls?${query}`, { signal });
  assertCurrent();
  signal?.throwIfAborted();
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) throw new PlatformUsageActivityError('Invalid daily activity response');
  const page = parsed.data;
  const scope = page.scope;
  if (scope.account_id !== owner.accountId || (scope.visibility === 'actor' ? scope.actor_id !== owner.userId || page.financial_details : Boolean(scope.actor_id))
    || page.filter.instance_id !== scope.instance_id || (page.filter.source ?? '') !== (scope.source ?? '')
    || page.filter.model || page.filter.asset || !matchesMillisecond(page.filter.from, from) || !matchesMillisecond(page.filter.to, to)
    || Date.parse(page.as_of) < from) throw new PlatformUsageActivityError('Daily activity scope or filter changed');
  return {
    scope: { ...owner, originProductId: 'superwagie', instanceId: scope.instance_id, visibility: scope.visibility, actorId: scope.actor_id || null, source: scope.source || null, financialDetails: page.financial_details },
    date, calls: page.total, unknownTime: page.unknown_time,
    coveredUntil: Date.parse(page.as_of) < to ? page.as_of : new Date(to).toISOString(), observedAt: page.as_of,
  };
};

/** Owns background collection; opening the chart only authorizes its saved snapshot. */
export const createUsageActivityRuntime = async ({ dataDir, now = Date.now, intervalMs = 60_000, backfillDelayMs = 500 } = {}) => {
  if (!Number.isFinite(intervalMs) || intervalMs < 1 || !Number.isFinite(backfillDelayMs) || backfillDelayMs < 1) throw new TypeError('Activity intervals must be positive');
  const journal = await openUsageActivityJournal({ dataDir });
  const entries = new Map();
  const jobs = new Set();
  let closed = false;
  let closePromise;
  const assertActive = (entry) => {
    if (closed || entries.get(entry.key) !== entry || entry.controller.signal.aborted) throw inactive();
    entry.assertCurrent();
  };
  const stop = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    entry.scope = null;
    clearTimeout(entry.backfillTimer);
    entry.controller.abort(inactive());
  };
  const failed = (entry, error) => {
    if (closed || entries.get(entry.key) !== entry) return;
    entry.syncStatus = 'failed';
    if (error?.status === 401 || error?.code === 'platform_session_changed' || error?.code === 'platform_session_expired') { stop(entry.key); return; }
    try { entry.assertCurrent(); } catch { stop(entry.key); return; }
    if (error?.status === 403) {
      entry.scope = null;
      entry.scopeId = null;
      entry.today = null;
      clearTimeout(entry.backfillTimer);
      entry.backfillTimer = null;
      entry.backfillAttempted.clear();
    }
  };
  const enqueue = (entry, operation) => {
    const job = entry.tail.then(() => { assertActive(entry); return operation(); });
    entry.tail = job.catch(() => {});
    jobs.add(job);
    void job.then(() => jobs.delete(job), (error) => { jobs.delete(job); failed(entry, error); });
    return job;
  };
  const collectDay = async (entry, date, bindScope) => {
    const priorScopeId = entry.scopeId;
    const prior = entry.scope ? await journal.readDays(entry.scope, date, dateAt(Date.parse(`${date}T00:00:00Z`) + DAY_MS)) : [];
    assertActive(entry);
    const value = await readPlatformUsageActivityDay({ ownerBase: entry.ownerBase, request: entry.request, date, now: now(), assertCurrent: () => assertActive(entry), signal: entry.controller.signal });
    assertActive(entry);
    const scopeId = JSON.stringify(value.scope);
    if (!entry.scope || entry.scopeId !== scopeId) {
      entry.scope = null;
      if (!bindScope) throw new PlatformUsageActivityError('Activity permissions changed', 'platform_activity_scope_changed', 409);
      entry.scope = value.scope;
      entry.scopeId = scopeId;
      entry.backfillAttempted.clear();
    }
    assertActive(entry);
    await journal.writeDay(entry.scope, { date: value.date, calls: value.calls, coveredUntil: value.coveredUntil, observedAt: value.observedAt, unknownTime: value.unknownTime, expectedRevision: scopeId === priorScopeId ? prior[0]?.revision ?? 0 : 0 });
    assertActive(entry);
    entry.lastSuccessAt = (await journal.readState(entry.scope)).observedAt;
    if (bindScope) entry.today = value;
    return value;
  };
  const today = (entry) => {
    if (entry.todayPromise) return entry.todayPromise;
    const pending = enqueue(entry, () => collectDay(entry, dateAt(now()), true));
    entry.todayPromise = pending;
    void pending.then(() => { if (entry.todayPromise === pending) entry.todayPromise = null; }, () => { if (entry.todayPromise === pending) entry.todayPromise = null; });
    return pending;
  };
  const calendar = (at = now()) => {
    const start = dayStart(at) - 364 * DAY_MS;
    return Array.from({ length: 365 }, (_, index) => dateAt(start + index * DAY_MS));
  };
  const pendingDates = async (entry) => {
    assertActive(entry);
    if (!entry.scope) return [];
    const dates = calendar();
    const saved = await journal.readDays(entry.scope, dates[0], dateAt(dayStart(now()) + DAY_MS));
    assertActive(entry);
    const byDate = new Map(saved.map(day => [day.date, day]));
    return dates.slice(0, -1).reverse().filter(date => {
      const day = byDate.get(date);
      return !day || day.needsReview || Date.parse(day.coveredUntil) < Date.parse(`${date}T00:00:00Z`) + DAY_MS;
    });
  };
  const scheduleBackfill = async (entry) => {
    assertActive(entry);
    const pending = await pendingDates(entry);
    assertActive(entry);
    const dates = pending.filter(date => !entry.backfillAttempted.has(date));
    entry.syncStatus = pending.length ? 'syncing' : 'synced';
    if (!dates.length || entry.backfillTimer) return;
    entry.backfillTimer = setTimeout(() => {
      entry.backfillTimer = null;
      void enqueue(entry, async () => {
        const date = dates[0];
        entry.backfillAttempted.add(date);
        await collectDay(entry, date, false);
        await scheduleBackfill(entry);
      }).catch(() => {});
    }, backfillDelayMs);
    entry.backfillTimer.unref?.();
  };
  const sync = (entry) => {
    if (closed || entries.get(entry.key) !== entry || entry.backgroundPending) return;
    entry.backgroundPending = true;
    entry.syncStatus = 'syncing';
    entry.backfillAttempted.clear();
    void today(entry).then(() => enqueue(entry, async () => {
      await collectDay(entry, dateAt(dayStart(now()) - DAY_MS), false);
      await scheduleBackfill(entry);
    })).catch(error => failed(entry, error)).finally(() => { entry.backgroundPending = false; });
  };
  const timer = setInterval(() => { for (const entry of entries.values()) sync(entry); }, intervalMs);
  timer.unref?.();
  return {
    track: (key, options) => {
      if (closed) return;
      const ownerBase = ownerSchema.parse(options.ownerBase);
      const previous = entries.get(key);
      if (previous && JSON.stringify(previous.ownerBase) === JSON.stringify(ownerBase)) {
        try {
          previous.assertCurrent(); options.assertCurrent();
          previous.request = options.request;
          previous.assertCurrent = options.assertCurrent;
          return;
        } catch { stop(key); }
      } else if (previous) stop(key);
      const entry = { key, ownerBase, request: options.request, assertCurrent: options.assertCurrent, controller: new AbortController(), tail: Promise.resolve(), scope: null, scopeId: null, today: null, todayPromise: null, backfillTimer: null, backfillAttempted: new Set(), backgroundPending: false, syncStatus: 'syncing', lastSuccessAt: null };
      entries.set(key, entry);
      sync(entry);
    },
    stop,
    wake: () => { for (const entry of entries.values()) sync(entry); },
    read: async (key) => {
      const entry = entries.get(key);
      if (!entry || closed) throw inactive();
      await today(entry);
      return enqueue(entry, async () => {
        await scheduleBackfill(entry);
        const dates = calendar(Date.parse(`${entry.today.date}T00:00:00Z`));
        const records = await journal.readDays(entry.scope, dates[0], dateAt(Date.parse(`${entry.today.date}T00:00:00Z`) + DAY_MS));
        const state = await journal.readState(entry.scope);
        assertActive(entry);
        const byDate = new Map(records.map(day => [day.date, day]));
        let total = 0n;
        const days = dates.map((date) => {
          const day = byDate.get(date);
          if (!day) return { date, calls: '0', coverage: 'unknown' };
          total += BigInt(day.calls);
          const requiredUntil = date === dates.at(-1) ? Date.parse(entry.today.coveredUntil) : Date.parse(`${date}T00:00:00Z`) + DAY_MS;
          return { date, calls: day.calls, coverage: !day.needsReview && Date.parse(day.coveredUntil) >= requiredUntil ? 'complete' : 'partial' };
        });
        return { visibility: entry.scope.visibility, from: `${dates[0]}T00:00:00.000Z`, to: entry.today.coveredUntil, asOf: entry.today.observedAt, days, total: total.toString(), complete: days.every(day => day.coverage === 'complete'), unknownTime: state.unknownTime ?? '0', savedAt: state.observedAt, sync: { status: entry.syncStatus, lastSuccessAt: entry.lastSuccessAt } };
      });
    },
    close: () => {
      closePromise ??= (async () => {
        closed = true;
        clearInterval(timer);
        for (const key of [...entries.keys()]) stop(key);
        await Promise.allSettled([...jobs]);
        await journal.close();
      })();
      return closePromise;
    },
  };
};
