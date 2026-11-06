import { afterEach, expect, spyOn, test } from 'bun:test';
import { readPlatformAccountKeySetup, runPlatformAccountKeySetup } from './platformApiKeys';

const receipt = () => ({
  accountId: 'account-a', enterpriseMode: false,
  activation: {
    operationId: 'operation-a', status: 'testing', stage: 'test',
    key: { id: 'public-key-id', last4: 'ABCD', createdAt: '2026-11-06T00:00:00Z', expiresAt: null },
    modelId: 'chat-model', connectionId: 'connection-a', providerId: 'provider-a',
    test: null, testRunId: 'run-a', errorCode: null, actions: [],
    tests: [{ id: 'embedding', purpose: 'embedding', modelId: 'embedding-model', status: 'verified', testedAt: '2026-11-06T00:00:01Z', errorCode: null }],
  },
});
const cleanups: Array<() => void> = [];
const intercept = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  const fixture = spyOn(globalThis, 'fetch').mockImplementation(fn);
  cleanups.push(() => fixture.mockRestore());
  return fixture;
};
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

test('reads the requested account and preserves independently confirmed model rows', async () => {
  const response = receipt();
  intercept(async (url, init) => {
    expect(String(url)).toContain('/api/model-configuration/bootstrap/account-key?accountId=account-a');
    expect(init?.method).toBe('GET');
    return Response.json({ ...response, privateToken: 'must-not-reach-ui' });
  });
  const result = await readPlatformAccountKeySetup('account-a');
  expect(result.activation?.testRunId).toBe('run-a');
  expect(result.activation?.tests).toEqual(response.activation.tests);
  expect(JSON.stringify(result)).not.toContain('must-not-reach-ui');
});

test('legacy receipts supply no invented per-model outcome or batch identity', async () => {
  const { tests: _tests, testRunId: _testRunId, ...legacy } = receipt().activation;
  intercept(async () => Response.json({ ...receipt(), activation: legacy }));
  const result = await readPlatformAccountKeySetup('account-a');
  expect(result.activation?.tests).toEqual([]);
  expect(result.activation?.testRunId).toBeNull();
});

test('accepts unresolved and unsupported rows without treating them as verified', async () => {
  const response = receipt();
  intercept(async () => Response.json({ ...response, activation: { ...response.activation, tests: [
    { ...response.activation.tests[0], id: 'queued', status: 'queued', testedAt: null },
    { ...response.activation.tests[0], id: 'unknown', status: 'unknown', testedAt: null },
    { ...response.activation.tests[0], id: 'skipped', status: 'skipped', modelId: null, testedAt: null, errorCode: 'account_key_model_unavailable' },
  ] } }));
  const result = await readPlatformAccountKeySetup('account-a');
  expect(result.activation?.tests.map(row => row.status)).toEqual(['queued', 'unknown', 'skipped']);
  expect(result.activation?.tests[2].modelId).toBeNull();
});

test('rejects other accounts, duplicate rows and malformed verified outcomes', async () => {
  const response = receipt(); const row = response.activation.tests[0];
  for (const invalid of [
    { ...response, accountId: 'other-account' },
    { ...response, activation: { ...response.activation, tests: [row, row] } },
    { ...response, activation: { ...response.activation, tests: [{ ...row, purpose: 'made-up-purpose' }] } },
    { ...response, activation: { ...response.activation, tests: [{ ...row, testedAt: null }] } },
    { ...response, activation: { ...response.activation, tests: [{ ...row, modelId: null }] } },
    { ...response, activation: { ...response.activation, tests: [{ ...row, status: 'passed' }] } },
  ]) {
    const fixture = intercept(async () => Response.json(invalid));
    await expect(readPlatformAccountKeySetup('account-a')).rejects.toThrow('platform_response_invalid');
    fixture.mockRestore();
  }
});

test('an explicit retest posts exactly once and never retries an ambiguous transport failure', async () => {
  let calls = 0;
  intercept(async (url, init) => {
    calls += 1;
    expect(String(url)).toContain('/api/model-configuration/bootstrap/account-key');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ accountId: 'account-a', action: 'retest' });
    throw new Error('private-transport-detail');
  });
  await expect(runPlatformAccountKeySetup('account-a', 'retest')).rejects.toThrow('platform_unavailable');
  expect(calls).toBe(1);
});
