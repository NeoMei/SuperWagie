import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformCommerceRuntime } from './commerce.js';
import { registerPlatformCommerceRoutes } from './commerce-routes.js';
import { PlatformAccountError } from './runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const identity = { type: 'client', token: 'private-runtime-token' };
const scopes = ['catalog:read', 'subscriptions:read', 'wallets:read', 'orders:read', 'recharges:read', 'recharges:write', 'orders:write', 'operations:read'];
const offer = { id: 'sandbox-membership', product_id: 'superwagie', name: 'Sandbox membership', account_kind: 'both', kind: 'membership', period: 'month', price: '1000000', monthly_credit: '2000000', validity_months: 0, rank: 1, sandbox: true, status: 'published' };

const fixture = async (env) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-commerce-gate-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { actor: 'actor-a', account: 'personal-a', service: 'service-a', role: 'owner', scopes: [...scopes], sandbox: true, calls: [], wallet: 0n, now: Date.now(), offers: [offer, { ...offer, id: 'formal', sandbox: false }] };
  const recharges = new Map(); const operations = new Map();
  const accountRuntime = { captureCommerceSession: () => ({ billingAccountId: state.account, actingUserId: state.actor, serviceId: state.service, request: async (route, init = {}) => {
    state.calls.push({ route, method: init.method ?? 'GET' });
    if (route === '/v1/accounts') return [{ id: state.account, kind: 'personal', role: state.role }];
    if (route === '/v1/capabilities') return { product_id: 'superwagie', scopes: state.scopes, sandbox: state.sandbox, product_wallet_recharge: state.sandbox, real_payments_configured: false };
    if (route === '/v1/catalog') return state.offers;
    if (route.endsWith('/resources')) return { account_id: state.account, wallets: [{ product_id: 'superwagie', asset: 'CNY/6', amount: String(state.wallet) }], as_of: new Date().toISOString() };
    if (route.endsWith('/subscriptions')) return [];
    if (route.endsWith('/orders') && !init.method) return [];
    if (init.method === 'POST' && route.endsWith('/recharges')) {
      const body = JSON.parse(init.body);
      const result = { id: `re-${recharges.size}`, account_id: state.account, product_id: body.product_id, amount: body.amount, currency: 'CNY' };
      recharges.set(result.id, result);
      return result;
    }
    if (route.endsWith('/sandbox-settle')) {
      const recharge = recharges.get(route.split('/').at(-2));
      const operation = { id: `op-${operations.size}`, account_id: state.account, kind: 'recharge', status: 'APPLIED' };
      recharge.operation_id = operation.id; operations.set(operation.id, operation); state.wallet += BigInt(recharge.amount);
      return operation;
    }
    if (route.includes('/recharges/')) return recharges.get(route.split('/').at(-1));
    if (route.includes('/operations/')) return operations.get(route.split('/').at(-1));
    throw new PlatformAccountError('platform_response_invalid', 502);
  } }) };
  const runtime = createPlatformCommerceRuntime({ accountRuntime, dataDir: directory, now: () => state.now, env });
  cleanups.push(() => runtime.close());
  return { state, runtime, recharge: () => ({ accountId: state.account, productId: 'superwagie', amount: '10000000', idempotencyKey: crypto.randomUUID() }) };
};

describe('sandbox funding requires an explicit local opt-in', () => {
  it('refuses free funding even when UniHub reports sandbox capability', async () => {
    const f = await fixture({});
    expect(f.state.sandbox).toBe(true);
    const overview = await f.runtime.overview(identity);
    expect(overview.payments).toEqual({ mode: 'unconfigured', providers: [], canRecharge: false, canPurchase: true });
    expect(overview.offers.map((item) => item.id)).toEqual(['formal']);
    const body = f.recharge();
    await expect(f.runtime.createRecharge(identity, body)).rejects.toMatchObject({ code: 'payment_not_configured' });
    await expect(f.runtime.sandboxSettle(identity, body.idempotencyKey, { accountId: body.accountId })).rejects.toMatchObject({ code: 'payment_not_configured' });
    expect(f.state.calls.filter((call) => call.route.includes('recharges') || call.route.endsWith('sandbox-settle'))).toHaveLength(0);
  });

  it('refuses the recharge and sandbox-settle HTTP routes without the switch', async () => {
    const f = await fixture({});
    const app = express();
    registerPlatformCommerceRoutes(app, { runtime: f.runtime, resolveIdentity: async () => identity, isRequestOriginAllowed: async () => true });
    await request(app).post('/api/platform-account/commerce/recharges').send(f.recharge()).expect(503, { error: 'payment_not_configured' });
    await request(app).post('/api/platform-account/commerce/intents/does-not-exist/sandbox-settle').send({ accountId: f.state.account }).expect(503, { error: 'payment_not_configured' });
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('keeps the explicit sandbox test path available when the switch is set', async () => {
    const f = await fixture({ OPENCHAMBER_UNIHUB_ALLOW_SANDBOX_FUNDING: 'true' });
    const body = f.recharge();
    expect((await f.runtime.createRecharge(identity, body)).status).toBe('PENDING');
    expect((await f.runtime.sandboxSettle(identity, body.idempotencyKey, { accountId: body.accountId })).status).toBe('APPLIED');
    expect(f.state.calls.filter((call) => call.route.endsWith('sandbox-settle'))).toHaveLength(1);
  });
});
