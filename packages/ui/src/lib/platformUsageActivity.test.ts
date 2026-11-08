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
