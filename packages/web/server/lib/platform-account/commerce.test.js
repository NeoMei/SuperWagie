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
  const cashCheckouts = new Map();
  const checkoutRecords = new Map();
  const orders = new Map(); const quotes = new Map(); const byKey = new Map();
  const upstream = async (route, init = {}) => {
    state.calls.push({ walletVersion: init.headers?.['X-UniHub-Product-Credit-Wallet'], netUpgrade: init.headers?.['X-UniHub-Legacy-Net-Upgrade'], route, method: init.method ?? 'GET', body: init.body, key: init.headers?.['Idempotency-Key'] });
    if (route === '/v1/accounts') return [{ id: state.account, kind: 'personal', role: state.role }];
    if (route === '/v1/capabilities') return { product_id: 'superwagie', scopes: state.scopes, product_credit_wallet: state.productCreditWallet, sandbox: state.sandbox, product_wallet_recharge: state.sandbox, real_payments_configured: state.cashPayments ?? false, payment_providers: state.cashPayments ? ['wechat'] : [], native_credits: { ready: state.creditsReady } };
    if (route.endsWith('/product-wallet') || route.endsWith('/product-wallet/superwagie/renewal')) return { version: 'product_v1', account_id: state.account, cash: { asset: 'CNY/6', available: String(state.wallet) }, can_manage: true, products: [{ product_id: 'superwagie', name: 'SuperWagie', subscription_renewal: { enabled: false, version: 0 }, addon_renewal: { enabled: false, version: 1 }, orders: [], addon_offers: [] }, ...(state.otherWalletProducts ?? [])] };
    if (route === '/v1/catalog') return [...state.offers, sandboxOffer].map((item) => ({ ...item, sales_readiness: item.sandbox ? undefined : { ready: true } }));
    if (route.endsWith('/resources')) {
      if (state.failRead) throw new PlatformAccountError('service_unavailable', 503);
      return { account_id: state.account, wallets: [{ product_id: 'superwagie', asset: 'CNY/6', amount: String(state.wallet) }], as_of: new Date().toISOString() };
    }
    if (route.endsWith('/subscriptions')) return state.activeMembership ? [{ product_id: 'superwagie', status: 'active', paid_through: new Date(Date.now() + 3600000).toISOString() }] : [];
    if (route.endsWith('/cash-checkouts') && !init.method) return [...cashCheckouts.values()];
    if (route.endsWith('/cash-checkouts') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      expect(init.headers['X-UniHub-Product-Credit-Wallet']).toBe('product_v1');
      expect(body.product_id).toBe('superwagie');
      const created = { id: 'ct_one', account_id: state.account, product_id: body.product_id, wallet_target: 'unified', provider: body.provider, amount: body.amount, currency: 'CNY', payment_status: 'CREATED', expires_at: new Date(state.now + 60_000).toISOString(), created_at: new Date(state.now).toISOString() };
      cashCheckouts.set(created.id, created);
      return created;
    }
    if (route.endsWith('/cash-checkouts/ct_one/reconcile')) {
      const pending = cashCheckouts.get('ct_one');
      const paid = { ...pending, payment_status: 'PAID', credit_status: 'APPLIED' };
      cashCheckouts.set(paid.id, paid);
      return paid;
    }
    if (route.endsWith('/orders') && !init.method) return [...orders.values()];
    if (route.endsWith('/checkouts') && !init.method) return [...checkoutRecords.values()];
    if (route.endsWith('/checkouts/co-old') && !init.method) {
      return { id: 'co-old', account_id: state.account, product_id: 'superwagie', provider: 'wechat', offer_name: 'Previous plan',
        amount: membership.price, currency: 'CNY', payment_status: 'PAID', fulfillment_status: 'FULFILLED', refund_status: '',
        expires_at: new Date(state.now + 60_000).toISOString(), created_at: new Date(state.now).toISOString(),
        upgrade_return_status: 'UPGRADE_RETURNED', upgrade_refund_amount: '200000' };
    }
    if (route.endsWith('/checkouts/co-upgrade/reconcile')) {
      const pending = checkoutRecords.get('co-upgrade');
      const paid = { ...pending, payment_status: 'PAID', fulfillment_status: 'FULFILLED' };
      checkoutRecords.set(paid.id, paid);
      return paid;
    }
    if (route.endsWith('/quotes') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const selected = state.offers.find((item) => item.id === body.offer_id);
      const result = { id: `quote-${quotes.size}`, account_id: state.quoteAccount ?? state.account, subscription_id: body.subscription_id, subscription_version: 1, offer: selected, amount: '500000', grant_amount: '1000000', period_start: new Date(state.now - 1000).toISOString(), expires_at: new Date(state.now + 60_000).toISOString(), created_at: new Date(state.now).toISOString() };
      if (state.productCreditWallet && selected.credit_scope === 'product_v1') {
        result.amount = selected.price;
        result.grant_amount = selected.monthly_credit;
        result.product_credit_upgrade = { previous_subscription_id: body.subscription_id, previous_order_id: 'order-old',
          previous_version: 1, estimated_refund_amount: '200000', refund_payment_source: 'wallet' };
        if (body.payment_source === 'external') Object.assign(result, {
          payment_source: 'external', original_amount: selected.price, rounding_rule: 'cny_cent_ceil_v1',
        });
        if (state.netUpgrade) {
          result.amount = state.netUpgrade.amount;
          if (body.payment_source === 'external') result.original_amount = state.netUpgrade.originalAmount ?? state.netUpgrade.amount;
          result.product_credit_upgrade.applied_credit_amount = state.netUpgrade.appliedCreditAmount;
          result.product_credit_upgrade.estimated_refund_amount = state.netUpgrade.estimatedRefundAmount ?? '0';
        }
      }
      quotes.set(result.id, result); return result;
    }
    if (init.method === 'POST') {
      const journal = JSON.parse(await fs.readFile(path.join(directory, 'unihub-commerce/state.json'), 'utf8'));
      const saved = Object.values(journal.intents).find((intent) => intent.idempotencyKey === init.headers['Idempotency-Key']);
      expect(saved.status).toBe('UNKNOWN');
      if (state.blockPost) await state.blockPost;
      const old = byKey.get(init.headers['Idempotency-Key']);
      if (old) return structuredClone(old);
      if (route.endsWith('/checkouts')) {
        const { quote_id, provider } = JSON.parse(init.body);
        const quote = quotes.get(quote_id);
        const checkout = { id: 'co-upgrade', account_id: state.account, product_id: 'superwagie', provider,
          offer_name: quote.offer.name, subscription_id: 'sub-new', amount: quote.amount, currency: 'CNY',
          payment_status: 'CREATED', fulfillment_status: 'NOT_STARTED', refund_status: '',
          expires_at: quote.expires_at, created_at: quote.created_at, product_credit_upgrade: quote.product_credit_upgrade };
        checkoutRecords.set(checkout.id, checkout);
        byKey.set(init.headers['Idempotency-Key'], checkout);
        return checkout;
      }
      if (!route.endsWith('/orders') && !route.endsWith('/accept')) throw new Error(`Unexpected POST ${route}`);
      if (state.rejectOrder) throw new PlatformAccountError(state.rejectOrder, state.rejectOrder === 'insufficient_funds' ? 402 : 409);
      const quote = route.endsWith('/accept') ? quotes.get(route.split('/').at(-2)) : null;
      const selected = quote?.offer ?? state.offers.find((item) => item.id === JSON.parse(init.body).offer_id);
      const amount = quote?.amount ?? selected.price;
      if (state.wallet < BigInt(amount)) throw new PlatformAccountError('insufficient_funds', 402);
      state.wallet -= BigInt(amount); state.credits += BigInt(quote?.grant_amount ?? selected.monthly_credit);
      const result = { id: `order-${orders.size}`, account_id: state.account, actor_id: state.actor, product_id: selected.product_id, offer: selected, amount, payment_status: 'PAID', fulfillment_status: state.pendingFulfillment ? 'PENDING' : 'FULFILLED' };
      if (quote) {
        result.kind = 'upgrade';
        result.subscription_id = quote.product_credit_upgrade && !state.wrongSubscription ? 'sub-new' : quote.subscription_id;
        result.product_credit_upgrade = quote.product_credit_upgrade;
      }
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
  return { directory, state, orders, quotes, cashCheckouts, checkoutRecords, runtime: create(), create };
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

  it('shows only versioned SuperWagie plans and shared cash when the wallet is enabled', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.failRead = true;
    f.state.offers.push({ ...addon, id: 'router-addon', product_id: 'llmrouter' }, { ...addon, id: 'own-addon', credit_scope: 'product_v1' });
    const view = await f.runtime.overview(identity);
    expect(view.offers.map((item) => item.id)).toEqual(['own-addon']);
    expect(view.productWallet.cash).toEqual({ asset: 'CNY/6', available: '10000000' });
    expect(view.wallets).toEqual([{ productId: '', asset: 'CNY/6', amount: '10000000' }]);
    expect(f.state.calls).toContainEqual(expect.objectContaining({ route: '/v1/capabilities', walletVersion: 'product_v1' }));
    await expect(f.runtime.purchase(identity, purchaseBody(f, 'router-addon'))).rejects.toMatchObject({ code: 'platform_offer_unavailable' });
  });

  it('replays one shared cash top-up and reconciles its original payment', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.cashPayments = true;
    f.state.scopes.push('recharges:read', 'recharges:write');
    const body = { accountId: f.state.account, provider: 'wechat', amount: '10000000', idempotencyKey: crypto.randomUUID() };
    const first = await f.runtime.createCheckout(identity, body);
    expect(first).toMatchObject({ status: 'PENDING', walletTopUp: true, resourceId: 'ct_one', checkout: { walletTopUp: true } });
    const replayed = await f.runtime.createCheckout(identity, body);
    expect(replayed.resourceId).toBe(first.resourceId);
    const paid = await f.runtime.checkoutAction(identity, 'ct_one', 'reconcile', { accountId: f.state.account });
    expect(paid).toMatchObject({ payment_status: 'PAID', fulfillment_status: 'FULFILLED', walletTopUp: true });
    const state = await f.runtime.overview(identity);
    expect(state.intents).toContainEqual(expect.objectContaining({ resourceId: 'ct_one', status: 'APPLIED' }));
    expect(f.state.calls.filter((call) => call.method === 'POST' && call.route.endsWith('/cash-checkouts'))).toHaveLength(1);
  });

  it('keeps reported wallet orders and renewal settings available with other products in checkout history', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.cashPayments = true;
    f.state.scopes.push('recharges:read');
    const common = { account_id: f.state.account, provider: 'wechat', amount: '10000000', currency: 'CNY',
      created_at: new Date(f.state.now).toISOString(), expires_at: new Date(f.state.now + 60_000).toISOString() };
    f.cashCheckouts.set('ct_other', { ...common, id: 'ct_other', product_id: 'agentwiki', wallet_target: 'unified', payment_status: 'PENDING' });
    f.cashCheckouts.set('ct_own', { ...common, id: 'ct_own', product_id: 'superwagie', wallet_target: 'unified', payment_status: 'PAID', credit_status: 'APPLIED' });
    f.checkoutRecords.set('co-other', { ...common, id: 'co-other', product_id: 'agentwiki', offer_name: 'AgentWiki Monthly', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED' });
    f.checkoutRecords.set('co-own', { ...common, id: 'co-own', product_id: 'superwagie', offer_name: 'SuperWagie Monthly', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED' });
    f.checkoutRecords.set('co-legacy', { ...common, id: 'co-legacy', product_id: 'llmrouter', offer_name: 'LLMRouter Add-on', payment_status: 'PAID', fulfillment_status: 'FULFILLED' });
    const subscriptionRenewal = { enabled: true, version: 2, price: common.amount };
    const orders = [{ id: 'order-other', offer_name: 'AgentWiki Monthly', amount: common.amount,
      payment_status: 'PAID', fulfillment_status: 'FULFILLED', refund_status: '', created_at: common.created_at }];
    f.state.otherWalletProducts = [{ product_id: 'agentwiki', name: 'AgentWiki', subscription_renewal: subscriptionRenewal,
      addon_renewal: { enabled: false, version: 0 }, orders, addon_offers: [] }];

    const overview = await f.runtime.overview(identity);
    expect(overview.checkouts.map(({ id }) => id)).toEqual(['co-own', 'co-legacy', 'ct_own']);
    expect(overview.productWallet.products.find((product) => product.product_id === 'agentwiki')).toMatchObject({
      subscription_renewal: subscriptionRenewal, orders,
    });
  });

  it('writes renewal settings with the authorized selected account and expected version', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.scopes.push('settings:write');
    const app = express();
    registerPlatformCommerceRoutes(app, { runtime: f.runtime, resolveIdentity: () => identity, isRequestOriginAllowed: (req) => req.get('Origin') === 'https://runtime.test' });
    const path = '/api/platform-account/commerce/product-wallet/superwagie/renewal';
    const body = { accountId: 'personal-a', kind: 'addon', enabled: true, expectedVersion: 1, offerId: 'own-addon', trigger: 'threshold', threshold: '250000' };
    await request(app).put(path).send(body).expect(403);
    await request(app).put(path).set('Origin', 'https://runtime.test').send(body).expect(200);
    expect(f.state.calls).toContainEqual(expect.objectContaining({ route: '/v1/accounts/personal-a/product-wallet/superwagie/renewal', method: 'PUT', walletVersion: 'product_v1', body: JSON.stringify({ kind: 'addon', enabled: true, expected_version: 1, offer_id: 'own-addon', trigger: 'threshold', threshold: '250000' }) }));
    await request(app).put(path).set('Origin', 'https://runtime.test').send({ ...body, accountId: 'team-a' }).expect(409);
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

  it('keeps a purchased order and legacy receipt readable after dead-owner recovery and a restart', async () => {
    const f = await fixture();
    const body = purchaseBody(f);
    await f.runtime.purchase(identity, body);
    await f.runtime.close();
    const journalPath = path.join(f.directory, 'unihub-commerce/state.json');
    const before = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    const legacy = Object.values(before.intents)[0];
    expect(legacy.status).toBe('APPLIED');
    legacy.operationId = 'operation-a';
    await fs.writeFile(journalPath, JSON.stringify(before));
    const lockPath = path.join(f.directory, 'unihub-commerce/writer.lock');
    await fs.writeFile(lockPath, `999999999:${crypto.randomUUID()}`);
    const restarted = f.create();
    const app = express();
    registerPlatformCommerceRoutes(app, { runtime: restarted, resolveIdentity: () => identity, isRequestOriginAllowed: () => true });
    const view = await request(app).get('/api/platform-account/commerce').expect(200);
    expect(view.body.orders).toEqual([expect.objectContaining({ amount: membership.price, paymentStatus: 'PAID' })]);
    expect(view.body.intents).toEqual([expect.objectContaining({ idempotencyKey: body.idempotencyKey, status: 'APPLIED' })]);
    expect(view.body.intents[0].operationId).toBeUndefined();
    expect(f.state.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    await restarted.close();
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8')).intents[Object.keys(before.intents)[0]].operationId).toBe('operation-a');
  });

  it('quotes and accepts an upgrade with the original amount', async () => {
    const f = await fixture(); f.state.activeMembership = true; f.state.wallet = 10_000_000n;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: membership.id });
    expect(quote).toMatchObject({ amount: '500000', additionalCredits: '1000000' });
    const result = await f.runtime.acceptUpgrade(identity, { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() });
    expect(result).toMatchObject({ kind: 'upgrade', status: 'APPLIED' });
    expect(f.state.wallet).toBe(9_500_000n); expect(f.state.credits).toBe(1_000_000n);
    expect(f.state.calls.some(call => call.netUpgrade !== undefined)).toBe(false);
  });

  it('accepts and replays a reset upgrade against the new subscription and original order', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.offers = [{ ...membership, credit_scope: 'product_v1' }];
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: membership.id });
    expect(quote).toMatchObject({ amount: membership.price, additionalCredits: membership.monthly_credit,
      productCreditUpgrade: { previousOrderId: 'order-old', estimatedRefundAmount: '200000', refundPaymentSource: 'wallet' } });
    const body = { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() };
    f.state.loseResponse = true;
    const unknown = await f.runtime.acceptUpgrade(identity, body);
    expect(unknown.status).toBe('UNKNOWN');
    const applied = await f.runtime.reconcile(identity, body.idempotencyKey, { accountId: f.state.account });
    expect(applied).toMatchObject({ status: 'APPLIED', resourceId: 'order-0' });
    expect(f.orders.get(applied.resourceId).subscription_id).toBe('sub-new');
    expect(f.state.wallet).toBe(9_000_000n);
  });

  it('keeps one original external checkout for a reset upgrade and reconciles its new subscription', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.cashPayments = true;
    f.state.offers = [{ ...membership, credit_scope: 'product_v1' }];
    const accountId = f.state.account;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId, subscriptionId: 'sub-a', offerId: membership.id, paymentSource: 'external' });
    expect(quote).toMatchObject({ amount: membership.price, originalAmount: membership.price, paymentSource: 'external' });
    const body = { accountId, quoteId: quote.id, provider: 'wechat', idempotencyKey: crypto.randomUUID() };
    const first = await f.runtime.createCheckout(identity, body);
    expect(first).toMatchObject({ status: 'PENDING', resourceId: 'co-upgrade', checkout: { subscription_id: 'sub-new' } });
    expect((await f.runtime.createCheckout(identity, body)).resourceId).toBe(first.resourceId);
    const after = await f.runtime.checkoutAction(identity, first.resourceId, 'reconcile', { accountId });
    expect(after).toMatchObject({ payment_status: 'PAID', product_credit_upgrade: { previous_subscription_id: 'sub-a', previous_order_id: 'order-old' } });
    expect(f.state.calls.filter((call) => call.method === 'POST' && call.route.endsWith('/checkouts'))).toHaveLength(1);
  });

  it('negotiates a product-wallet upgrade quote that pays only the net amount', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.cashPayments = true;
    f.state.offers = [{ ...membership, credit_scope: 'product_v1' }];
    f.state.netUpgrade = { amount: '700000', originalAmount: '699999', appliedCreditAmount: '300000' };
    const accountId = f.state.account;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId, subscriptionId: 'sub-a', offerId: membership.id, paymentSource: 'external' });
    expect(quote).toMatchObject({ offer: { price: '1000000' }, amount: '700000', originalAmount: '699999',
      productCreditUpgrade: { previousOrderId: 'order-old', estimatedRefundAmount: '0', appliedCreditAmount: '300000' } });
    const checkout = await f.runtime.createCheckout(identity, { accountId, quoteId: quote.id, provider: 'wechat', idempotencyKey: crypto.randomUUID() });
    expect(checkout).toMatchObject({ amount: '700000', checkout: { amount: '700000', product_credit_upgrade: { applied_credit_amount: '300000' } } });
    expect(f.state.calls.filter(call => call.netUpgrade !== undefined)).toEqual([
      expect.objectContaining({ route: `/v1/accounts/${accountId}/quotes`, method: 'POST', walletVersion: 'product_v1', netUpgrade: '1' }),
      expect.objectContaining({ route: `/v1/accounts/${accountId}/checkouts`, method: 'POST', walletVersion: 'product_v1', netUpgrade: '1' }),
    ]);
  });

  it('binds a net upgrade to its original wallet acceptance and replays with the same capability', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.offers = [{ ...membership, credit_scope: 'product_v1' }];
    f.state.netUpgrade = { amount: '695001', appliedCreditAmount: '304999' };
    const accountId = f.state.account;
    const quote = await f.runtime.quoteUpgrade(identity, { accountId, subscriptionId: 'sub-a', offerId: membership.id });
    const key = crypto.randomUUID();
    f.state.loseResponse = true;
    const unknown = await f.runtime.acceptUpgrade(identity, { accountId, quoteId: quote.id, idempotencyKey: key });
    expect(unknown).toMatchObject({ amount: '695001', status: 'UNKNOWN' });
    expect(await f.runtime.reconcile(identity, key, { accountId })).toMatchObject({ amount: '695001', status: 'APPLIED' });
    expect(f.state.calls.filter(call => call.route.endsWith(`/quotes/${quote.id}/accept`))).toEqual([
      expect.objectContaining({ method: 'POST', key, walletVersion: 'product_v1', netUpgrade: '1' }),
      expect.objectContaining({ method: 'POST', key, walletVersion: 'product_v1', netUpgrade: '1' }),
    ]);
    expect(f.state.wallet).toBe(9_304_999n);
  });

  it.each([
    { amount: '0', appliedCreditAmount: '1000000' },
    { amount: '700000', appliedCreditAmount: '200000' },
    { amount: '700000', appliedCreditAmount: '300000', estimatedRefundAmount: '100000' },
  ])('rejects an invalid net upgrade quote %j', async (netUpgrade) => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.offers = [{ ...membership, credit_scope: 'product_v1' }];
    f.state.netUpgrade = netUpgrade;
    await expect(f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: membership.id })).rejects.toMatchObject({ code: 'platform_response_invalid', status: 502 });
  });

  it('refuses a second refund when the old payment already has an upgrade return', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    const accountId = f.state.account;
    const existing = await f.runtime.checkoutAction(identity, 'co-old', 'read', { accountId });
    expect(existing).toMatchObject({ upgrade_return_status: 'UPGRADE_RETURNED', upgrade_refund_amount: '200000' });
    await expect(f.runtime.checkoutAction(identity, 'co-old', 'refund', { accountId })).rejects.toMatchObject({ code: 'platform_upgrade_return_managed', status: 409 });
    expect(f.state.calls.filter((call) => call.method === 'POST' && call.route.endsWith('/refund'))).toHaveLength(0);
  });

  it('rejects a fulfilled reset order that points at the original subscription', async () => {
    const f = await fixture();
    f.state.productCreditWallet = true;
    f.state.wrongSubscription = true;
    f.state.offers = [{ ...membership, credit_scope: 'product_v1' }];
    const quote = await f.runtime.quoteUpgrade(identity, { accountId: f.state.account, subscriptionId: 'sub-a', offerId: membership.id });
    const result = await f.runtime.acceptUpgrade(identity, { accountId: f.state.account, quoteId: quote.id, idempotencyKey: crypto.randomUUID() });
    expect(result).toMatchObject({ status: 'UNKNOWN', errorCode: 'platform_response_invalid' });
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
