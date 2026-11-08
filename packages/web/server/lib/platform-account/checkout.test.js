import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createPlatformCommerceRuntime } from './commerce.js';
import { PlatformAccountError } from './runtime.js';
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-checkout-'));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const offer = { id: 'points', product_id: 'superwagie', name: 'Points', account_kind: 'both', kind: 'membership', period: 'month', price: '1000000', monthly_credit: '2000000', validity_months: 0, rank: 1, sandbox: false, status: 'published', entitlements: { pricing_program: 'superwagie-ai-points-v1' } };
  const state = { quoteNumber: 0, rejectQuote: false, rejectStatus: 409, failCheckoutRead: false, ready: true, configured: true, lose: true, refundLoss: false, calls: [], checkout: null, url: 'weixin://wxpay/bizpayurl?pr=test' };
  const runtime = createPlatformCommerceRuntime({ dataDir: dir, accountRuntime: { captureCommerceSession: () => ({ billingAccountId: 'acct', actingUserId: 'actor', serviceId: 'service', request: async (route, init) => {
    state.calls.push({ route, init });
    if (route === '/v1/accounts') return [{ id: 'acct', kind: 'personal', role: 'owner' }];
    if (route === '/v1/capabilities') return { product_id: 'superwagie', scopes: ['catalog:read','subscriptions:read','orders:read','orders:write'], sandbox: false, product_wallet_recharge: false, real_payments_configured: state.configured, payment_providers: ['wechat','alipay'], native_credits: { ready: state.ready } };
    if (route === '/v1/catalog') return [offer];
    if (route.endsWith('/quotes')) {
      const body = JSON.parse(init.body);
      return { id:`quote${++state.quoteNumber}`,account_id:'acct',subscription_id:body.subscription_id,subscription_version:1,offer,amount:body.payment_source === 'external' ? '510000' : '500001',original_amount:body.payment_source === 'external' ? '500001' : undefined,payment_source:body.payment_source,rounding_rule:body.payment_source === 'external' ? 'cny_cent_ceil_v1' : undefined,grant_amount:'1000000',period_start:'2026-11-01T00:00:00Z',expires_at:new Date(Date.now()+60000).toISOString(),created_at:new Date().toISOString() };
    }
    if (route.endsWith('/refund')) {
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'unihub-commerce/state.json'), 'utf8'));
      expect(Object.values(saved.intents)[0].refundKey).toBe(init.headers['Idempotency-Key']);
      state.checkout.refund_status = 'PENDING';
      if (state.refundLoss) { state.refundLoss = false; throw new PlatformAccountError('platform_unavailable',502); }
      return state.checkout;
    }
    if (route.endsWith('/subscriptions')) return [];
    if (route.endsWith('/checkouts') && init?.method === 'POST') {
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'unihub-commerce/state.json'), 'utf8'));
      expect(Object.values(saved.intents).find(item => item.idempotencyKey === init.headers['Idempotency-Key']).status).toBe('UNKNOWN');
      if (state.rejectQuote) throw new PlatformAccountError('quote_invalidated',state.rejectStatus);
      state.checkout ??= { id: 'check1', account_id: 'acct', product_id: 'superwagie', provider: 'wechat', offer_name: 'Points', amount: '1000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: new Date(Date.now()+60000).toISOString(), created_at: new Date().toISOString(), session: { kind: 'qr', url: state.url, expires_at: new Date(Date.now()+60000).toISOString() } };
      if (state.lose) { state.lose = false; throw new PlatformAccountError('platform_unavailable',502); }
      return state.checkout;
    }
    if (route.endsWith('/checkouts')) { if (state.failCheckoutRead) throw new PlatformAccountError('platform_unavailable',502); const result=state.checkout ? [structuredClone(state.checkout)] : []; if(state.checkoutReadStarted)state.checkoutReadStarted();if(state.blockCheckoutRead)await state.blockCheckoutRead;return result; }
    if (route.includes('/checkouts/check1')) return state.checkout;
    if (route.endsWith('/orders')) return [];
    throw new Error(route);
  } }) } });
  cleanup.push(() => runtime.close());
  return { runtime, state, body: { accountId:'acct', offerId:'points', provider:'wechat', idempotencyKey:crypto.randomUUID() } };
};
it('persists checkout before dispatch and recovers the original key after response loss', async () => {
  const f = await setup();
  expect((await f.runtime.createCheckout({}, f.body)).status).toBe('UNKNOWN');
  const recovered = await f.runtime.reconcile({}, f.body.idempotencyKey, { accountId:'acct' });
  expect(recovered.resourceId).toBe('check1');
  const posts = f.state.calls.filter(c => c.route.endsWith('/checkouts') && c.init?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts.map(c => c.init.headers['Idempotency-Key'])).toEqual([f.body.idempotencyKey,f.body.idempotencyKey]);
});
it('fails closed when native point readiness is false', async () => {
  const f = await setup(); f.state.ready = false;
  await expect(f.runtime.createCheckout({}, f.body)).rejects.toMatchObject({ code:'points_runtime_unavailable' });
  expect(f.state.calls.some(c => c.init?.method === 'POST')).toBe(false);
});
it('keeps an uncertain close pending until the original checkout confirms closure', async () => {
  const f = await setup(); f.state.lose = false;
  await f.runtime.createCheckout({}, f.body);
  f.state.checkout.payment_status = 'UNKNOWN';
  await f.runtime.checkoutAction({}, 'check1', 'close', { accountId: 'acct' });
  await expect(f.runtime.createCheckout({}, { ...f.body, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'platform_operation_pending' });
  expect((await f.runtime.overview({})).intents[0].status).toBe('PENDING');
  f.state.checkout.payment_status = 'CLOSED';
  await f.runtime.checkoutAction({}, 'check1', 'reconcile', { accountId: 'acct' });
  expect((await f.runtime.overview({})).intents[0]).toMatchObject({ resourceId: 'check1', status: 'FAILED', idempotencyKey: f.body.idempotencyKey });
  expect(f.state.calls.filter((call) => call.init?.method === 'POST').map((call) => call.route)).toEqual([
    '/v1/accounts/acct/checkouts', '/v1/accounts/acct/checkouts/check1/close', '/v1/accounts/acct/checkouts/check1/reconcile',
  ]);
});
it('keeps payment, fulfillment and refund state separate and rejects unsafe redirect URLs', async () => {
  const f = await setup(); f.state.lose = false;
  await f.runtime.createCheckout({}, f.body);
  f.state.checkout.payment_status = 'PAID'; f.state.checkout.fulfillment_status = 'PENDING';
  expect((await f.runtime.reconcile({}, f.body.idempotencyKey, { accountId:'acct' })).status).toBe('PENDING');
  f.state.checkout.provider = 'alipay'; f.state.checkout.session = { ...f.state.checkout.session, kind:'redirect', url:'https://evil.example/pay' };
  await expect(f.runtime.checkoutAction({}, 'check1', 'read', { accountId:'acct' })).rejects.toMatchObject({ code:'platform_response_invalid' });
});


it('requires exactly one purchase source, configured providers and an immutable original provider', async () => {
  const f=await setup();
  await expect(f.runtime.createCheckout({}, {...f.body,quoteId:'quote1'})).rejects.toMatchObject({code:'platform_request_invalid'});
  f.state.configured=false;
  await expect(f.runtime.createCheckout({},f.body)).rejects.toMatchObject({code:'payment_not_configured'});
  f.state.configured=true;f.state.lose=false;
  await f.runtime.createCheckout({},f.body);
  await expect(f.runtime.createCheckout({}, {...f.body,provider:'alipay'})).rejects.toMatchObject({code:'platform_idempotency_conflict'});
  await expect(f.runtime.createCheckout({}, {...f.body,idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'platform_operation_pending'});
});
it('persists original-channel refund key before a lost response and reuses it', async () => {
  const f=await setup();f.state.lose=false;
  await f.runtime.createCheckout({},f.body);f.state.checkout.payment_status='PAID';f.state.refundLoss=true;
  await expect(f.runtime.checkoutAction({},'check1','refund',{accountId:'acct'})).rejects.toMatchObject({code:'platform_unavailable'});
  const result=await f.runtime.checkoutAction({},'check1','refund',{accountId:'acct'});
  expect(result.refund_status).toBe('PENDING');
  const requests=f.state.calls.filter(c=>c.route.endsWith('/refund'));
  expect(requests).toHaveLength(2);expect(requests[0].init.headers['Idempotency-Key']).toBe(requests[1].init.headers['Idempotency-Key']);
  expect(f.state.calls.filter(c=>c.route.endsWith('/checkouts')&&c.init?.method==='POST')).toHaveLength(1);
});
it('binds quote funding and authoritative cent rounding in local recovery', async () => {
  const f=await setup();const quoteBody={accountId:'acct',subscriptionId:'sub1',offerId:'points'};
  const quote=await f.runtime.quoteUpgrade({}, {...quoteBody,paymentSource:'external'});
  expect(quote).toMatchObject({paymentSource:'external',originalAmount:'500001',amount:'510000',roundingRule:'cny_cent_ceil_v1'});
  await expect(f.runtime.acceptUpgrade({}, {accountId:'acct',quoteId:quote.id,idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'platform_quote_unavailable'});
  const other=await setup();const wallet=await other.runtime.quoteUpgrade({},quoteBody);
  await expect(other.runtime.createCheckout({}, {accountId:'acct',quoteId:wallet.id,provider:'wechat',idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'platform_quote_unavailable'});
});


it('releases only a conclusively rejected external upgrade and retains the original failed key', async () => {
  const f=await setup();const quote=await f.runtime.quoteUpgrade({}, {accountId:'acct',subscriptionId:'sub1',offerId:'points',paymentSource:'external'});
  const original={accountId:'acct',quoteId:quote.id,provider:'wechat',idempotencyKey:crypto.randomUUID()};f.state.rejectQuote=true;
  expect(await f.runtime.createCheckout({},original)).toMatchObject({status:'FAILED',errorCode:'quote_invalidated'});
  expect(await f.runtime.reconcile({},original.idempotencyKey,{accountId:'acct'})).toMatchObject({status:'FAILED'});
  expect(f.state.calls.filter(c=>c.route.endsWith('/checkouts')&&c.init?.method==='POST')).toHaveLength(1);
  const fresh=await f.runtime.quoteUpgrade({}, {accountId:'acct',subscriptionId:'sub1',offerId:'points',paymentSource:'external'});
  expect(fresh.id).not.toBe(quote.id);
  expect(await f.runtime.createCheckout({}, {...original,quoteId:fresh.id,idempotencyKey:crypto.randomUUID()})).toMatchObject({status:'FAILED',errorCode:'quote_invalidated'});
  const posts=f.state.calls.filter(c=>c.route.endsWith('/checkouts')&&c.init?.method==='POST');expect(posts).toHaveLength(2);expect(posts[0].init.headers['Idempotency-Key']).toBe(original.idempotencyKey);expect(posts[1].init.headers['Idempotency-Key']).not.toBe(original.idempotencyKey);
});
it('preserves unknown external quote outcomes when the rejection is not authoritative', async () => {
  const f=await setup();const quote=await f.runtime.quoteUpgrade({}, {accountId:'acct',subscriptionId:'sub1',offerId:'points',paymentSource:'external'});f.state.rejectQuote=true;f.state.rejectStatus=503;
  expect(await f.runtime.createCheckout({}, {accountId:'acct',quoteId:quote.id,provider:'wechat',idempotencyKey:crypto.randomUUID()})).toMatchObject({status:'UNKNOWN'});
  await expect(f.runtime.createCheckout({},f.body)).rejects.toMatchObject({code:'platform_operation_pending'});
});
it('syncs a matched paid checkout into local recovery before allowing a new purchase', async () => {
  const f=await setup();f.state.lose=false;await f.runtime.createCheckout({},f.body);
  f.state.checkout.payment_status='PAID';f.state.checkout.fulfillment_status='FULFILLED';
  const overview=await f.runtime.overview({});expect(overview.intents[0].status).toBe('APPLIED');
  const result=await f.runtime.createCheckout({}, {...f.body,idempotencyKey:crypto.randomUUID()});expect(result.status).toBe('APPLIED');
});
it('does not release pending recovery after a failed or mismatched authoritative checkout read', async () => {
  const f=await setup();f.state.lose=false;await f.runtime.createCheckout({},f.body);f.state.checkout.payment_status='PAID';f.state.checkout.fulfillment_status='FULFILLED';f.state.failCheckoutRead=true;
  await expect(f.runtime.overview({})).rejects.toMatchObject({code:'platform_unavailable'});
  await expect(f.runtime.createCheckout({}, {...f.body,idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'platform_operation_pending'});
  f.state.failCheckoutRead=false;f.state.checkout.amount='2000000';
  await expect(f.runtime.overview({})).rejects.toMatchObject({code:'platform_response_invalid'});
  await expect(f.runtime.createCheckout({}, {...f.body,idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'platform_operation_pending'});
});


it('preserves newer refund recovery when an older checkout list finishes afterward', async () => {
  const f=await setup();f.state.lose=false;await f.runtime.createCheckout({},f.body);f.state.checkout.payment_status='PAID';f.state.checkout.fulfillment_status='FULFILLED';
  let release;f.state.blockCheckoutRead=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{f.state.checkoutReadStarted=resolve;});
  const overview=f.runtime.overview({});await started;
  await f.runtime.checkoutAction({},'check1','refund',{accountId:'acct'});release();
  expect((await overview).intents[0].status).toBe('PENDING');
  await expect(f.runtime.createCheckout({}, {...f.body,idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'platform_operation_pending'});
});
it('does not infer the resource of an unknown create from a completed checkout list', async () => {
  const f=await setup();expect((await f.runtime.createCheckout({},f.body)).status).toBe('UNKNOWN');f.state.checkout.payment_status='PAID';f.state.checkout.fulfillment_status='FULFILLED';
  expect((await f.runtime.overview({})).intents[0].status).toBe('UNKNOWN');
  await expect(f.runtime.createCheckout({}, {...f.body,idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'platform_operation_pending'});
});
