import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PlatformUsageActivityError, readPlatformUsageActivity } from './usage-activity.js';

const now = Date.parse('2026-11-08T12:00:00Z');
const scope = { account_id: 'personal-a', origin_product_id: 'superwagie', instance_id: 'instance-a', visibility: 'account' };
const call = (id, created_at = '2026-11-08T11:00:00Z') => ({ call_id: id, account_id: 'personal-a', actor_id: 'alice', origin_product_id: 'superwagie', instance_id: 'instance-a', created_at });
const page = (items, values = {}) => ({ scope, financial_details: true, total: String(items.length), unknown_time: '0', has_more: false, items, ...values });
const readAll = (request, time = now) => readPlatformUsageActivity({ request, accountId: 'personal-a', actorId: 'alice', now: time });
const read = (request) => {
  let firstWindow;
  return readAll(async (path) => {
    const from = new URL(path, 'https://fixture.test').searchParams.get('from');
    firstWindow ??= from;
    return from === firstWindow ? request(path) : page([]);
  });
};

test('aggregates a year through contiguous 90-day windows, resetting cursors and totals per window', async () => {
  const paths = [];
  const records = [call('recent'), call('offset', '2026-11-07T23:30:00-01:00'), call('boundary', '2026-11-04T00:00:00Z'), call('first', '2025-11-09T00:00:00Z')];
  const result = await readAll(async (path) => {
    paths.push(path);
    const query = new URL(path, 'https://fixture.test').searchParams;
    const items = records.filter((record) => Date.parse(record.created_at) >= Date.parse(query.get('from')) && Date.parse(record.created_at) < Date.parse(query.get('to')));
    const second = query.has('cursor');
    return page(second ? items.slice(2) : items.slice(0, 2), { total: String(items.length), has_more: !second && items.length > 2, next_cursor: !second && items.length > 2 ? 'signed.cursor' : undefined, unknown_time: '9007199254740993' });
  });
  const query = paths.map((path) => new URL(path, 'https://fixture.test').searchParams);
  assert.equal(query[0].get('from'), '2026-11-04T00:00:00.000Z');
  assert.equal(query[0].get('to'), '2026-11-08T12:00:00.000Z');
  assert.equal(query[1].get('from'), query[0].get('from'));
  assert.equal(query[1].get('to'), query[0].get('to'));
  assert.equal(query[1].get('cursor'), 'signed.cursor');
  assert.equal(query[2].has('cursor'), false);
  const windows = query.filter((parameters) => !parameters.has('cursor')).reverse();
  assert.equal(windows.length, 5);
  assert.equal(windows[0].get('from'), '2025-11-09T00:00:00.000Z');
  for (let index = 0; index < windows.length; index += 1) {
    assert.ok(Date.parse(windows[index].get('to')) - Date.parse(windows[index].get('from')) <= 90 * 86_400_000);
    if (index) assert.equal(windows[index].get('from'), windows[index - 1].get('to'));
  }
  assert.equal(result.days.length, 365);
  assert.equal(result.days[0].calls, '1');
  assert.equal(result.days[1].calls, '0');
  assert.equal(result.days.at(-1).calls, '2');
  assert.equal(result.days[360].calls, '1');
  assert.equal(result.total, '4');
  assert.equal(result.complete, true);
  assert.equal(result.unknownTime, '9007199254740993');
  assert.doesNotMatch(JSON.stringify(result), /call_id|alice|personal-a|instance-a/);
});

test('annual dates remain continuous across leap day and the new year', async () => {
  const result = await readAll(async () => page([]), Date.parse('2024-03-01T12:00:00Z'));
  assert.equal(result.days.length, 365);
  assert.ok(result.days.some((day) => day.date === '2024-02-29'));
  assert.ok(result.days.some((day) => day.date === '2024-01-01'));
  assert.equal(result.days.at(-1).date, '2024-03-01');
  assert.equal(result.complete, true);
});

test('empty authoritative data remains distinct from a failed later page', async () => {
  assert.equal((await read(async () => page([]))).complete, true);
  let count = 0;
  await assert.rejects(read(async () => ++count === 1 ? page([call('one')], { total: '2', has_more: true, next_cursor: 'next' }) : Promise.reject(new Error('offline'))), /offline/);
});

test('a changing live count preserves observed data with incomplete coverage', async () => {
  let count = 0;
  const result = await read(async () => ++count === 1 ? page([call('one')], { total: '2', has_more: true, next_cursor: 'next' }) : page([call('two')], { total: '3' }));
  assert.equal(result.total, '2');
  assert.equal(result.complete, false);
});

test('bounded traversal reports partial coverage when the final page is beyond the limit', async () => {
  let count = 0;
  const result = await read(async () => page([call(`call-${++count}`)], { total: '51', has_more: true, next_cursor: `cursor-${count}` }));
  assert.equal(count, 50);
  assert.equal(result.total, '50');
  assert.equal(result.complete, false);
});

test('global page budget completes only when all date windows were read', async () => {
  for (const recentPages of [46, 47]) {
    let count = 0;
    let recentCount = 0;
    let firstWindow;
    const result = await readAll(async (path) => {
      count += 1;
      const from = new URL(path, 'https://fixture.test').searchParams.get('from');
      firstWindow ??= from;
      if (from !== firstWindow) return page([]);
      recentCount += 1;
      return page([call(`call-${recentCount}`)], { total: String(recentPages), has_more: recentCount < recentPages, next_cursor: recentCount < recentPages ? `cursor-${recentCount}` : undefined });
    });
    assert.equal(count, 50);
    assert.equal(result.complete, recentPages === 46);
  }
});

test('a later date-window failure or instance change cannot become a complete calendar', async () => {
  let count = 0;
  await assert.rejects(readAll(async () => ++count === 1 ? page([]) : Promise.reject(new Error('offline'))), /offline/);
  count = 0;
  await assert.rejects(readAll(async () => ++count === 1 ? page([]) : page([], { scope: { ...scope, instance_id: 'other' } })), PlatformUsageActivityError);
});

test('rejects missing or repeated cursors and empty continuation pages', async () => {
  await assert.rejects(read(async () => page([call('one')], { has_more: true })), PlatformUsageActivityError);
  await assert.rejects(read(async () => page([], { has_more: true, next_cursor: 'next' })), PlatformUsageActivityError);
  let count = 0;
  await assert.rejects(read(async () => page([call(`call-${++count}`)], { has_more: true, next_cursor: 'repeated' })), PlatformUsageActivityError);
});

test('rejects cross-account, actor, instance, permission changes and out-of-range dates', async () => {
  const invalid = [
    page([call('wrong-account')], { scope: { ...scope, account_id: 'other' } }),
    page([call('wrong-actor')], { scope: { ...scope, visibility: 'actor', actor_id: 'mallory' } }),
    page([{ ...call('wrong-actor-row'), actor_id: 'mallory' }], { scope: { ...scope, visibility: 'actor', actor_id: 'alice' } }),
    page([{ ...call('wrong-instance'), instance_id: 'other' }]),
    page([call('too-early', '2025-11-08T23:59:59Z')]),
    page([call('wrong-window', '2026-11-03T23:59:59Z')]),
    page([call('at-end', '2026-11-08T12:00:00Z')]),
    page([{ ...call('undated'), created_at: null }]),
  ];
  for (const value of invalid) await assert.rejects(read(async () => value), PlatformUsageActivityError);
  let count = 0;
  await assert.rejects(read(async () => ++count === 1 ? page([call('one')], { total: '2', has_more: true, next_cursor: 'next' }) : page([call('two')], { total: '2', financial_details: false })), PlatformUsageActivityError);
});
