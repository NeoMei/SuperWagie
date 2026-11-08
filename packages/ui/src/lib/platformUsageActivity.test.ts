import { afterEach, expect, spyOn, test, type Mock } from 'bun:test';
import { readPlatformUsageActivity } from './platformUsageActivity';

const response = {
  visibility: 'account', from: '2025-11-09T00:00:00Z', to: '2026-11-08T12:00:00Z', asOf: '2026-11-08T12:00:00Z',
  days: Array.from({ length: 365 }, (_, index) => ({ date: new Date(Date.parse('2025-11-09T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10), calls: index === 364 ? '9007199254740993' : '0' })),
  total: '9007199254740993', complete: true, unknownTime: '0',
};
let fetchSpy: Mock<typeof fetch> | null = null;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = null; });

test('activity contract preserves exact counts and requests only the selected account activity', async () => {
  let requested = '';
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => { requested = String(input); return Response.json(response); });
  const activity = await readPlatformUsageActivity('account-a');
  expect(requested).toBe('/api/platform-account/usage/account-a/activity');
  expect(activity.total).toBe('9007199254740993');
  expect(activity.days[364].calls).toBe('9007199254740993');
});

test('activity contract rejects missing dates and mismatched totals', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ...response, days: response.days.slice(1) }));
  await expect(readPlatformUsageActivity('account-a')).rejects.toMatchObject({ code: 'platform_response_invalid' });
  fetchSpy.mockImplementation(async () => Response.json({ ...response, total: '0' }));
  await expect(readPlatformUsageActivity('account-a')).rejects.toMatchObject({ code: 'platform_response_invalid' });
  fetchSpy.mockImplementation(async () => Response.json({ ...response, to: '2026-11-07T12:00:00Z' }));
  await expect(readPlatformUsageActivity('account-a')).rejects.toMatchObject({ code: 'platform_response_invalid' });
});

test('permission failures remain failures rather than an empty calendar', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'forbidden' }, { status: 403 }));
  await expect(readPlatformUsageActivity('account-a')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
});

test('daily local snapshots distinguish confirmed zero, unknown history and partial observations', async () => {
  const days = response.days.map((day, index) => ({ ...day, coverage: index === 0 ? 'unknown' : index === 1 ? 'partial' : 'complete' }));
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
    ...response, days, complete: false, savedAt: response.to,
    sync: { status: 'syncing', lastSuccessAt: response.from },
  }));
  const activity = await readPlatformUsageActivity('account-a');
  expect(activity.days[0]).toMatchObject({ calls: '0', coverage: 'unknown' });
  expect(activity.days[1]).toMatchObject({ calls: '0', coverage: 'partial' });
  expect(activity.days[2]).toMatchObject({ calls: '0', coverage: 'complete' });
  expect(activity.total).toBe('9007199254740993');
  expect(activity.savedAt).toBe(response.to);
  expect(activity.sync).toEqual({ status: 'syncing', lastSuccessAt: response.from });
});

test('published legacy reports remain conservative without claiming a local saved snapshot', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ...response, complete: false }));
  const partial = await readPlatformUsageActivity('account-a');
  expect(partial.days[0].coverage).toBe('unknown');
  expect(partial.days[364].coverage).toBe('partial');
  expect(partial.savedAt).toBeNull();
  expect(partial.sync).toBeNull();
  fetchSpy.mockImplementation(async () => Response.json(response));
  const complete = await readPlatformUsageActivity('account-a');
  expect(complete.days.every((day) => day.coverage === 'complete')).toBe(true);
});

test('local snapshot metadata and coverage are complete and internally consistent', async () => {
  const daily = {
    ...response, days: response.days.map((day) => ({ ...day, coverage: 'complete' })),
    savedAt: response.to, sync: { status: 'synced', lastSuccessAt: response.to },
  };
  const invalid = [
    { ...daily, savedAt: undefined },
    { ...daily, sync: undefined },
    { ...daily, savedAt: 'yesterday' },
    { ...daily, sync: { status: 'pending', lastSuccessAt: null } },
    { ...daily, days: daily.days.map((day, index) => index === 0 ? { ...day, coverage: undefined } : day) },
    { ...daily, days: daily.days.map((day, index) => index === 364 ? { ...day, coverage: 'unknown' } : day) },
    { ...daily, days: daily.days.map((day, index) => index === 0 ? { ...day, coverage: 'partial' } : day) },
    { ...daily, complete: false },
  ];
  fetchSpy = spyOn(globalThis, 'fetch');
  for (const value of invalid) {
    fetchSpy.mockImplementation(async () => Response.json(value));
    await expect(readPlatformUsageActivity('account-a')).rejects.toMatchObject({ code: 'platform_response_invalid' });
  }
});
