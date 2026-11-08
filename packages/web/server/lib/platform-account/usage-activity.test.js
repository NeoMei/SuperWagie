import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import * as activity from './usage-activity.js';

const INITIAL_NOW = Date.parse('2026-11-08T12:00:00Z');
const ownerBase = { issuer: 'https://identity.test', api: 'https://hub.test/', clientId: 'superwagie', userId: 'alice', accountId: 'personal-a' };
const scope = { account_id: 'personal-a', origin_product_id: 'superwagie', instance_id: 'instance-a', visibility: 'account' };
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

const response = (requestPath, clock, values = {}) => {
  const query = new URL(requestPath, 'https://fixture.test').searchParams;
  return { scope, filter: { instance_id: scope.instance_id, origin_product_id: 'superwagie', from: query.get('from'), to: query.get('to') }, financial_details: true, total: '0', unknown_time: '0', as_of: new Date(clock.value).toISOString(), accuracy: 'exact_for_query_snapshot', consistency: 'live', items: [], has_more: false, ...values };
};
const setup = async ({ directory, total = '8425', backfillDelayMs = 10000, intervalMs = 60000 } = {}) => {
  const dataDir = directory ?? await mkdtemp(path.join(os.tmpdir(), 'usage-daily-'));
  if (!directory) cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const clock = { value: INITIAL_NOW };
  const state = { total, error: null, scope, financial: true, valid: true };
  const requests = [];
  const request = async (requestPath) => {
    requests.push(requestPath);
    if (state.error) throw state.error;
    const day = new URL(requestPath, 'https://fixture.test').searchParams.get('from').slice(0, 10);
    return response(requestPath, clock, { scope: state.scope, financial_details: state.financial, total: day === '2026-11-08' ? state.total : '0', unknown_time: '9007199254740993' });
  };
  const runtime = await activity.createUsageActivityRuntime({ dataDir, now: () => clock.value, intervalMs, backfillDelayMs });
  cleanups.push(() => runtime.close());
  const options = { ownerBase, request, assertCurrent: () => { if (!state.valid) throw Object.assign(new Error('session changed'), { code: 'platform_session_changed', status: 409 }); } };
  return { runtime, options, dataDir, clock, state, requests };
};

test('single-day exact totals do not enumerate pages or cap a busy day at 5000 calls', async () => {
  const clock = { value: INITIAL_NOW };
  const requests = [];
  const value = await activity.readPlatformUsageActivityDay({ ownerBase, date: '2026-11-08', now: clock.value, assertCurrent() {}, request: async (requestPath) => {
    requests.push(requestPath);
    return response(requestPath, clock, { total: '9007199254740993', has_more: true, next_cursor: 'unused', items: [{}] });
  } });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0], 'https://fixture.test').searchParams.get('limit'), '1');
  assert.equal(value.calls, '9007199254740993');
  assert.equal(value.coveredUntil, new Date(INITIAL_NOW).toISOString());
});

test('daily reader rejects unbound scopes, filters, inexact totals and stale identity', async () => {
  const clock = { value: INITIAL_NOW };
  for (const change of [
    { scope: { ...scope, account_id: 'other' } },
    { scope: { ...scope, visibility: 'actor', actor_id: 'mallory' } },
    { accuracy: 'estimated' }, { consistency: 'cached' }, { total: '01' },
    { filter: { from: '2026-11-07T00:00:00Z', to: '2026-11-08T12:00:00Z', instance_id: 'instance-a', origin_product_id: 'superwagie' } },
  ]) await assert.rejects(activity.readPlatformUsageActivityDay({ ownerBase, date: '2026-11-08', now: clock.value, assertCurrent() {}, request: async requestPath => response(requestPath, clock, change) }), activity.PlatformUsageActivityError);
  let current = true;
  await assert.rejects(activity.readPlatformUsageActivityDay({ ownerBase, date: '2026-11-08', now: clock.value, assertCurrent() { assert.equal(current, true); }, request: async requestPath => { current = false; return response(requestPath, clock); } }));
});

test('tracking collects without opening the chart and repeated wakeups replace the same daily total', async () => {
  vi.useFakeTimers();
  const f = await setup({ total: '6001' });
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  assert.ok(f.requests.length > 0, 'normal authenticated usage must collect before any chart read');
  f.runtime.wake(); f.runtime.wake(); f.runtime.wake();
  await vi.advanceTimersByTimeAsync(1);
  const before = f.requests.length;
  const value = await f.runtime.read('identity');
  assert.equal(f.requests.length, before + 1, 'opening the chart authorizes today once and never scans the year');
  assert.equal(value.days.length, 365);
  assert.deepEqual(value.days.at(-1), { date: '2026-11-08', calls: '6001', coverage: 'complete' });
  assert.equal(value.days[0].coverage, 'unknown');
  assert.equal(value.total, '6001');
  assert.equal(value.unknownTime, '9007199254740993');
  assert.ok(value.savedAt);
});

test('daily snapshots survive restart and continue beyond 5000 without duplicated counts', async () => {
  vi.useFakeTimers();
  const first = await setup({ total: '6001' });
  first.runtime.track('first-process', first.options);
  await vi.advanceTimersByTimeAsync(1);
  await first.runtime.close();
  const restarted = await setup({ directory: first.dataDir, total: '6005' });
  restarted.clock.value += 1000;
  restarted.runtime.track('fresh-runtime-identity', restarted.options);
  await vi.advanceTimersByTimeAsync(1);
  const value = await restarted.runtime.read('fresh-runtime-identity');
  assert.equal(value.days.at(-1).calls, '6005');
  assert.equal(value.total, '6005');
  assert.equal(value.days.at(-1).coverage, 'complete');
});

test('background backfill persists all calendar days and a reopened chart does not repeat it', async () => {
  vi.useFakeTimers();
  const f = await setup({ backfillDelayMs: 1 });
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(500);
  const value = await f.runtime.read('identity');
  assert.equal(value.complete, true);
  assert.ok(value.days.every(day => day.coverage === 'complete'));
  const before = f.requests.length;
  await f.runtime.read('identity');
  assert.equal(f.requests.length, before + 1);
});

test('network recovery retains durable history, fails new reads closed, and resumes in the background', async () => {
  vi.useFakeTimers();
  const f = await setup();
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.state.error = new Error('offline');
  f.runtime.wake();
  await vi.advanceTimersByTimeAsync(1);
  await assert.rejects(f.runtime.read('identity'), /offline/);
  f.state.error = null;
  f.state.total = '8427';
  f.clock.value += 60000;
  await vi.advanceTimersByTimeAsync(60000);
  const value = await f.runtime.read('identity');
  assert.equal(value.days.at(-1).calls, '8427');
  assert.notEqual(value.sync.status, 'failed');
});

test('permission loss and a later role change cannot expose saved account-wide days', async () => {
  vi.useFakeTimers();
  const f = await setup({ backfillDelayMs: 1 });
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(500);
  f.state.error = Object.assign(new Error('forbidden'), { status: 403 });
  await assert.rejects(f.runtime.read('identity'), /forbidden/);
  f.state.error = null;
  f.state.scope = { ...scope, visibility: 'actor', actor_id: 'alice' };
  f.state.financial = false;
  f.state.total = '2';
  f.runtime.track('identity', f.options);
  const value = await f.runtime.read('identity');
  assert.equal(value.visibility, 'actor');
  assert.equal(value.days.at(-1).calls, '2');
  assert.equal(value.days[0].coverage, 'unknown');
  assert.equal(value.total, '2');
});

test('a delayed old login response cannot overwrite a replacement identity or scope', async () => {
  vi.useFakeTimers();
  const f = await setup();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let entered = false;
  const oldOptions = { ...f.options, request: async requestPath => { entered = true; await blocked; return response(requestPath, f.clock, { total: '999' }); } };
  f.runtime.track('identity', oldOptions);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(entered, true);
  f.runtime.stop('identity');
  f.state.scope = { ...scope, visibility: 'actor', actor_id: 'alice' };
  f.state.financial = false;
  f.state.total = '3';
  f.runtime.track('identity', f.options);
  release();
  await vi.advanceTimersByTimeAsync(1);
  assert.equal((await f.runtime.read('identity')).total, '3');
});

test('session invalidation stops collection and close cancels pending publication and new jobs', async () => {
  vi.useFakeTimers();
  const f = await setup();
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.state.valid = false;
  await assert.rejects(f.runtime.read('identity'), /session changed/);
  const before = f.requests.length;
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(f.requests.length, before);
  await f.runtime.close();
  f.runtime.wake();
  f.runtime.track('closed', f.options);
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(f.requests.length, before);
  await assert.rejects(f.runtime.read('closed'));
});

test('close aborts the active report request instead of waiting for a network timeout', async () => {
  vi.useFakeTimers();
  const f = await setup();
  let signal;
  let aborted = false;
  f.runtime.track('identity', { ...f.options, request: (_path, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
  }) });
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(signal.aborted, false);
  await f.runtime.close();
  assert.equal(aborted, true);
  assert.equal(signal.aborted, true);
});

test('a permission change during history repair rebinds on the next periodic pass without another view', async () => {
  vi.useFakeTimers();
  const f = await setup({ backfillDelayMs: 10 });
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.state.scope = { ...scope, visibility: 'actor', actor_id: 'alice' };
  f.state.financial = false;
  f.state.total = '2';
  await vi.advanceTimersByTimeAsync(20);
  const before = f.requests.length;
  f.clock.value += 60000;
  await vi.advanceTimersByTimeAsync(60000);
  assert.ok(f.requests.length > before, 'scope repair must continue without requiring another chart or login read');
  const value = await f.runtime.read('identity');
  assert.equal(value.visibility, 'actor');
  assert.equal(value.days.at(-1).calls, '2');
});

test('a lower remote total retains the last observation as partial until the total catches up', async () => {
  vi.useFakeTimers();
  const f = await setup({ total: '8' });
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.clock.value += 1000;
  f.state.total = '6';
  const lower = await f.runtime.read('identity');
  assert.equal(lower.days.at(-1).calls, '8');
  assert.equal(lower.days.at(-1).coverage, 'partial');
  f.clock.value += 1000;
  f.state.total = '9';
  const recovered = await f.runtime.read('identity');
  assert.equal(recovered.days.at(-1).calls, '9');
  assert.equal(recovered.days.at(-1).coverage, 'complete');
});

test('UTC day rollover finalizes yesterday and starts the new day without opening the chart', async () => {
  vi.useFakeTimers();
  const f = await setup();
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.clock.value = Date.parse('2026-11-09T00:00:01Z');
  f.state.total = '8428';
  f.runtime.wake();
  await vi.advanceTimersByTimeAsync(1);
  const value = await f.runtime.read('identity');
  assert.deepEqual(value.days.at(-2), { date: '2026-11-08', calls: '8428', coverage: 'complete' });
  assert.deepEqual(value.days.at(-1), { date: '2026-11-09', calls: '0', coverage: 'complete' });
});

test('restart reuses completed historical days instead of fetching the entire calendar again', async () => {
  vi.useFakeTimers();
  const first = await setup({ backfillDelayMs: 1 });
  first.runtime.track('identity', first.options);
  await vi.advanceTimersByTimeAsync(500);
  assert.equal((await first.runtime.read('identity')).complete, true);
  await first.runtime.close();
  const restarted = await setup({ directory: first.dataDir, backfillDelayMs: 1 });
  restarted.clock.value += 1000;
  restarted.runtime.track('fresh-identity', restarted.options);
  await vi.advanceTimersByTimeAsync(500);
  const value = await restarted.runtime.read('fresh-identity');
  assert.equal(value.complete, true);
  assert.equal(restarted.requests.length, 3, 'restart reads today, yesterday and the explicit chart authorization only');
});

test('the exact report observation retains RFC3339 sub-millisecond precision', async () => {
  const clock = { value: INITIAL_NOW + 1 };
  const value = await activity.readPlatformUsageActivityDay({ ownerBase, date: '2026-11-08', now: clock.value, assertCurrent() {}, request: async requestPath => response(requestPath, clock, { as_of: '2026-11-08T12:00:00.000000001Z' }) });
  assert.equal(value.observedAt, '2026-11-08T12:00:00.000000001Z');
  assert.equal(value.coveredUntil, '2026-11-08T12:00:00.000000001Z');
});

test('a sub-millisecond filter expansion cannot be accepted as the requested daily range', async () => {
  const clock = { value: INITIAL_NOW };
  await assert.rejects(activity.readPlatformUsageActivityDay({ ownerBase, date: '2026-11-08', now: clock.value, assertCurrent() {}, request: async requestPath => {
    const value = response(requestPath, clock);
    value.filter.to = '2026-11-08T12:00:00.000000001Z';
    return value;
  } }), activity.PlatformUsageActivityError);
});

test('a chart read crossing midnight keeps its calendar bound to the authorized probe', async () => {
  vi.useFakeTimers();
  const f = await setup();
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.clock.value = Date.parse('2026-11-08T23:59:59.999Z');
  f.runtime.track('identity', { ...f.options, request: async requestPath => {
    f.clock.value = Date.parse('2026-11-09T00:00:00.100Z');
    return response(requestPath, f.clock, { total: '8425' });
  } });
  const value = await f.runtime.read('identity');
  assert.equal(value.days.at(-1).date, '2026-11-08');
  assert.equal(value.to, '2026-11-08T23:59:59.999Z');
});

test('history repair yields after each request so a chart authorization can run next', async () => {
  vi.useFakeTimers();
  const f = await setup({ backfillDelayMs: 10 });
  let release;
  const block = new Promise(resolve => { release = resolve; });
  let blockedDate;
  const requests = [];
  f.runtime.track('identity', { ...f.options, request: async requestPath => {
    const day = new URL(requestPath, 'https://fixture.test').searchParams.get('from').slice(0, 10);
    requests.push(day);
    if (day < '2026-11-07' && !blockedDate) { blockedDate = day; await block; }
    return response(requestPath, f.clock);
  } });
  await vi.advanceTimersByTimeAsync(11);
  assert.ok(blockedDate);
  const pending = f.runtime.read('identity');
  release();
  await pending;
  assert.equal(requests[requests.indexOf(blockedDate) + 1], '2026-11-08');
});

test('two identities sharing a scope cannot let a late old transaction borrow the new revision', async () => {
  vi.useFakeTimers();
  const f = await setup({ total: '10' });
  f.runtime.track('first', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.runtime.track('second', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.clock.value += 1000;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.runtime.track('first', { ...f.options, request: async requestPath => {
    await blocked;
    return response(requestPath, f.clock, { total: '10', as_of: '2026-11-08T12:00:03Z' });
  } });
  const oldRead = f.runtime.read('first');
  await vi.advanceTimersByTimeAsync(1);
  f.state.total = '20';
  assert.equal((await f.runtime.read('second')).days.at(-1).calls, '20');
  release();
  const value = await oldRead;
  assert.equal(value.days.at(-1).calls, '20');
  assert.equal(value.days.at(-1).coverage, 'complete', 'an old concurrent response cannot mark the newer exact snapshot as a decrease');
});

test('403 clears the binding but periodic collection recovers without another login or chart read', async () => {
  vi.useFakeTimers();
  const f = await setup();
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.state.error = Object.assign(new Error('forbidden'), { status: 403 });
  await assert.rejects(f.runtime.read('identity'), /forbidden/);
  f.state.error = null;
  f.state.scope = { ...scope, visibility: 'actor', actor_id: 'alice' };
  f.state.financial = false;
  f.state.total = '4';
  f.clock.value += 60000;
  const before = f.requests.length;
  await vi.advanceTimersByTimeAsync(60000);
  assert.ok(f.requests.length > before, 'the background collector must retry permission checks without opening a view');
  const value = await f.runtime.read('identity');
  assert.equal(value.visibility, 'actor');
  assert.equal(value.total, '4');
  assert.equal(value.days[0].coverage, 'unknown');
});

test('a successful read after 403 resumes missing history and recovers the sync state immediately', async () => {
  vi.useFakeTimers();
  const f = await setup({ backfillDelayMs: 1 });
  f.runtime.track('identity', f.options);
  await vi.advanceTimersByTimeAsync(1);
  f.state.error = Object.assign(new Error('forbidden'), { status: 403 });
  await assert.rejects(f.runtime.read('identity'), /forbidden/);
  f.state.error = null;
  f.clock.value += 1000;
  const before = f.requests.length;
  const resumed = await f.runtime.read('identity');
  assert.equal(f.requests.length, before + 1, 'resuming historical work must not add remote requests to the chart read');
  assert.equal(resumed.sync.status, 'syncing');
  assert.equal(resumed.complete, false);
  await vi.advanceTimersByTimeAsync(500);
  const completed = await f.runtime.read('identity');
  assert.equal(completed.complete, true);
  assert.equal(completed.sync.status, 'synced');
});
