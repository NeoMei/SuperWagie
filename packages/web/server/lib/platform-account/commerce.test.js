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
const scopes = ['catalog:read', 'subscriptions:read', 'wallets:read', 'orders:read', 'orders:write'];
const membership = { id: 'membership', product_id: 'superwagie', name: 'Membership', account_kind: 'both', kind: 'membership', period: 'month', price: '1000000', monthly_credit: '2000000', validity_months: 0, rank: 1, sandbox: false, status: 'published', entitlements: { pricing_program: 'superwagie-ai-points-v1' } };
const addon = { ...membership, id: 'addon', kind: 'addon', period: 'once', price: '2000000', monthly_credit: '4000000', validity_months: 12 };
const sandboxOffer = { ...membership, id: 'sandbox', name: 'Sandbox membership', sandbox: true };

const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-commerce-test-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { actor: 'actor-a', account: 'personal-a', service: 'service-a', role: 'owner', scopes: [...scopes], sandbox: true, creditsReady: true, failRead: false, loseResponse: false, blockPost: null, rejectOrder: '', calls: [], wallet: 10_000_000n, credits: 0n, now: Date.now(), offers: [membership, addon], activeMembership: false, pendingFulfillment: false, quoteAccount: undefined };
  const orders = new Map(); const quotes = new Map(); const byKey = new Map();
  const upstream = async (route, init = {}) => {
    state.calls.push({ route, method: init.method ?? 'GET', body: init.body, key: init.headers?.['Idempotency-Key'] });
    if (route === '/v1/accounts') return [{ id: state.account, kind: 'personal', role: state.role }];
    if (route === '/v1/capabilities') return { product_id: 'superwagie', scopes: state.scopes, sandbox: state.sandbox, product_wallet_recharge: state.sandbox, real_payments_configured: false, payment_providers: [], native_credits: { ready: state.creditsReady } };
    if (route === '/v1/catalog') return [...state.offers, sandboxOffer].map((item) => ({ ...item, sales_readiness: item.sandbox ? undefined : { ready: true } }));
    if (route.endsWith('/resources')) {
      if (state.failRead) throw new PlatformAccountError('service_unavailable', 503);
      return { account_id: state.account, wallets: [{ product_id: 'superwagie', asset: 'CNY/6', amount: String(state.wallet) }], as_of: new Date().toISOString() };
    }
    if (route.endsWith('/subscriptions')) return state.activeMembership ? [{ product_id: 'superwagie', status: 'active', paid_through: new Date(Date.now() + 3600000).toISOString() }] : [];
    if (route.endsWith('/orders') && !init.method) return [...orders.values()];
    if (route.endsWith('/checkouts') && !init.method) return [];
    if (route.endsWith('/quotes') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const selected = state.offers.find((item) => item.id === body.offer_id);
      const result = { id: `quote-${quotes.size}`, account_id: state.quoteAccount ?? state.account, subscription_id: body.subscription_id, subscription_version: 1, offer: selected, amount: '500000', grant_amount: '1000000', period_start: new Date(state.now - 1000).toISOString(), expires_at: new Date(state.now + 60_000).toISOString(), created_at: new Date(state.now).toISOString() };
      quotes.set(result.id, result); return result;
    }
    if (init.method === 'POST') {
      const journal = JSON.parse(await fs.readFile(path.join(directory, 'unihub-commerce/state.json'), 'utf8'));
      const saved = Object.values(journal.intents).find((intent) => intent.idempotencyKey === init.headers['Idempotency-Key']);
      expect(saved.status).toBe('UNKNOWN');
      if (state.blockPost) await state.blockPost;
      const old = byKey.get(init.headers['Idempotency-Key']);
      if (old) return structuredClone(old);
      if (!route.endsWith('/orders') && !route.endsWith('/accept')) throw new Error(`Unexpected POST ${route}`);
      if (state.rejectOrder) throw new PlatformAccountError(state.rejectOrder, state.rejectOrder === 'insufficient_funds' ? 402 : 409);
      const quote = route.endsWith('/accept') ? quotes.get(route.split('/').at(-2)) : null;
      const selected = quote?.offer ?? state.offers.find((item) => item.id === JSON.parse(init.body).offer_id);
      const amount = quote?.amount ?? selected.price;
      if (state.wallet < BigInt(amount)) throw new PlatformAccountError('insufficient_funds', 402);
      state.wallet -= BigInt(amount); state.credits += BigInt(quote?.grant_amount ?? selected.monthly_credit);
      const result = { id: `order-${orders.size}`, account_id: state.account, actor_id: state.actor, product_id: selected.product_id, offer: selected, amount, payment_status: 'PAID', fulfillment_status: state.pendingFulfillment ? 'PENDING' : 'FULFILLED' };
      if (quote) { result.kind = 'upgrade'; result.subscription_id = quote.subscription_id; }
      orders.set(result.id, result); byKey.set(init.headers['Idempotency-Key'], result);
      if (state.loseResponse) { state.loseResponse = false; throw new PlatformAccountError('platform_unavailable', 502); }
      return structuredClone(result);
    }
    throw new Error(`Unexpected route ${route}`);
  };
  const accountRuntime = { captureCommerceSession(who) {
    if (who !== identity) throw new PlatformAccountError('platform_session_expired', 401);
    const account = state.account; const actor = state.actor; const service = state.service;
    return { actingUserId: actor, billingAccountId: account, serviceId: state.service, request: async (route, init) => {
      if (state.actor !== actor || state.account !== account || state.service !== service) throw new PlatformAccountError('platform_session_changed', 409);
      const result = await upstream(route, init);
      if (state.actor !== actor || state.account !== account || state.service !== service) throw new PlatformAccountError('platform_session_changed', 409);
      return result;
    } };
  } };
  const create = () => {
    const runtime = createPlatformCommerceRuntime({ accountRuntime, dataDir: directory, now: () => state.now });
    cleanups.push(() => runtime.close());
    return runtime;
  };
  return { directory, state, orders, quotes, runtime: create(), create };
};

const purchaseBody = (f, offerId = membership.id) => ({ accountId: f.state.account, offerId, idempotencyKey: crypto.randomUUID() });

describe('UniHub commerce without sandbox funding', () => {
  it('never exposes sandbox offers or sandbox funding controls', async () => {
    const f = await fixture();
    const view = await f.runtime.overview(identity);
    expect(view.offers.map((item) => item.id)).toEqual(['membership', 'addon']);
    expect(view.payments).toEqual({ mode: 'unconfigured', providers: [], canPurchase: true });
    expect('canRecharge' in view.payments).toBe(false);
    expect(f.runtime.createRecharge).toBeUndefined();
    expect(f.runtime.sandboxSettle).toBeUndefined();
  });

  it('buys a formal offer from existing cash and reports fulfillment', async () => {
    const f = await fixture();
    const result = await f.runtime.purchase(identity, purchaseBody(f));
    expect(result).toMatchObject({ kind: 'purchase', status: 'APPLIED' });
    expect(f.state.wallet).toBe(9_000_000n); expect(f.state.credits).toBe(2_000_000n);
    const view = await f.runtime.overview(identity);
    expect(view.orders).toEqual([expect.objectContaining({ paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED' })]);
  });

  it('reuses an idempotency key and rejects a different payload', async () => {
    const f = await fixture(); const body = purchaseBody(f);
    const first = await f.runtime.purchase(identity, body);
    const second = await f.runtime.purchase(identity, body);
    expect(second).toEqual(first); expect(f.orders.size).toBe(1); expect(f.state.wallet).toBe(9_000_000n);
    await expect(f.runtime.purchase(identity, { ...body, offerId: addon.id })).rejects.toMatchObject({ code: 'platform_idempotency_conflict' });
  });

  it('recovers a lost purchase response with the original key and one debit', async () => {
    const f = await fixture(); f.state.loseResponse = true;
    const body = purchaseBody(f);
    expect((await f.runtime.purchase(identity, body)).status).toBe('UNKNOWN');
    expect(f.orders.size).toBe(1); expect(f.state.wallet).toBe(9_000_000n);
    const recovered = await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: f.state.account });
    expect(recovered.status).toBe('APPLIED'); expect(f.orders.size).toBe(1); expect(f.state.wallet).toBe(9_000_000n);
  });

  it('does not replay a known failed purchase', async () => {
    const f = await fixture(); f.state.rejectOrder = 'insufficient_funds';
    const body = purchaseBody(f);
    const failed = await f.runtime.purchase(identity, body);
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'payment_not_configured' });
    expect(f.orders.size).toBe(0);
    expect(await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: f.state.account })).toEqual(failed);
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('rejects members, missing scopes and a stale account before dispatch', async () => {
    const f = await fixture(); f.state.role = 'member';
    await expect(f.runtime.purchase(identity, purchaseBody(f))).rejects.toMatchObject({ code: 'platform_billing_forbidden' });
    f.state.role = 'owner'; f.state.scopes = scopes.filter((scope) => scope !== 'orders:write');
    await expect(f.runtime.purchase(identity, purchaseBody(f))).rejects.toMatchObject({ code: 'platform_scope_required' });
    f.state.scopes = [...scopes];
    const stale = { accountId: 'personal-a', offerId: membership.id, idempotencyKey: crypto.randomUUID() };
    f.state.account = 'other-account';
    await expect(f.runtime.purchase(identity, stale)).rejects.toMatchObject({ code: 'platform_account_changed' });
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('refuses a second active membership purchase', async () => {
    const f = await fixture(); f.state.activeMembership = true;
    await expect(f.runtime.purchase(identity, purchaseBody(f))).rejects.toMatchObject({ code: 'platform_membership_active' });
    expect(f.orders.size).toBe(0); expect(f.state.wallet).toBe(10_000_000n);
  });

  it('blocks AI-point offers until native credits are ready', async () => {
    const f = await fixture(); f.state.creditsReady = false;
    const view = await f.runtime.overview(identity);
    expect(view.offers[0].purchaseReadiness).toEqual({ ready: false, reason: 'points_runtime_unavailable' });
    await expect(f.runtime.purchase(identity, purchaseBody(f))).rejects.toMatchObject({ code: 'points_runtime_unavailable' });
    await expect(f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: membership.id })).rejects.toMatchObject({ code: 'points_runtime_unavailable' });
  });

  it('lists formal addons without sandbox variants', async () => {
    const f = await fixture();
    const view = await f.runtime.overview(identity);
    expect(view.offers.map((item) => item.id)).toEqual(['membership', 'addon']);
    expect(view.offers.find((item) => item.id === 'addon')).toMatchObject({ kind: 'addon', sandbox: false });
  });

  it('reads wallets and orders after a previous writer left a dead-owner lock', async () => {
    const f = await fixture();
    await f.runtime.overview(identity);
    await f.runtime.close();
    const lockPath = path.join(f.directory, 'unihub-commerce/writer.lock');
    await fs.writeFile(lockPath, `999999999:${crypto.randomUUID()}`);
    const restarted = f.create();
    const app = express();
    registerPlatformCommerceRoutes(app, { runtime: restarted, resolveIdentity: () => identity, isRequestOriginAllowed: () => true });
    const view = await request(app).get('/api/platform-account/commerce').expect(200);
    expect(view.body.accountId).toBe(f.state.account);
    expect(view.body.wallets).toEqual([{ productId: 'superwagie', asset: 'CNY/6', amount: '10000000' }]);
    expect(view.body.orders).toEqual([]);
  });

  it('quotes and accepts an upgrade with the original amount', async () => {
    const f = await fixture(); f.state.activeMembership = true; f.state.wallet = 10_000_000n;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: membership.id });
    expect(quote).toMatchObject({ amount: '500000', additionalCredits: '1000000' });
    const result = await f.runtime.acceptUpgrade(identity, { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() });
    expect(result).toMatchObject({ kind: 'upgrade', status: 'APPLIED' });
    expect(f.state.wallet).toBe(9_500_000n); expect(f.state.credits).toBe(1_000_000n);
  });

  it('removes recharge and sandbox settlement routes', async () => {
    const f = await fixture(); const app = express();
    registerPlatformCommerceRoutes(app, { runtime: f.runtime, resolveIdentity: () => identity, isRequestOriginAllowed: () => true });
    await request(app).post('/api/platform-account/commerce/recharges').send({}).expect(404);
    await request(app).post('/api/platform-account/commerce/intents/key/sandbox-settle').send({}).expect(404);
    const view = await request(app).get('/api/platform-account/commerce').expect(200);
    expect(view.body.payments).toEqual({ mode: 'unconfigured', providers: [], canPurchase: true });
  });

});
