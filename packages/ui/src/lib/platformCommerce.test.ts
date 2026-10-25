import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PlatformAccountError, readPlatformAuthMethods, registerPlatformAccount } from './platformAccount';
import { createPlatformRecharge, formatPlatformMoney, parsePlatformRechargeAmount, readPlatformCommerce, reconcilePlatformIntent } from './platformCommerce';

const snapshots = {
  accountId: 'account-a', role: 'owner', financialAccess: true, missingScopes: [],
  payments: { mode: 'sandbox', canRecharge: true, canPurchase: true },
  wallets: [{ productId: 'superwagie', asset: 'CNY/6', amount: '9007199254740993' }],
  offers: [], orders: [], intents: [], rechargeHistoryScope: 'this-instance',
};
const intent = { idempotencyKey: 'intent-a', kind: 'recharge', accountId: 'account-a', productId: 'superwagie', amount: '10000000', status: 'UNKNOWN', createdAt: '2026-10-25T00:00:00Z' };
const restore: (() => void)[] = [];
afterEach(() => { for (const cleanup of restore.splice(0)) cleanup(); });
const intercept = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  const spy = spyOn(globalThis, 'fetch').mockImplementation(fn); restore.push(() => spy.mockRestore()); return spy;
};

describe('platform commerce transport', () => {
  test('keeps ledger precision and distinguishes unavailable scopes from empty data', async () => {
    intercept(async () => Response.json({ ...snapshots, wallets: null, missingScopes: ['wallets:read'] }));
    const state = await readPlatformCommerce();
    expect(state.wallets).toBeNull(); expect(state.missingScopes).toEqual(['wallets:read']);
    expect(formatPlatformMoney('9007199254740993')).toBe('9007199254.740993');
    expect(formatPlatformMoney('1000000')).toBe('1.00'); expect(formatPlatformMoney('1')).toBe('0.000001');
  });
  test('accepts only positive whole-cent recharge input without floating point', () => {
    expect(parsePlatformRechargeAmount('10.01')).toBe('10010000');
    expect(parsePlatformRechargeAmount('0.01')).toBe('10000');
    expect(parsePlatformRechargeAmount('9007199254740993.12')).toBe('9007199254740993120000');
    for (const value of ['0', '0.00', '-1', '1.001', '1e3', 'NaN', ' 1', '01', '.1', '1.']) {
      expect(() => parsePlatformRechargeAmount(value)).toThrow(PlatformAccountError);
    }
  });
  test('posts exactly the original financial intent and never retries an ambiguous failure', async () => {
    let attempts = 0;
    intercept(async (_url, init) => {
      attempts += 1;
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ accountId: 'account-a', productId: 'superwagie', amount: '10000000', idempotencyKey: 'intent-a' });
      throw new Error('Connection interrupted');
    });
    await expect(createPlatformRecharge({ accountId: 'account-a', productId: 'superwagie', amount: '10000000', idempotencyKey: 'intent-a' })).rejects.toThrow('platform_unavailable');
    expect(attempts).toBe(1);
  });
  test('reconciles by original key and explicit account', async () => {
    intercept(async (url, init) => {
      expect(String(url)).toContain('/commerce/intents/intent-a/reconcile');
      expect(JSON.parse(String(init?.body))).toEqual({ accountId: 'account-a' });
      return Response.json(intent);
    });
    expect((await reconcilePlatformIntent('account-a', 'intent-a')).status).toBe('UNKNOWN');
  });
  test('rejects malformed balances instead of replacing them with zero', async () => {
    intercept(async () => Response.json({ ...snapshots, wallets: [{ productId: 'superwagie', asset: 'CNY/6', amount: 1 }] }));
    await expect(readPlatformCommerce()).rejects.toThrow('platform_response_invalid');
  });
  test('preserves only structured error information for policy interactions', async () => {
    intercept(async () => Response.json({ error: 'interaction_required', interaction: { kind: 'mfa' }, details: 'private provider response' }, { status: 409 }));
    try { await readPlatformAuthMethods(); throw new Error('Expected refusal'); }
    catch (error) {
      expect(error).toBeInstanceOf(PlatformAccountError);
      if (error instanceof PlatformAccountError) {
        expect(error.code).toBe('interaction_required'); expect(error.interactionKind).toBe('mfa');
        expect(error.message).not.toContain('private');
      }
    }
  });
  test('registration reconciliation omits the password and preserves original metadata', async () => {
    intercept(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ username: 'sandbox-user', idempotencyKey: 'register-a', email: 'user@example.test' });
      return Response.json({ registrationId: 'reg-a', status: 'UNKNOWN', loginRequired: false, retryAfter: 3 });
    });
    const registration = await registerPlatformAccount({ username: 'sandbox-user', idempotencyKey: 'register-a', email: 'user@example.test' });
    expect(registration.status).toBe('UNKNOWN');
  });
});
