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
  const state = { actor: 'actor-a', account: 'personal-a', service: 'service-a', role: 'owner', scopes: [...scopes], sandbox: true, failRead: false, loseResponse: false, blockPost: null, calls: [], wallet: 0n, credits: 0n };
  const recharges = new Map(); const orders = new Map(); const operations = new Map();
  const byKey = new Map();
  const upstream = async (route, init = {}) => {
    state.calls.push({ route, method: init.method ?? 'GET', body: init.body, key: init.headers?.['Idempotency-Key'] });
    if (route === '/v1/accounts') return [{ id: state.account, kind: 'personal', role: state.role }];
    if (route === '/v1/capabilities') return { product_id: 'superwagie', scopes: state.scopes, sandbox: state.sandbox, product_wallet_recharge: state.sandbox, real_payments_configured: false };
    if (route === '/v1/catalog') return [offer, { ...offer, id: 'other-account', account_kind: 'team' }, { ...offer, id: 'formal', sandbox: false }];
    if (route.endsWith('/resources')) {
      if (state.failRead) throw new PlatformAccountError('service_unavailable', 503);
      return { account_id: state.account, wallets: [{ product_id: 'superwagie', asset: 'CNY/6', amount: String(state.wallet) }], as_of: new Date().toISOString() };
    }
    if (route.endsWith('/subscriptions')) return state.activeMembership ? [{ product_id: 'superwagie', status: 'active', paid_through: new Date(Date.now() + 3600000).toISOString() }] : [];
    if (route.endsWith('/orders') && !init.method) return [...orders.values()];
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
      } else if (route.endsWith('/orders')) {
        if (state.wallet < BigInt(offer.price)) throw new PlatformAccountError('insufficient_funds', 402);
        state.wallet -= BigInt(offer.price); state.credits += BigInt(offer.monthly_credit);
        result = { id: `order-${orders.size}`, account_id: state.account, actor_id: state.actor, product_id: 'superwagie', offer, amount: offer.price, payment_status: 'PAID', fulfillment_status: 'FULFILLED' };
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
    const account = state.account; const actor = state.actor;
    return { actingUserId: actor, billingAccountId: account, serviceId: state.service, request: async (route, init) => {
      if (state.actor !== actor || state.account !== account) throw new PlatformAccountError('platform_session_changed', 409);
      return upstream(route, init);
    } };
  } };
  const create = () => {
    const runtime = createPlatformCommerceRuntime({ accountRuntime, dataDir: directory });
    cleanups.push(() => runtime.close());
    return runtime;
  };
  return { directory, state, recharges, orders, runtime: create(), create, recharge: (amount = '10000000') => ({ accountId: state.account, productId: 'superwagie', amount, idempotencyKey: crypto.randomUUID() }) };
};

describe('UniHub sandbox commerce', () => {
  it('keeps recharge, explicit sandbox settlement, purchase and fulfillment separate', async () => {
    const f = await fixture();
    const body = f.recharge();
    const intent = await f.runtime.createRecharge(identity, body);
    expect(intent.status).toBe('PENDING'); expect(f.state.wallet).toBe(0n);
    const overview = await f.runtime.overview(identity);
    expect(overview.offers.map((item) => item.id)).toEqual(['sandbox-membership']);
    expect(overview.payments).toEqual({ mode: 'sandbox', canRecharge: true, canPurchase: true });
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
  it('rejects non-sandbox payments and formal offers', async () => {
    const f = await fixture(); f.state.sandbox = false;
    expect((await f.runtime.overview(identity)).payments).toEqual({ mode: 'unconfigured', canRecharge: false, canPurchase: false });
    await expect(f.runtime.createRecharge(identity, f.recharge())).rejects.toMatchObject({ code: 'payment_not_configured' });
    await expect(f.runtime.purchase(identity, { accountId: f.state.account, offerId: offer.id, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'payment_not_configured' });
    f.state.sandbox = true;
    await expect(f.runtime.purchase(identity, { accountId: f.state.account, offerId: 'formal', idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'platform_offer_unavailable' });
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
});
