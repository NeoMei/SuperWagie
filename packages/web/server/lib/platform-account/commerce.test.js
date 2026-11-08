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
const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-commerce-test-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { actor: 'actor-a', account: 'personal-a', service: 'service-a', role: 'owner', scopes: [...scopes], sandbox: true, failRead: false, loseResponse: false, blockPost: null, calls: [], wallet: 0n, credits: 0n, now: Date.now(), offers: [offer, { ...offer, id: 'other-account', account_kind: 'team' }, { ...offer, id: 'formal', sandbox: false }] };
  const recharges = new Map(); const orders = new Map(); const operations = new Map(); const quotes = new Map();
  const byKey = new Map();
  const upstream = async (route, init = {}) => {
    state.calls.push({ route, method: init.method ?? 'GET', body: init.body, key: init.headers?.['Idempotency-Key'] });
    if (route === '/v1/accounts') return [{ id: state.account, kind: 'personal', role: state.role }];
    if (route === '/v1/capabilities') return { product_id: 'superwagie', scopes: state.scopes, sandbox: state.sandbox, product_wallet_recharge: state.sandbox, real_payments_configured: false };
    if (route === '/v1/catalog') return state.offers.map((item) => ({ ...item, sales_readiness: state.readiness }));
    if (route.endsWith('/resources')) {
      if (state.failRead) throw new PlatformAccountError('service_unavailable', 503);
      return { account_id: state.account, wallets: [{ product_id: 'superwagie', asset: 'CNY/6', amount: String(state.wallet) }], as_of: new Date().toISOString() };
    }
    if (route.endsWith('/subscriptions')) return state.activeMembership ? [{ product_id: 'superwagie', status: 'active', paid_through: new Date(Date.now() + 3600000).toISOString() }] : [];
    if (route.endsWith('/orders') && !init.method) return [...orders.values()];
    if (route.endsWith('/quotes') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const selected = state.offers.find((item) => item.id === body.offer_id);
      const result = { id: `quote-${quotes.size}`, account_id: state.quoteAccount ?? state.account, subscription_id: body.subscription_id, subscription_version: 1, offer: selected, amount: '500000', grant_amount: '1000000', period_start: new Date(state.now - 1000).toISOString(), expires_at: new Date(state.now + 60_000).toISOString(), created_at: new Date(state.now).toISOString() };
      quotes.set(result.id, result); return result;
    }
    if (init.method === 'POST' && !route.endsWith('/sandbox-settle')) {
      const journal = JSON.parse(await fs.readFile(path.join(directory, 'unihub-commerce/state.json'), 'utf8'));
      const saved = Object.values(journal.intents).find((intent) => intent.idempotencyKey === init.headers['Idempotency-Key']);
      expect(saved.status).toBe('UNKNOWN');
      if (state.blockPost) await state.blockPost;
      const old = byKey.get(init.headers['Idempotency-Key']);
      if (old) return structuredClone(old);
      let result;
      if (route.endsWith('/recharges')) {
        const body = JSON.parse(init.body);
        result = { id: `re-${recharges.size}`, account_id: state.account, product_id: body.product_id, amount: body.amount, currency: 'CNY' };
        recharges.set(result.id, result);
      } else if (route.endsWith('/orders') || route.endsWith('/accept')) {
        if (state.rejectOrder) throw new PlatformAccountError(state.rejectOrder, 409);
        const quote = route.endsWith('/accept') ? quotes.get(route.split('/').at(-2)) : null;
        const selected = quote?.offer ?? state.offers.find((item) => item.id === JSON.parse(init.body).offer_id);
        const amount = quote?.amount ?? selected.price;
        if (state.wallet < BigInt(amount)) throw new PlatformAccountError('insufficient_funds', 402);
        state.wallet -= BigInt(amount); state.credits += BigInt(quote?.grant_amount ?? selected.monthly_credit);
        result = { id: `order-${orders.size}`, account_id: state.account, actor_id: state.actor, product_id: selected.product_id, offer: selected, amount, payment_status: 'PAID', fulfillment_status: state.pendingFulfillment ? 'PENDING' : 'FULFILLED' };
        if (quote) { result.kind = 'upgrade'; result.subscription_id = quote.subscription_id; }
        orders.set(result.id, result);
      }
      byKey.set(init.headers['Idempotency-Key'], result);
      if (state.loseResponse) { state.loseResponse = false; throw new PlatformAccountError('platform_unavailable', 502); }
      return structuredClone(result);
    }
    if (route.endsWith('/sandbox-settle')) {
      const recharge = recharges.get(route.split('/').at(-2));
      if (recharge.operation_id) return operations.get(recharge.operation_id);
      const operation = { id: `op-${operations.size}`, account_id: state.account, kind: 'recharge', status: 'APPLIED' };
      recharge.operation_id = operation.id; operations.set(operation.id, operation); state.wallet += BigInt(recharge.amount);
      if (state.loseResponse) { state.loseResponse = false; throw new PlatformAccountError('platform_unavailable', 502); }
      return structuredClone(operation);
    }
    if (route.includes('/recharges/')) return structuredClone(recharges.get(route.split('/').at(-1)));
    if (route.includes('/operations/')) return structuredClone(operations.get(route.split('/').at(-1)));
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
  return { directory, state, recharges, orders, quotes, runtime: create(), create, recharge: (amount = '10000000') => ({ accountId: state.account, productId: 'superwagie', amount, idempotencyKey: crypto.randomUUID() }) };
};

describe('UniHub sandbox commerce', () => {
  it('keeps recharge, explicit sandbox settlement, purchase and fulfillment separate', async () => {
    const f = await fixture();
    const body = f.recharge();
    const intent = await f.runtime.createRecharge(identity, body);
    expect(intent.status).toBe('PENDING'); expect(f.state.wallet).toBe(0n);
    const overview = await f.runtime.overview(identity);
    expect(overview.offers.map((item) => item.id)).toEqual(['sandbox-membership', 'formal']);
    expect(overview.payments).toEqual({ mode: 'sandbox', providers: [], canRecharge: true, canPurchase: true });
    expect(overview.rechargeHistoryScope).toBe('this-instance');
    expect(f.state.calls.filter((call) => call.route.endsWith('sandbox-settle'))).toHaveLength(0);
    const paid = await f.runtime.sandboxSettle(identity, body.idempotencyKey, { accountId: body.accountId });
    expect(paid.status).toBe('APPLIED'); expect(f.state.wallet).toBe(10_000_000n);
    await f.runtime.sandboxSettle(identity, body.idempotencyKey, { accountId: body.accountId });
    expect(f.state.wallet).toBe(10_000_000n);
    const purchase = await f.runtime.purchase(identity, { accountId: body.accountId, offerId: offer.id, idempotencyKey: crypto.randomUUID() });
    expect(purchase.status).toBe('APPLIED'); expect(f.state.wallet).toBe(9_000_000n); expect(f.state.credits).toBe(2_000_000n);
    expect((await f.runtime.overview(identity)).orders[0]).toMatchObject({ paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED' });
    expect(await fs.readFile(path.join(f.directory, 'unihub-commerce/state.json'), 'utf8')).not.toContain(identity.token);
  });
  it('reuses an intent key and refuses changes to its payload', async () => {
    const f = await fixture(); const body = f.recharge();
    const first = await f.runtime.createRecharge(identity, body);
    expect(await f.runtime.createRecharge(identity, body)).toEqual(first);
    await expect(f.runtime.createRecharge(identity, { ...body, amount: '20000000' })).rejects.toMatchObject({ code: 'platform_idempotency_conflict' });
    expect(f.recharges.size).toBe(1);
  });
  it('reconciles response loss after restart with the original purchase key without a second debit', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n; f.state.loseResponse = true;
    const body = { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() };
    expect((await f.runtime.purchase(identity, body)).status).toBe('UNKNOWN');
    expect(f.orders.size).toBe(1);
    await expect(f.runtime.createRecharge(identity, f.recharge())).rejects.toMatchObject({ code: 'platform_operation_pending' });
    await f.runtime.close(); const restarted = f.create();
    const read = await restarted.overview(identity);
    expect(read.intents[0].status).toBe('UNKNOWN'); expect(f.orders.size).toBe(1);
    const result = await restarted.reconcile(identity, body.idempotencyKey, { accountId: body.accountId });
    expect(result.status).toBe('APPLIED'); expect(f.state.wallet).toBe(9_000_000n); expect(f.state.credits).toBe(2_000_000n);
    const writes = f.state.calls.filter((call) => call.method === 'POST' && call.route.endsWith('/orders'));
    expect(writes.map((call) => call.key)).toEqual([body.idempotencyKey, body.idempotencyKey]);
  });
  it('never replays a known failed purchase when checking its status', async () => {
    const f = await fixture();
    const body = { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() };
    const failure = await f.runtime.purchase(identity, body); expect(failure.status).toBe('FAILED'); expect(failure.errorCode).toBe('insufficient_funds');
    f.state.wallet = 10_000_000n;
    expect(await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).toEqual(failure);
    expect(f.state.wallet).toBe(10_000_000n); expect(f.orders.size).toBe(0);
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('recovers a lost settlement response by reading the original order and operation', async () => {
    const f = await fixture(); const body = f.recharge(); await f.runtime.createRecharge(identity, body);
    f.state.loseResponse = true;
    expect((await f.runtime.sandboxSettle(identity, body.idempotencyKey, { accountId: body.accountId })).status).toBe('UNKNOWN');
    expect((await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).status).toBe('APPLIED');
    expect(f.state.calls.filter((call) => call.route.endsWith('sandbox-settle'))).toHaveLength(1);
    expect(f.state.wallet).toBe(10_000_000n);
  });
  it('does not send financial commands for members, missing scopes or a stale account', async () => {
    const f = await fixture(); const body = f.recharge(); f.state.role = 'member';
    const view = await f.runtime.overview(identity);
    expect(view.financialAccess).toBe(false); expect(view.wallets).toBeNull(); expect(view.orders).toBeNull();
    await expect(f.runtime.createRecharge(identity, body)).rejects.toMatchObject({ code: 'platform_billing_forbidden' });
    f.state.role = 'owner'; f.state.scopes = [];
    const absent = await f.runtime.overview(identity); expect(absent.offers).toBeNull(); expect(absent.wallets).toBeNull(); expect(absent.missingScopes).toContain('wallets:read');
    await expect(f.runtime.createRecharge(identity, body)).rejects.toMatchObject({ code: 'platform_scope_required' });
    f.state.scopes = scopes; f.state.account = 'team-b';
    await expect(f.runtime.createRecharge(identity, body)).rejects.toMatchObject({ code: 'platform_account_changed' });
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
  it('hides local financial history after read scope revocation without bypassing unresolved work', async () => {
    const f = await fixture(); f.state.loseResponse = true;
    const body = f.recharge(); expect((await f.runtime.createRecharge(identity, body)).status).toBe('UNKNOWN');
    f.state.scopes = scopes.filter((scope) => scope !== 'recharges:read');
    const hidden = await f.runtime.overview(identity);
    expect(hidden.intents).toEqual([]); expect(hidden.missingScopes).toContain('recharges:read');
    await expect(f.runtime.purchase(identity, { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'platform_scope_required' });
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    f.state.scopes = scopes;
    expect((await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).status).toBe('PENDING');
    await f.runtime.sandboxSettle(identity, body.idempotencyKey, { accountId: body.accountId });
    await f.runtime.purchase(identity, { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() });
    f.state.scopes = scopes.filter((scope) => scope !== 'orders:read');
    const remaining = await f.runtime.overview(identity);
    expect(remaining.orders).toBeNull(); expect(remaining.intents.map((intent) => intent.kind)).toEqual(['recharge']);
  });
  it('uses existing cash for formal legacy offers while external funding remains unavailable', async () => {
    const f = await fixture(); f.state.sandbox = false;
    expect((await f.runtime.overview(identity)).payments).toEqual({ mode: 'unconfigured', providers: [], canRecharge: false, canPurchase: true });
    await expect(f.runtime.createRecharge(identity, f.recharge())).rejects.toMatchObject({ code: 'payment_not_configured' });
    await expect(f.runtime.purchase(identity, { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'platform_offer_unavailable' });
    expect(await f.runtime.purchase(identity, { accountId: f.state.account, offerId: 'formal', idempotencyKey: crypto.randomUUID() })).toMatchObject({ status: 'FAILED', errorCode: 'payment_not_configured' });
    f.state.wallet = 10_000_000n;
    expect(await f.runtime.purchase(identity, { accountId: f.state.account, offerId: 'formal', idempotencyKey: crypto.randomUUID() })).toMatchObject({ status: 'APPLIED' });
  });
  it('keeps quantities exact and does not turn a failed read into zero', async () => {
    const f = await fixture(); const body = f.recharge('9007199254750000');
    expect((await f.runtime.createRecharge(identity, body)).amount).toBe(body.amount);
    await expect(f.runtime.createRecharge(identity, f.recharge('1'))).rejects.toMatchObject({ code: 'platform_amount_invalid' });
    await expect(f.runtime.createRecharge(identity, f.recharge('01'))).rejects.toMatchObject({ code: 'platform_request_invalid' });
    f.state.failRead = true;
    await expect(f.runtime.overview(identity)).rejects.toMatchObject({ code: 'service_unavailable' });
  });
  it('isolates local intents by verified actor and configured service', async () => {
    const f = await fixture(); const body = f.recharge(); await f.runtime.createRecharge(identity, body);
    f.state.actor = 'actor-b'; expect((await f.runtime.overview(identity)).intents).toEqual([]);
    await expect(f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).rejects.toMatchObject({ code: 'platform_intent_not_found' });
    f.state.actor = 'actor-a'; f.state.service = 'service-b'; expect((await f.runtime.overview(identity)).intents).toEqual([]);
  });
  it('rejects corrupted recovery state without sending money commands', async () => {
    const f = await fixture(); await f.runtime.overview(identity); await f.runtime.close();
    await fs.writeFile(path.join(f.directory, 'unihub-commerce/state.json'), '{broken');
    const restarted = f.create();
    await expect(restarted.createRecharge(identity, f.recharge())).rejects.toThrow();
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    cleanups.pop();
  });
  it('rejects a new membership purchase while the current membership is active', async () => {
    const f = await fixture(); f.state.activeMembership = true; f.state.wallet = 10_000_000n;
    await expect(f.runtime.purchase(identity, { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'platform_membership_active' });
    expect(f.orders.size).toBe(0); expect(f.state.wallet).toBe(10_000_000n);
  });
  it('deduplicates concurrent same-key requests and rejects conflicting concurrent payloads', async () => {
    const f = await fixture(); const body = f.recharge(); let release;
    f.state.blockPost = new Promise((resolve) => { release = resolve; });
    const first = f.runtime.createRecharge(identity, body);
    while (!f.state.calls.some((call) => call.method === 'POST')) await new Promise((resolve) => setTimeout(resolve, 1));
    const duplicate = f.runtime.createRecharge(identity, body);
    await expect(f.runtime.createRecharge(identity, { ...body, amount: '20000000' })).rejects.toMatchObject({ code: 'platform_idempotency_conflict' });
    release(); expect(await duplicate).toEqual(await first);
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('rechecks revoked role and scope before sharing an in-flight recovery result', async () => {
    const f = await fixture(); const body = f.recharge(); let release;
    f.state.blockPost = new Promise((resolve) => { release = resolve; });
    const original = f.runtime.createRecharge(identity, body);
    while (!f.state.calls.some((call) => call.method === 'POST')) await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      f.state.role = 'member';
      await expect(f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).rejects.toMatchObject({ code: 'platform_billing_forbidden' });
      f.state.role = 'owner'; f.state.scopes = scopes.filter((scope) => scope !== 'recharges:read');
      await expect(f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).rejects.toMatchObject({ code: 'platform_scope_required' });
    } finally { release(); await original; }
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('guards routes with runtime identity, origin and bounded JSON parsing', async () => {
    const f = await fixture(); const app = express(); let allow = false; let authenticated = false;
    registerPlatformCommerceRoutes(app, { runtime: f.runtime, resolveIdentity: (_req, _res, options) => { expect(options.allowUrlToken).toBe(false); if (!authenticated) throw new PlatformAccountError('platform_session_expired', 401); return identity; }, isRequestOriginAllowed: () => allow });
    await request(app).get('/api/platform-account/commerce').expect(401);
    authenticated = true;
    await request(app).post('/api/platform-account/commerce/recharges').send(f.recharge()).expect(403);
    allow = true;
    await request(app).post('/api/platform-account/commerce/recharges').set('Content-Type', 'application/json').send('{bad').expect(400);
    const result = await request(app).post('/api/platform-account/commerce/recharges').send(f.recharge()).expect(200);
    expect(result.body.status).toBe('PENDING'); expect(result.headers['cache-control']).toBe('no-store');
  });
  it('keeps formal AI-point offers visible but blocks sale and quote until their runtime can spend credits', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n;
    f.state.offers.push({ ...offer, id: 'points-v1', sandbox: false, entitlements: { pricing_program: 'superwagie-ai-points-v1' } });
    const view = await f.runtime.overview(identity);
    expect(view.offers.find((item) => item.id === 'points-v1').purchaseReadiness).toEqual({ ready: false, reason: 'points_runtime_unavailable' });
    await expect(f.runtime.purchase(identity, { accountId: f.state.account, offerId: 'points-v1', idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'points_runtime_unavailable' });
    await expect(f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: 'points-v1' })).rejects.toMatchObject({ code: 'points_runtime_unavailable' });
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
  it('lists new SuperWagie addons and keeps legacy LLMRouter addons and original purchase recovery', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n;
    f.state.offers.push({ ...offer, id: 'addon-sw', kind: 'addon' }, { ...offer, id: 'addon-lr', product_id: 'llmrouter', kind: 'addon' });
    expect((await f.runtime.overview(identity)).offers.map((item) => item.id)).toContain('addon-sw');
    f.state.loseResponse = true;
    const body = { accountId: f.state.account, offerId: 'addon-lr', idempotencyKey: crypto.randomUUID() };
    expect(await f.runtime.purchase(identity, body)).toMatchObject({ status: 'UNKNOWN', productId: 'llmrouter' });
    f.state.offers = [];
    expect(await f.runtime.purchase(identity, body)).toMatchObject({ status: 'UNKNOWN', productId: 'llmrouter' });
    expect(await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).toMatchObject({ status: 'APPLIED', productId: 'llmrouter' });
    expect(f.orders.size).toBe(1);
  });
  it('accepts legacy null entitlements in catalogs and historical order snapshots during recovery', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n;
    f.state.offers = [{ ...offer, entitlements: null }];
    const catalog = await f.runtime.overview(identity);
    expect(catalog.offers).toHaveLength(1);
    expect(catalog.offers[0].pricingProgram).toBeUndefined();
    expect(catalog.offers[0].purchaseReadiness).toEqual({ ready: true });
    const body = { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() };
    f.state.loseResponse = true;
    expect(await f.runtime.purchase(identity, body)).toMatchObject({ status: 'UNKNOWN' });
    expect([...f.orders.values()][0].offer.entitlements).toBeNull();
    const history = await f.runtime.overview(identity);
    expect(history.orders).toHaveLength(1);
    expect(history.orders[0]).toMatchObject({ paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED' });
    expect(await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).toMatchObject({ status: 'APPLIED' });
    expect(await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).toMatchObject({ status: 'APPLIED' });
    expect(f.orders.size).toBe(1); expect(f.state.wallet).toBe(9_000_000n);
  });
  it('still rejects malformed entitlements in catalogs and historical order snapshots', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n;
    f.state.offers = [{ ...offer, entitlements: 'invalid' }];
    await expect(f.runtime.overview(identity)).rejects.toMatchObject({ code: 'platform_response_invalid' });
    f.state.offers = [offer];
    await f.runtime.purchase(identity, { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() });
    [...f.orders.values()][0].offer = { ...offer, entitlements: [] };
    await expect(f.runtime.overview(identity)).rejects.toMatchObject({ code: 'platform_response_invalid' });
  });
  it('stores an authoritative quote then accepts it with its original amount and preserves separate fulfillment', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n; f.state.activeMembership = true;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: offer.id });
    expect(quote).toMatchObject({ accountId: 'personal-a', subscriptionId: 'sub-a', amount: '500000', additionalCredits: '1000000' });
    expect(f.orders.size).toBe(0); expect(f.state.wallet).toBe(10_000_000n);
    await f.runtime.close(); const restarted = f.create();
    const result = await restarted.acceptUpgrade(identity, { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() });
    expect(result).toMatchObject({ kind: 'upgrade', status: 'APPLIED', amount: '500000', quoteId: quote.id, subscriptionId: 'sub-a' });
    expect(f.state.wallet).toBe(9_500_000n);
    const writes = f.state.calls.filter((call) => call.route.endsWith('/accept'));
    expect(JSON.parse(writes[0].body)).toEqual({});
  });
  it('recovers an ambiguous upgrade after restart and quote expiry with the original key and one debit', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: offer.id });
    const body = { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() };
    f.state.loseResponse = true;
    expect(await f.runtime.acceptUpgrade(identity, body)).toMatchObject({ status: 'UNKNOWN' });
    await f.runtime.close(); const restarted = f.create(); f.state.now += 120_000;
    expect(await restarted.acceptUpgrade(identity, body)).toMatchObject({ status: 'UNKNOWN' });
    expect(await restarted.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).toMatchObject({ status: 'APPLIED' });
    expect(f.orders.size).toBe(1); expect(f.state.wallet).toBe(9_500_000n);
    expect(f.state.calls.filter((call) => call.route.endsWith('/accept')).map((call) => call.key)).toEqual([body.idempotencyKey, body.idempotencyKey]);
    await expect(restarted.acceptUpgrade(identity, { ...body, quoteId: 'different-quote' })).rejects.toMatchObject({ code: 'platform_idempotency_conflict' });
  });
  it('keeps paid upgrade fulfillment pending and reads its known order without another acceptance', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n; f.state.pendingFulfillment = true;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: offer.id });
    const body = { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() };
    const pending = await f.runtime.acceptUpgrade(identity, body);
    expect(pending.status).toBe('PENDING');
    expect((await f.runtime.overview(identity)).orders[0]).toMatchObject({ paymentStatus: 'PAID', fulfillmentStatus: 'PENDING' });
    f.orders.get(pending.resourceId).fulfillment_status = 'FULFILLED';
    expect(await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).toMatchObject({ status: 'APPLIED' });
    expect(f.state.calls.filter((call) => call.route.endsWith('/accept'))).toHaveLength(1);
  });
  it('releases an explicitly invalidated upgrade quote without replaying it or blocking a new purchase', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: offer.id });
    const body = { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() };
    f.state.rejectOrder = 'quote_invalidated';
    const rejection = await f.runtime.acceptUpgrade(identity, body);
    expect(rejection).toMatchObject({ kind: 'upgrade', status: 'FAILED', errorCode: 'quote_invalidated' });
    expect(await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).toEqual(rejection);
    expect(f.state.calls.filter((call) => call.route.endsWith('/accept'))).toHaveLength(1);
    expect(f.state.wallet).toBe(10_000_000n); expect(f.orders.size).toBe(0);
    f.state.rejectOrder = undefined;
    f.state.offers.push({ ...offer, id: 'addon-after-invalidated-quote', kind: 'addon' });
    expect(await f.runtime.purchase(identity, { accountId: f.state.account, offerId: 'addon-after-invalidated-quote', idempotencyKey: crypto.randomUUID() })).toMatchObject({ status: 'APPLIED' });
    expect(f.orders.size).toBe(1);
  });
  it('keeps a generic upgrade conflict uncertain and blocks a new purchase until the original is resolved', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: offer.id });
    const body = { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() };
    f.state.rejectOrder = 'conflict';
    expect(await f.runtime.acceptUpgrade(identity, body)).toMatchObject({ status: 'UNKNOWN', errorCode: 'conflict' });
    expect(await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: body.accountId })).toMatchObject({ status: 'UNKNOWN', errorCode: 'conflict' });
    await expect(f.runtime.purchase(identity, { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'platform_operation_pending' });
    expect(f.state.wallet).toBe(10_000_000n); expect(f.orders.size).toBe(0);
  });
  it('rejects new acceptance of an expired, unbound or other-owner quote before financial dispatch', async () => {
    const f = await fixture();
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: offer.id });
    const body = { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() };
    f.state.actor = 'actor-b';
    await expect(f.runtime.acceptUpgrade(identity, body)).rejects.toMatchObject({ code: 'platform_quote_unavailable' });
    f.state.actor = 'actor-a'; f.state.service = 'service-b';
    await expect(f.runtime.acceptUpgrade(identity, body)).rejects.toMatchObject({ code: 'platform_quote_unavailable' });
    f.state.service = 'service-a'; f.state.account = 'team-b';
    await expect(f.runtime.acceptUpgrade(identity, body)).rejects.toMatchObject({ code: 'platform_account_changed' });
    f.state.account = 'personal-a'; f.state.now += 120_000;
    await expect(f.runtime.acceptUpgrade(identity, body)).rejects.toMatchObject({ code: 'platform_quote_expired' });
    expect(f.state.calls.filter((call) => call.route.endsWith('/accept'))).toHaveLength(0);
  });
  it('rejects a mismatched upstream quote and preserves uncertainty after a payer changes during acceptance', async () => {
    const f = await fixture(); f.state.wallet = 10_000_000n; f.state.quoteAccount = 'other-account';
    await expect(f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: offer.id })).rejects.toMatchObject({ code: 'platform_response_invalid' });
    f.state.quoteAccount = undefined;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: offer.id });
    let release; f.state.blockPost = new Promise((resolve) => { release = resolve; });
    const accepting = f.runtime.acceptUpgrade(identity, { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() });
    while (!f.state.calls.some((call) => call.route.endsWith('/accept'))) await new Promise((resolve) => setTimeout(resolve, 1));
    f.state.service = 'service-b'; release();
    expect(await accepting).toMatchObject({ status: 'UNKNOWN', errorCode: 'platform_session_changed' });
    expect((await f.runtime.overview(identity)).intents).toEqual([]);
  });
});


it('retains catalog readiness without hiding balances/history and definitively fails only the known pre-admission rejection', async () => {
  const f = await fixture(); f.state.wallet = 10000000n;
  f.state.readiness = { ready: false, reason: 'credit_rates_unavailable' };
  const overview = await f.runtime.overview(identity);
  expect(overview.offers[0].salesReadiness).toEqual({ ready: false, reason: 'credit_rates_unavailable' });
  expect(overview.wallets[0].amount).toBe('10000000'); expect(overview.orders).toEqual([]);
  // The catalog is advisory. A stale ready response still meets the authoritative POST guard.
  f.state.readiness = { ready: true }; f.state.rejectOrder = 'credit_rates_unavailable';
  const idempotencyKey = crypto.randomUUID();
  const result = await f.runtime.purchase(identity, { accountId: 'personal-a', offerId: offer.id, idempotencyKey });
  expect(result).toMatchObject({ status: 'FAILED', errorCode: 'credit_rates_unavailable' });
  expect(result.resourceId).toBeUndefined(); expect(f.orders.size).toBe(0); expect(f.recharges.size).toBe(0);
  expect(f.state.wallet).toBe(10000000n); expect(f.state.credits).toBe(0n);
  const posts = f.state.calls.filter((call) => call.method === 'POST');
  expect(posts).toHaveLength(1); expect(posts[0].key).toBe(idempotencyKey);
  expect(await f.runtime.reconcile(identity, idempotencyKey, { accountId: 'personal-a' })).toMatchObject({ status: 'FAILED' });
  expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  f.state.rejectOrder = 'conflict';
  expect(await f.runtime.purchase(identity, { accountId: 'personal-a', offerId: offer.id, idempotencyKey: crypto.randomUUID() })).toMatchObject({ status: 'UNKNOWN', errorCode: 'conflict' });
});
