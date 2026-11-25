import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { PlatformCommerceState, PlatformUpgradeQuote, PlatformCommerceIntent } from '@/lib/platformCommerce';
import type { PlatformAccountState } from '@/lib/platformAccount';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, Element: browser.Element, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent, KeyboardEvent: browser.KeyboardEvent, DocumentFragment: browser.DocumentFragment, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true })) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const commerce: PlatformCommerceState = {
  accountId: 'team-a', role: 'owner', financialAccess: true, missingScopes: [],
  payments: { mode: 'external', canPurchase: true, providers: ['wechat', 'alipay'] },
  wallets: [{ productId: '', asset: 'CNY/6', amount: '1234567' }, { productId: 'superwagie', asset: 'CNY/6', amount: '30000000' }, { productId: 'llmrouter', asset: 'CNY/6', amount: '86400000' }, { productId: 'other-service', asset: 'CNY/6', amount: '999999000000' }],
  offers: [
    { id: 'addon-a', productId: 'llmrouter', name: 'llmrouter add-on', accountKind: 'both', kind: 'addon', period: 'once', price: '10000000', monthlyCredit: '20000000', validityMonths: 12, rank: 1, sandbox: false },
    { id: 'other-addon', productId: 'other-service', name: 'Other service add-on', accountKind: 'both', kind: 'addon', period: 'once', price: '10000000', monthlyCredit: '20000000', validityMonths: 12, rank: 1, sandbox: false },
    { id: 'membership-a', productId: 'superwagie', name: 'SuperWagie Plus', accountKind: 'both', kind: 'membership', period: 'month', price: '10000000', monthlyCredit: '20000000', validityMonths: 1, rank: 1, sandbox: false },
    { id: 'other-membership', productId: 'llmrouter', name: 'llmrouter membership', accountKind: 'both', kind: 'membership', period: 'month', price: '10000000', monthlyCredit: '20000000', validityMonths: 1, rank: 1, sandbox: false },
  ],
  orders: [
    { id: 'order-a', productId: 'superwagie', offerName: 'Previous membership', amount: '30000000', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refundStatus: '' },
    { id: 'order-addon', productId: 'llmrouter', offerName: 'llmrouter add-on order', amount: '10000000', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refundStatus: '' },
    { id: 'order-other', productId: 'other-service', offerName: 'Other service order', amount: '999999000000', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refundStatus: '' },
  ],
  checkouts: [], intents: [],
};
let writes = 0;
let accountRefreshes = 0;
const initialCommerce = structuredClone(commerce);
const mutations: Array<{ path: string; body: string }> = [];
/** Provider reconciliation is a status query, not a financial command. */
const paymentMutations = () => mutations.filter((item) => !/(intents|checkouts)\/[^/]+\/reconcile$/.test(item.path));
let activeMembership = true;
let currentMembership: Extract<PlatformAccountState, { status: 'signed-in' }>['membership'][number] | undefined;
let upgradeQuote: PlatformUpgradeQuote | undefined;
let loseUpgradeResponse = false;
let upgradeRejection: 'failed' | 'http' | 'conflict' | null = null;
let commerceReadFailures = 0;
let commerceReads = 0;
let purchaseFailure: 'operation' | 'read' | null = null;
let checkoutActionFailure: 'operation' | 'read' | null = null;
let paymentMutationsBeforePurchase = 0;
let checkoutCloseStatus = 'CLOSED';
let omitClosedFromSummary = false;
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const target = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
  const { pathname } = target;
  const path = pathname + target.search;
  if (init?.method && init.method !== 'GET') { writes++; mutations.push({ path, body: String(init.body) }); }
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (pathname === '/api/platform-account/commerce/orders' && method === 'GET') return Response.json(commerce.orders ?? []);
  if (pathname === '/api/platform-account/commerce' && method === 'GET') {
    commerceReads++;
    if (commerceReadFailures > 0 || purchaseFailure === 'read' && paymentMutations().length > paymentMutationsBeforePurchase || checkoutActionFailure === 'read' && mutations.some((item) => item.path.endsWith('/waiting-checkout/reconcile'))) {
      commerceReadFailures--;
      return Response.json({ error: 'platform_commerce_unavailable' }, { status: 503 });
    }
    const checkouts = omitClosedFromSummary ? commerce.checkouts?.filter((checkout) => checkout.payment_status !== 'CLOSED') : commerce.checkouts;
    return Response.json({ ...commerce, checkouts });
  }
  if (purchaseFailure === 'operation' && (path.endsWith('/purchases') || path.endsWith('/checkouts') || path.endsWith('/upgrade-purchases'))) return Response.json({ error: 'platform_unavailable' }, { status: 503 });
  if (checkoutActionFailure === 'operation' && path.includes('/waiting-checkout/')) return Response.json({ error: 'platform_unavailable' }, { status: 503 });
  const waitingCheckout = commerce.checkouts?.find((item) => item.id === 'waiting-checkout');
  if (waitingCheckout && path.includes('/waiting-checkout/') && path.endsWith('/reconcile')) return Response.json(waitingCheckout);
  if (waitingCheckout && path.includes('/waiting-checkout/') && path.endsWith('/close')) return Response.json({ ...waitingCheckout, payment_status: checkoutCloseStatus, fulfillment_status: checkoutCloseStatus === 'PAID' ? 'FULFILLED' : waitingCheckout.fulfillment_status });
  if (method === 'GET' && (path.includes('/usage/') || path.includes('/activity'))) return Response.json({ error: 'not_found' }, { status: 404 });
  if (path.endsWith('/checkouts')) {
    const body = JSON.parse(String(init?.body));
    const rejection = upgradeRejection; upgradeRejection = null;
    if (rejection === 'http' || rejection === 'conflict') return Response.json({ error: rejection === 'http' ? 'quote_invalidated' : 'conflict' }, { status: 409 });
    const result: PlatformCommerceIntent = { ...body, kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: '10000000', status: rejection === 'failed' ? 'FAILED' : 'UNKNOWN', errorCode: rejection === 'failed' ? 'quote_invalidated' : undefined, createdAt: '2026-11-08T00:00:00Z' };
    commerce.intents.push(result); return Response.json(result);
  }
  if (path.endsWith('/upgrade-quotes') && upgradeQuote) return Response.json(upgradeQuote);
  if (path.endsWith('/upgrade-purchases') && upgradeQuote) {
    if (loseUpgradeResponse) { loseUpgradeResponse = false; throw new TypeError('Lost upgrade response'); }
    const rejection = upgradeRejection; upgradeRejection = null;
    if (rejection === 'http' || rejection === 'conflict') return Response.json({ error: rejection === 'http' ? 'quote_invalidated' : 'conflict' }, { status: 409 });
    const result: PlatformCommerceIntent = { idempotencyKey: 'upgrade-result', kind: 'upgrade', accountId: 'team-a', productId: 'superwagie', amount: upgradeQuote.amount, quoteId: upgradeQuote.id, subscriptionId: upgradeQuote.subscriptionId, status: 'APPLIED', createdAt: '2026-11-08T00:00:00Z' };
    if (rejection === 'failed') { result.status = 'FAILED'; result.errorCode = 'quote_invalidated'; commerce.intents.push(result); }
    return Response.json(result);
  }
  return Response.json(commerce);
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { PlatformAccountCommerce } = await import('./PlatformAccountCommerce');
const { PlatformMembershipSummary } = await import('./PlatformMembershipSummary');
const { preparePlatformAccountTarget, usePlatformAccountTabStore } = await import('./platformAccountTabs');
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const render = async (view: 'overview' | 'orders') => {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><PlatformAccountCommerce accountId="team-a" payer="Team A" view={view} hasActiveMembership={activeMembership} currentMembership={currentMembership} membershipSummary={({ openMembership, openAddon, membershipOpen, addonOpen, disabled }) => <><p>Current membership</p><button type="button" disabled={disabled} aria-pressed={membershipOpen} onClick={openMembership}>Subscribe</button><button type="button" disabled={disabled} aria-pressed={addonOpen} onClick={openAddon}>Buy extra credits</button></>} onAccountRefresh={() => { accountRefreshes++; }} /></I18nProvider>));
};
const button = (text: string) => {
  const found = [...(host?.querySelectorAll('button') ?? [])].find(item => item.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined;
  writes = 0; accountRefreshes = 0; mutations.length = 0; Object.assign(commerce, structuredClone(initialCommerce)); delete commerce.productCreditWallet; activeMembership = true; currentMembership = undefined; upgradeQuote = undefined; loseUpgradeResponse = false; upgradeRejection = null; commerceReadFailures = 0; commerceReads = 0; purchaseFailure = null; checkoutActionFailure = null; paymentMutationsBeforePurchase = 0; checkoutCloseStatus = 'CLOSED'; omitClosedFromSummary = false; usePlatformAccountTabStore.getState().setTab('billing');
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

test('browsing one catalog at a time and visiting orders create no payment', async () => {
  await render('overview');
  expect(host?.querySelector('[data-platform-offer]')).toBeNull();
  expect(host?.textContent).not.toContain('Previous membership');
  await act(async () => button('Buy extra credits').click());
  expect(host?.querySelector('[data-platform-offer][aria-label="Buy extra credits"]')).not.toBeNull();
  expect(host?.querySelectorAll('[data-platform-offer]')).toHaveLength(1);
  expect(/unihub|llmrouter|other service/i.test(host?.textContent ?? '')).toBe(false);
  await render('orders');
  expect(host?.textContent).toContain('Previous membership');
  expect(/unihub|llmrouter|other service|999999/i.test(host?.textContent ?? '')).toBe(false);
  expect(host?.querySelector('[data-platform-offer]')).toBeNull();
  await render('overview');
  expect(host?.querySelector('[data-platform-offer][aria-label="Buy extra credits"]')).not.toBeNull();
  await act(async () => button('Subscribe').click());
  expect(host?.querySelector('[data-platform-offer][aria-label="SuperWagie Plus"]')).not.toBeNull();
  expect(host?.querySelectorAll('[data-platform-offer]')).toHaveLength(1);
  expect(writes).toBe(0);
});

test('an unread commerce state disables purchase entries and restores plans after an authoritative refresh', async () => {
  commerceReadFailures = 1;
  await render('overview');
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Could not read wallets or orders. Refresh to check the authoritative status.');
  expect(button('Subscribe').disabled).toBe(true);
  expect(button('Buy extra credits').disabled).toBe(true);
  expect(button('Subscribe').getAttribute('aria-pressed')).toBe('false');
  await act(async () => button('Subscribe').click());
  await act(async () => button('Buy extra credits').click());
  expect(button('Subscribe').getAttribute('aria-pressed')).toBe('false');
  expect(writes).toBe(0);
  expect(paymentMutations()).toHaveLength(0);
  expect(accountRefreshes).toBe(0);
  expect(host?.querySelector('[data-platform-offer]')).toBeNull();
  await act(async () => button('Refresh wallets and orders').click());
  expect(host?.textContent).not.toContain('Could not read wallets or orders.');
  expect(commerceReads).toBe(2);
  expect(button('Subscribe').disabled).toBe(false);
  expect(button('Buy extra credits').disabled).toBe(false);
  await act(async () => button('Subscribe').click());
  expect(host?.querySelector('[data-platform-offer][aria-label="SuperWagie Plus"]')).not.toBeNull();
  expect(writes).toBe(0);
  expect(paymentMutations()).toHaveLength(0);
});

test('an unavailable wallets-and-orders read disables purchase entries until an authoritative read succeeds', async () => {
  activeMembership = false;
  await render('overview');
  expect(host?.querySelector('[data-platform-offer][aria-label="SuperWagie Plus"]')).not.toBeNull();
  const purchase = () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]');
  commerceReadFailures = 1;
  await act(async () => button('Refresh wallets and orders').click());
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Could not read wallets or orders. Refresh to check the authoritative status.');
  expect(host?.querySelector('[data-platform-offer]')).toBeNull();
  expect(purchase()).toBeNull();
  expect(button('Subscribe').disabled).toBe(true);
  expect(button('Buy extra credits').disabled).toBe(true);
  expect(button('Subscribe').getAttribute('aria-pressed')).toBe('false');
  await act(async () => button('Subscribe').click());
  await act(async () => button('Buy extra credits').click());
  expect(host?.querySelector('[data-platform-offer]')).toBeNull();
  expect(writes).toBe(0);
  expect(paymentMutations()).toHaveLength(0);
  expect(accountRefreshes).toBe(0);
  await act(async () => button('Refresh wallets and orders').click());
  expect(commerceReads).toBe(3);
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(button('Subscribe').disabled).toBe(false);
  expect(button('Buy extra credits').disabled).toBe(false);
  await act(async () => button('Subscribe').click());
  expect(host?.querySelector('[data-platform-offer][aria-label="SuperWagie Plus"]')).not.toBeNull();
  expect(writes).toBe(0);
  expect(paymentMutations()).toHaveLength(0);
});

test('a failed follow-up read after a purchase disables purchase entries until an authoritative refresh', async () => {
  activeMembership = false;
  await render('overview');
  const purchase = () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]');
  expect(purchase()?.disabled).toBe(false);
  purchaseFailure = 'read';
  paymentMutationsBeforePurchase = paymentMutations().length;
  await act(async () => purchase()?.click());
  expect(paymentMutations()).toHaveLength(1);
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Could not read wallets or orders. Refresh to check the authoritative status.');
  expect(purchase()).toBeNull();
  expect(host?.querySelector('[data-platform-offer]')).toBeNull();
  expect(button('Subscribe').disabled).toBe(true);
  expect(button('Buy extra credits').disabled).toBe(true);
  expect(button('Subscribe').getAttribute('aria-pressed')).toBe('false');
  await act(async () => button('Subscribe').click());
  await act(async () => button('Buy extra credits').click());
  expect(host?.querySelector('[data-platform-offer]')).toBeNull();
  expect(paymentMutations()).toHaveLength(1);
  purchaseFailure = null;
  await act(async () => button('Refresh wallets and orders').click());
  expect(commerceReads).toBe(3);
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(button('Subscribe').disabled).toBe(false);
  expect(button('Buy extra credits').disabled).toBe(false);
  expect(paymentMutations()).toHaveLength(1);
});

test('an uncertain checkout keeps the catalog visible and prevents another purchase', async () => {
  activeMembership = false;
  await render('overview');
  const purchase = () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]');
  purchaseFailure = 'operation';
  await act(async () => purchase()?.click());
  expect(paymentMutations()).toHaveLength(1);
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('This payment has no confirmed result yet');
  expect(host?.querySelector('[data-purchase-checkout]')).not.toBeNull();
  expect(purchase()?.disabled).toBe(true);
  expect(button('Submit this payment again').disabled).toBe(false);
  expect(host?.textContent).toContain('Submit it again to settle it before starting another one.');
  expect(paymentMutations()).toHaveLength(1);
  purchaseFailure = null;
  await act(async () => button('Refresh wallets and orders').click());
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(button('Submit this payment again').disabled).toBe(false);
  expect(paymentMutations()).toHaveLength(1);
});

test('a failed follow-up read after a payment status action disables purchase entries until an authoritative refresh', async () => {
  commerce.checkouts = [{ id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2027-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z', session: { kind: 'qr', url: 'weixin://wxpay/bizpayurl?pr=fixture', expires_at: '2027-01-01T00:00:00Z' } }];
  await render('overview');
  expect(button('Refresh status').disabled).toBe(false);
  checkoutActionFailure = 'read';
  await act(async () => button('Refresh status').click());
  expect(mutations.some((item) => item.path.endsWith('/waiting-checkout/reconcile'))).toBe(true);
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Could not read wallets or orders. Refresh to check the authoritative status.');
  expect(host?.querySelector('[data-purchase-checkout]')).not.toBeNull();
  expect(host?.querySelector('[data-purchase-catalog]')).not.toBeNull();
  checkoutActionFailure = null;
  await act(async () => button('Refresh wallets and orders').click());
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(host?.querySelector('[data-purchase-checkout]')).not.toBeNull();
});

test('a failed payment operation keeps the last authoritative purchase entries available', async () => {
  commerce.checkouts = [{ id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2027-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z', session: { kind: 'qr', url: 'weixin://wxpay/bizpayurl?pr=fixture', expires_at: '2027-01-01T00:00:00Z' } }];
  await render('overview');
  checkoutActionFailure = 'operation';
  await act(async () => button('Buy extra credits').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Buy extra credits"]')?.click());
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Could not read wallets or orders. Refresh to check the authoritative status.');
  expect(host?.querySelector('[data-purchase-checkout]')).not.toBeNull();
  expect(host?.querySelector('[data-purchase-catalog]')).not.toBeNull();
  checkoutActionFailure = null;
  await act(async () => button('Refresh wallets and orders').click());
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(host?.querySelector('[data-purchase-checkout]')).not.toBeNull();
});

test('shows a confirmed order and its date without repeating the matching request', async () => {
  const createdAt = '2026-11-14T10:00:00Z';
  const order = commerce.orders?.[0];
  if (!order) throw new Error('Missing purchase fixture');
  order.createdAt = createdAt;
  commerce.intents = [
    { accountId: 'team-a', idempotencyKey: 'applied', kind: 'purchase', status: 'APPLIED', productId: 'superwagie', resourceId: order.id, amount: order.amount, createdAt },
    { accountId: 'team-a', idempotencyKey: 'unknown', kind: 'purchase', status: 'UNKNOWN', productId: 'superwagie', amount: order.amount, createdAt },
  ];
  await render('orders');
  expect(host?.querySelector('time')?.dateTime).toBe(createdAt);
  expect(host?.textContent).not.toContain('Past payment attempts');
  expect([...(host?.querySelectorAll('button') ?? [])].filter((item) => item.textContent === 'Submit this payment again')).toHaveLength(1);
  expect(host?.textContent).not.toContain('No purchase orders.');
});

test('a failed order read keeps one refresh action on the orders page', async () => {
  commerceReadFailures = 1;
  await render('orders');
  expect([...(host?.querySelectorAll('button') ?? [])].filter((item) => item.textContent === 'Refresh wallets and orders')).toHaveLength(1);
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Could not read wallets or orders. Refresh to check the authoritative status.');
});

test('model funding navigation opens add-on plans without creating a payment', async () => {
  await render('overview');
  expect(host?.textContent).not.toContain('Existing cash balances');
  expect(host?.textContent).not.toContain('Account balance');
  expect(host?.textContent).not.toContain('Subscription balance');
  expect(host?.textContent).not.toContain('Model balance');
  expect(/unihub|llmrouter|other-service|999999/i.test(host?.textContent ?? '')).toBe(false);
  expect(host?.querySelector('#unihub-recharge-amount')).toBeNull();
  await act(async () => preparePlatformAccountTarget('platform-account.model-recharge'));
  expect(host?.querySelector('[data-platform-offer][aria-label="Buy extra credits"]')).not.toBeNull();
  expect(/unihub|llmrouter/i.test(host?.textContent ?? '')).toBe(false);
  expect(usePlatformAccountTabStore.getState().purchaseTarget).toBeNull();
  expect(writes).toBe(0);
});

test('older unresolved requests wait for explicit recovery without exposing another service', async () => {
  commerce.intents = [
    { idempotencyKey: 'older-command', kind: 'purchase', accountId: 'team-a', productId: 'other-service', amount: '4321000', status: 'UNKNOWN', createdAt: '2026-11-06T00:00:00Z' },
    { idempotencyKey: 'completed-other', kind: 'purchase', accountId: 'team-a', productId: 'other-service', amount: '999999000000', status: 'APPLIED', createdAt: '2026-11-06T00:00:00Z' },
  ];
  await render('overview');
  await act(async () => {});
  expect(button('Submit this payment again').disabled).toBe(false);
  expect(/other-service|999999/i.test(host?.textContent ?? '')).toBe(false);
  expect(writes).toBe(0);
});

test('an unconfirmed intent retries the original request only on explicit action', async () => {
  commerce.intents = [{ idempotencyKey: 'original-command', kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: '5000000', provider: 'wechat', status: 'UNKNOWN', createdAt: '2026-11-06T00:00:00Z' }];
  await render('overview');
  await act(async () => {});
  expect(writes).toBe(0);
  await act(async () => button('Submit this payment again').click());
  expect(mutations.filter((item) => /intents\/original-command\/reconcile$/.test(item.path))).toHaveLength(1);
  await render('orders');
  expect(host?.textContent).toContain('Previous membership');
});

test('a saved provider query error describes the old payment without claiming a failed commerce read', async () => {
  commerce.intents = [{ idempotencyKey: 'old-checkout', kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: '9800000', provider: 'wechat', status: 'PENDING', resourceId: 'old-checkout-resource', errorCode: 'provider_query_unknown', createdAt: '2026-11-10T00:00:00Z' }];
  await render('orders');
  expect(host?.textContent).toContain('Awaiting settlement or fulfillment');
  expect(host?.textContent).toContain('This payment has no confirmed result yet');
  expect(host?.textContent).not.toContain('Could not read wallets or orders.');
  expect(button('Check again').disabled).toBe(false);
});

test('an unsubscribed account opens published plans without inventing candidate prices', async () => {
  activeMembership = false;
  commerce.offers = [];
  await render('overview');
  expect(host?.textContent).toContain('No membership offers are published');
  expect(host?.querySelectorAll('[data-platform-offer]')).toHaveLength(0);
  expect(host?.textContent).not.toContain('39.00');
  expect(host?.querySelector('details')).toBeNull();
  expect(writes).toBe(0);
});

test('new SuperWagie credit packages require membership before purchase', async () => {
  activeMembership = false;
  const addon = commerce.offers?.find((offer) => offer.id === 'addon-a');
  if (!addon) throw new Error('Missing fixture addon');
  addon.productId = 'superwagie'; addon.name = 'Extra 200';
  await render('overview');
  await act(async () => preparePlatformAccountTarget('platform-account.addon'));
  const option = host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Extra 200"]');
  expect(option?.disabled).toBe(true);
  await act(async () => option?.click());
  expect(host?.querySelector('[data-purchase-checkout]')).toBeNull();
  expect(host?.textContent).toContain('Subscribe before buying');
  expect(usePlatformAccountTabStore.getState().purchaseTarget).toBeNull();
  expect(writes).toBe(0);
});

test('point runtime readiness blocks selection while leaving original balance recovery available', async () => {
  const addon = commerce.offers?.find((offer) => offer.id === 'addon-a');
  if (!addon) throw new Error('Missing fixture addon');
  addon.productId = 'superwagie'; addon.name = 'Extra 200'; addon.purchaseReadiness = { ready: false, reason: 'points_runtime_unavailable' };
  commerce.payments.mode = 'unconfigured';
  await render('overview');
  await act(async () => preparePlatformAccountTarget('platform-account.addon'));
  expect(host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Extra 200"]')?.disabled).toBe(true);
  expect(host?.textContent).toContain('not open for purchase yet');
  expect(host?.textContent).not.toContain('Existing cash balances');
  expect(writes).toBe(0);
});

test('existing eligible offers can use a sufficient balance without external payment configuration', async () => {
  commerce.payments.mode = 'unconfigured';
  const addon = commerce.offers?.find((offer) => offer.id === 'addon-a');
  if (!addon) throw new Error('Missing fixture addon');
  addon.sandbox = false;
  await render('overview');
  await act(async () => preparePlatformAccountTarget('platform-account.addon'));
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Buy extra credits"]')?.click());
  expect(button('Buy Buy extra credits for CNY 10.00').disabled).toBe(false);
  expect(writes).toBe(0);
});

test('scoped cards show the annual plan due date and the pack terms before payment', async () => {
  const monthly = commerce.offers?.find((offer) => offer.id === 'membership-a');
  if (!monthly) throw new Error('Missing fixture membership');
  const annual = { ...monthly, id: 'annual-a', name: 'SuperWagie Annual', period: 'year', price: '120000000' };
  commerce.offers?.push(annual, { ...monthly, id: 'pack-one', name: 'One-month pack', kind: 'addon', period: 'once', price: '50000000', monthlyCredit: '1000000000' });
  commerce.productCreditWallet = true;
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: annual.id, name: annual.name, period: 'year', rank: annual.rank } };
  await render('overview');
  await act(async () => button('Subscribe').click());
  const annualCard = host?.querySelector('[data-platform-offer][aria-label="SuperWagie Annual"]')?.parentElement;
  expect(annualCard?.textContent).toContain('Current plan');
  expect(annualCard?.textContent).toContain('CNY 120.00');
  expect(annualCard?.textContent).toContain('Paid through');
  await act(async () => button('Monthly').click());
  expect(host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]')?.disabled).toBe(true);
  expect(host?.textContent).toContain('You can change billing periods after your current subscription expires.');
  await act(async () => button('Buy extra credits').click());
  const pack = host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="One-month pack"]');
  expect(pack?.textContent).toContain('Valid through the same day next month');
  expect(pack?.textContent).toContain('1000 credits');
  expect(pack?.disabled).toBe(false);
  expect(writes).toBe(0);
});

test('scoped upgrade quotes charge the full new period and show the estimated original-payment refund', async () => {
  const offer = commerce.offers?.find((item) => item.id === 'membership-a');
  if (!offer) throw new Error('Missing fixture membership');
  commerce.productCreditWallet = true;
  commerce.wallets = [{ productId: '', asset: 'CNY/6', amount: '500000000' }];
  commerce.payments.mode = 'unconfigured';
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: 'previous-plan', name: 'Standard', period: 'month', rank: 0 } };
  upgradeQuote = {
    paymentSource: 'wallet', id: 'quote-new', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1,
    offer, amount: offer.price, additionalCredits: offer.monthlyCredit, periodStart: '2026-11-08T00:00:00Z', createdAt: '2026-11-08T00:00:00Z', expiresAt: '2099-12-08T00:00:00Z',
    productCreditUpgrade: { previousOrderId: 'old-order', estimatedRefundAmount: '30500000', refundPaymentSource: 'external' },
  };
  await render('overview');
  await act(async () => button('Subscribe').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]')?.click());
  expect(host?.textContent).toContain('Estimated refund');
  expect(host?.textContent).toContain('CNY 30.50');
  expect(host?.textContent).toContain('A new subscription period starts when payment is confirmed.');
  expect(host?.textContent).not.toContain('Your membership still ends');
  expect(paymentMutations()).toHaveLength(1);
});

test('a legacy plan upgrade shows the list price, applied credit and net amount due', async () => {
  const offer = commerce.offers?.find((item) => item.id === 'membership-a');
  if (!offer) throw new Error('Missing fixture membership');
  commerce.productCreditWallet = true;
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: 'previous-plan', name: 'Standard', period: 'month', rank: 0 } };
  upgradeQuote = {
    paymentSource: 'external', id: 'quote-net', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1,
    offer, amount: '7000000', originalAmount: '6999999', roundingRule: 'cny_cent_ceil_v1', additionalCredits: offer.monthlyCredit,
    periodStart: '2026-11-08T00:00:00Z', createdAt: '2026-11-08T00:00:00Z', expiresAt: '2099-12-08T00:00:00Z',
    productCreditUpgrade: { previousOrderId: 'old-order', estimatedRefundAmount: '0', refundPaymentSource: 'external', appliedCreditAmount: '3000000' },
  };
  await render('overview');
  await act(async () => button('Subscribe').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]')?.click());
  const panel = host?.querySelector('[data-purchase-checkout]');
  expect(panel?.textContent).toContain('Plan price · CNY 10.00');
  expect(panel?.textContent).toContain('Old plan credit · CNY 3.00');
  expect(panel?.textContent).toContain('Amount dueCNY 7.00');
  expect(panel?.textContent).toContain('A new subscription period starts when payment is confirmed.');
  expect(panel?.textContent).not.toContain('Estimated refund');
  await act(async () => button('Confirm upgrade for CNY 7.00').click());
  expect(JSON.parse(paymentMutations()[1].body)).toMatchObject({ quoteId: 'quote-net', provider: 'wechat' });
});

test('an active Standard member sees their plan as current and can explicitly buy a Professional upgrade', async () => {
  const standard = commerce.offers?.find((offer) => offer.id === 'membership-a');
  if (!standard || !commerce.offers) throw new Error('Missing fixture membership');
  Object.assign(standard, { name: 'Standard', price: '39000000', monthlyCredit: '1000000000' });
  const professional = { ...standard, id: 'professional-month', name: 'Professional', rank: 2, price: '99000000', monthlyCredit: '3000000000' };
  commerce.offers.push(professional);
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-10T12:00:00Z', offer: { id: standard.id, name: standard.name, period: standard.period, rank: standard.rank } };
  upgradeQuote = { paymentSource: 'external', id: 'quote-pro', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1, offer: professional, amount: '42000000', originalAmount: '41999999', roundingRule: 'cny_cent_ceil_v1', additionalCredits: '2000000000', periodStart: '2099-11-10T12:00:00Z', createdAt: '2099-11-18T12:00:00Z', expiresAt: '2099-11-18T12:15:00Z' };

  await render('overview');
  await act(async () => button('Subscribe').click());
  const current = host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Standard"]');
  expect(current?.disabled).toBe(true);
  expect(host?.textContent).toContain('Current plan');
  expect(host?.querySelector('[data-purchase-checkout]')).toBeNull();
  expect(writes).toBe(0);

  await act(async () => button('Alipay').click());
  expect(writes).toBe(0);
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Professional"]')?.click());
  expect(paymentMutations()).toHaveLength(1);
  expect(JSON.parse(paymentMutations()[0].body)).toMatchObject({ subscriptionId: 'subscription-a', offerId: professional.id, paymentSource: 'external' });
  await act(async () => button('Confirm upgrade for CNY 42.00').click());
  expect(paymentMutations()).toHaveLength(2);
  expect(JSON.parse(paymentMutations()[1].body)).toMatchObject({ quoteId: 'quote-pro', provider: 'alipay' });
});

for (const lostResponse of [false, true]) test(`upgrade confirms the authoritative difference and preserves its original request when response is ${lostResponse ? 'lost' : 'received'}`, async () => {
  const offer = commerce.offers?.find((item) => item.id === 'membership-a');
  if (!offer) throw new Error('Missing fixture membership');
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: 'previous-plan', name: 'Standard', period: 'month', rank: 0 } };
  upgradeQuote = { paymentSource: 'wallet', id: 'quote-a', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1, offer, amount: '5000000', additionalCredits: '100000000', periodStart: '2026-11-08T00:00:00Z', createdAt: '2026-11-08T00:00:00Z', expiresAt: '2099-11-09T00:00:00Z' };
  commerce.payments.mode = 'unconfigured';
  await render('overview');
  await act(async () => button('Subscribe').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]')?.click());
  expect(paymentMutations()).toHaveLength(1);
  expect(paymentMutations()[0].path.endsWith('/upgrade-quotes')).toBe(true);
  expect(host?.textContent).toContain('100 credits');
  loseUpgradeResponse = lostResponse;
  await act(async () => button('Confirm upgrade for CNY 5.00').click());
  expect(paymentMutations()[1].path.endsWith('/upgrade-purchases')).toBe(true);
  expect(paymentMutations()[1].body).toContain('"quoteId":"quote-a"');
  if (lostResponse) {
    await render('orders');
    expect(host?.textContent).toContain('has no confirmed result yet');
    await act(async () => button('Submit this payment again').click());
    expect(paymentMutations()[2].body).toBe(paymentMutations()[1].body);
  }
  expect(host?.textContent).toContain('Your purchase is active');
  expect(mutations.every((request) => !request.path.endsWith('/purchases') && !request.path.endsWith('/recharges'))).toBe(true);
});

test('an expired upgrade quote can be refreshed without accepting or charging it', async () => {
  const offer = commerce.offers?.find((item) => item.id === 'membership-a');
  if (!offer) throw new Error('Missing fixture membership');
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: 'previous-plan', name: 'Standard' } };
  upgradeQuote = { paymentSource: 'wallet', id: 'expired-quote', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1, offer, amount: '5000000', additionalCredits: '100000000', periodStart: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-02T00:00:00Z' };
  commerce.payments.mode = 'unconfigured';
  await render('overview');
  await act(async () => button('Subscribe').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]')?.click());
  expect(button('Confirm upgrade for CNY 5.00').disabled).toBe(true);
  upgradeQuote = { ...upgradeQuote, id: 'fresh-quote', expiresAt: '2099-12-01T00:00:00Z' };
  await act(async () => button('Check upgrade price').click());
  expect(button('Confirm upgrade for CNY 5.00').disabled).toBe(false);
  expect(paymentMutations()).toHaveLength(2);
  expect(mutations.every((request) => request.path.endsWith('/upgrade-quotes'))).toBe(true);
});

for (const rejection of ['failed', 'http', 'conflict'] as const) test(`upgrade ${rejection} response only releases a conclusively invalidated quote`, async () => {
  const offer = commerce.offers?.find((item) => item.id === 'membership-a');
  if (!offer) throw new Error('Missing fixture membership');
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: 'previous-plan', name: 'Standard' } };
  upgradeQuote = { paymentSource: 'wallet', id: 'quote-a', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1, offer, amount: '5000000', additionalCredits: '100000000', periodStart: '2026-11-08T00:00:00Z', createdAt: '2026-11-08T00:00:00Z', expiresAt: '2099-12-01T00:00:00Z' };
  commerce.payments.mode = 'unconfigured';
  await render('overview');
  await act(async () => button('Subscribe').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]')?.click());
  upgradeRejection = rejection;
  await act(async () => button('Confirm upgrade for CNY 5.00').click());
  if (rejection === 'conflict') {
    await render('orders');
    expect(host?.textContent).toContain('has no confirmed result yet');
    await act(async () => button('Submit this payment again').click());
    expect(paymentMutations()[2].body).toBe(paymentMutations()[1].body);
    expect(paymentMutations()[2].path.endsWith('/upgrade-purchases')).toBe(true);
  } else {
    expect(host?.textContent).toContain('This quote is no longer valid');
    expect(host?.textContent).not.toContain('Confirm upgrade for CNY 5.00');
    expect(host?.textContent).not.toContain('Submit this payment again');
    expect(button('Check upgrade price').disabled).toBe(false);
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    expect(host?.textContent).toContain('报价已失效，请重新获取补差报价。');
    await act(async () => useI18nStore.getState().setLocale('en'));
    upgradeQuote = { ...upgradeQuote, id: 'quote-b', subscriptionVersion: 2 };
    await act(async () => button('Check upgrade price').click());
    await act(async () => button('Confirm upgrade for CNY 5.00').click());
    expect(paymentMutations()[3].body).toContain('"quoteId":"quote-b"');
    expect(paymentMutations()[3].body).not.toBe(paymentMutations()[1].body);
  }
  expect(host?.textContent).toContain('Your purchase is active');
});

test('a new account does not show an empty point overview ahead of the plans', async () => {
  const account: Extract<PlatformAccountState, { status: 'signed-in' }> = {
    status: 'signed-in', user: { id: 'actor-a', name: 'Alice', email: '' }, accounts: [], accountId: 'team-a', expiresAt: '2099-12-01T00:00:00Z',
    membership: [], credits: { available: '0', reserved: '0', batches: [] }, consoleUrl: null, modelService: 'unavailable',
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<I18nProvider><PlatformMembershipSummary account={account} actions={null} /></I18nProvider>));
  expect(host.textContent).toBe('');
  expect(writes).toBe(0);
});

test('membership purchase entries expose their pressed and disabled states', async () => {
  const account: Extract<PlatformAccountState, { status: 'signed-in' }> = {
    status: 'signed-in', user: { id: 'actor-a', name: 'Alice', email: '' }, accounts: [], accountId: 'team-a', expiresAt: '2099-12-01T00:00:00Z',
    membership: [{ id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-01T00:00:00Z', offer: { name: 'SuperWagie Plus' } }],
    credits: { available: '1000000', reserved: '0', batches: [] }, consoleUrl: null, modelService: 'unavailable',
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useI18nStore.getState().setLocale('en');
  const actions = { openMembership: () => {}, openAddon: () => {}, membershipOpen: true, addonOpen: false, disabled: true };
  await act(async () => root?.render(<I18nProvider><PlatformMembershipSummary account={account} actions={actions} /></I18nProvider>));
  expect(button('Manage membership').disabled).toBe(true);
  expect(button('Manage membership').getAttribute('aria-pressed')).toBe('true');
  expect(button('Buy extra credits').disabled).toBe(true);
  expect(button('Buy extra credits').getAttribute('aria-pressed')).toBe('false');
  await act(async () => root?.render(<I18nProvider><PlatformMembershipSummary account={account} actions={{ ...actions, disabled: false }} /></I18nProvider>));
  expect(button('Manage membership').disabled).toBe(false);
  expect(button('Buy extra credits').disabled).toBe(false);
  expect(writes).toBe(0);
});

test('point summary separates authoritative batches and excludes frozen, future and expired balances', async () => {
  const batch = { id: 'subscription', kind: 'subscription' as const, sourceScope: 'product' as const, productId: 'superwagie' as const, available: '150000000', reserved: '0', startsAt: '2020-01-01T00:00:00Z', expiresAt: '2099-12-01T00:00:00Z', frozen: false };
  const account: Extract<PlatformAccountState, { status: 'signed-in' }> = {
    status: 'signed-in', user: { id: 'actor-a', name: 'Alice', email: '' }, accounts: [], accountId: 'team-a', expiresAt: '2099-12-01T00:00:00Z',
    membership: [{ id: 'old-subscription', product_id: 'superwagie', status: 'active', paid_through: '2000-01-01T00:00:00Z', offer: { name: 'Expired plan' } }],
    credits: { available: '220000000', reserved: '7', batches: [batch, { ...batch, id: 'addon', kind: 'addon', available: '60000000' }, { ...batch, id: 'shared', kind: 'other', sourceScope: 'shared', productId: undefined, available: '10000000' }, { ...batch, id: 'frozen', available: '999000000', frozen: true }, { ...batch, id: 'expired', available: '999000000', expiresAt: '2000-01-01T00:00:00Z' }, { ...batch, id: 'future', available: '999000000', startsAt: '2100-01-01T00:00:00Z', expiresAt: '2101-01-01T00:00:00Z' }] },
    consoleUrl: null, modelService: 'unavailable',
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><PlatformMembershipSummary account={account} actions={null} /></I18nProvider>));
  expect(host.textContent).toContain('Subscription credits remaining');
  const balances = Array.from(host.querySelectorAll('dl > div > dd:first-of-type')).map((element) => element.textContent);
  expect(balances).toEqual(['220', '150', '60', '10']);
  expect(host.textContent).toContain('Other shared credits');
  expect(host.textContent).not.toContain('Reserved credits');
  expect(host.querySelector('details')).toBeNull();
  expect(host.textContent).not.toContain('0.000007');
  expect(host.textContent).not.toContain('999');
  expect(host.textContent).toContain('Expired');
  expect(host.textContent).toContain('Remaining credits keep their original expiry');
  expect(host.textContent).not.toContain('Next grant');
  expect(writes).toBe(0);
});

test('expired membership shows retained frozen pack credits and their original expiry', async () => {
  const account: Extract<PlatformAccountState, { status: 'signed-in' }> = {
    status: 'signed-in', user: { id: 'actor-a', name: 'Alice', email: '' }, accounts: [], accountId: 'team-a', expiresAt: '2099-12-01T00:00:00Z',
    membership: [], productCreditWallet: true,
    credits: { available: '0', reserved: '0', activeMembership: false, membershipPaidThrough: '2000-01-01T00:00:00Z',
      batches: [{ id: 'held-pack', kind: 'addon', sourceScope: 'product', productId: 'superwagie', available: '8000000', reserved: '0',
        startsAt: '2020-01-01T00:00:00Z', expiresAt: '2099-11-30T16:15:00Z', frozen: true }] },
    consoleUrl: null, modelService: 'unavailable',
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><PlatformMembershipSummary account={account} actions={null} /></I18nProvider>));
  expect(host.textContent).toContain('Retained extra credits8');
  expect(host.textContent).toContain('Pack · 8 credits · expires 12/1/2099');
  expect(host.textContent).toContain('Remaining credits keep their original expiry');
  expect(Array.from(host.querySelectorAll('dl > div > dd:first-of-type')).map((item) => item.textContent)).toEqual(['0', '0', '8']);
});

test('a source-unavailable account keeps its authoritative total without inventing source balances', async () => {
  const account: Extract<PlatformAccountState, { status: 'signed-in' }> = {
    status: 'signed-in', user: { id: 'actor-a', name: 'Alice', email: '' }, accounts: [], accountId: 'team-a', expiresAt: '2099-12-01T00:00:00Z',
    membership: [], credits: { available: '9007199254740993', reserved: '7' }, consoleUrl: null, modelService: 'unavailable',
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><PlatformMembershipSummary account={account} actions={null} /></I18nProvider>));
  expect(Array.from(host.querySelectorAll('dl > div > dd:first-of-type')).map((element) => element.textContent)).toEqual(['9007199254']);
  expect(host.textContent).toContain('This server has not provided credit sources');
  expect(host.textContent).not.toContain('Subscription credits remaining');
  expect(host.textContent).not.toContain('Reserved credits');
  expect(writes).toBe(0);
});


test('external channel selection stays read-only until a product is activated and unknown checkout blocks another payment', async () => {
  commerce.payments = { mode: 'external', canPurchase: true, providers: ['wechat', 'alipay'] };
  commerce.wallets = [];
  activeMembership = false;
  await render('overview');
  await act(async () => button('Alipay').click());
  expect(writes).toBe(0);
  const purchase = host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]');
  expect(purchase?.disabled).toBe(false);
  await act(async () => purchase?.click());
  expect(paymentMutations()).toHaveLength(1);
  expect(paymentMutations()[0].path.endsWith('/checkouts')).toBe(true);
  expect(JSON.parse(paymentMutations()[0].body)).toMatchObject({ accountId: 'team-a', provider: 'alipay', offerId: 'membership-a' });
  await act(async () => {});
  expect(button('Submit this payment again').disabled).toBe(false);
  expect(host?.querySelector<HTMLButtonElement>('[data-platform-offer]')?.disabled).toBe(true);
  await render('orders');
  await render('overview');
  expect(paymentMutations()).toHaveLength(1);
});

test('switching a restored waiting checkout uses its checkout intent to recreate the payment on the other channel', async () => {
  commerce.payments = { mode: 'external', canPurchase: true, providers: ['wechat', 'alipay'] };
  commerce.checkouts = [{ id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z', session: { kind: 'qr', url: 'weixin://pay/fixture', expires_at: '2099-01-01T00:00:00Z' } }];
  commerce.intents = [{ idempotencyKey: 'restored-checkout', kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: '10000000', offerId: 'membership-a', resourceId: 'waiting-checkout', provider: 'wechat', status: 'PENDING', createdAt: '2026-11-08T00:00:00Z' }];
  await render('orders');
  expect(host?.textContent).toContain('WeChat Pay');
  const channelGroup = [...(host?.querySelectorAll('[role="group"]') ?? [])].find((item) => item.getAttribute('aria-label') === 'Payment method');
  expect(channelGroup).toBeDefined();
  const alipay = [...(channelGroup?.querySelectorAll('button') ?? [])].find((item) => item.textContent === 'Alipay' && item.getAttribute('aria-pressed') !== 'true');
  expect(alipay).toBeDefined();
  await act(async () => alipay?.click());
  expect(paymentMutations().map((item) => item.path)).toEqual([
    '/api/platform-account/commerce/checkouts/waiting-checkout/close',
    '/api/platform-account/commerce/checkouts',
  ]);
  expect(JSON.parse(paymentMutations()[1].body)).toMatchObject({ accountId: 'team-a', provider: 'alipay', offerId: 'membership-a' });
});

test('another product card waits for Alipay closure before creating its checkout', async () => {
  const checkout = { id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'alipay', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z', session: { kind: 'qr', url: 'https://qr.alipay.com/fixture', expires_at: '2099-01-01T00:00:00Z' } } as const;
  commerce.checkouts = [checkout];
  commerce.intents = [{ idempotencyKey: 'restored-checkout', kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: '10000000', offerId: 'membership-a', resourceId: checkout.id, provider: 'alipay', status: 'PENDING', createdAt: checkout.created_at }];
  await render('overview');
  expect(host?.querySelector('[data-payment-checkout]')?.textContent).toContain('Open Alipay on your phone and scan the code to pay');

  await act(async () => button('Buy extra credits').click());
  const replacement = () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Buy extra credits"]');
  expect(replacement()?.disabled).toBe(false);
  expect(paymentMutations()).toHaveLength(0);
  checkoutCloseStatus = 'UNKNOWN';
  commerce.checkouts = [{ ...checkout, payment_status: 'UNKNOWN', close_pending: true, session: undefined }];
  await act(async () => replacement()?.click());
  expect(host?.querySelector('[data-payment-checkout]')?.textContent).toContain('Waiting for closure confirmation');
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(host?.querySelector('[data-payment-checkout] img')).toBeNull();
  expect(replacement()?.disabled).toBe(true);
  expect(paymentMutations().map((item) => item.path)).toEqual(['/api/platform-account/commerce/checkouts/waiting-checkout/close']);

  commerce.checkouts = [{ ...checkout, payment_status: 'CLOSED', session: undefined }];
  commerce.intents = [];
  omitClosedFromSummary = true;
  await act(async () => button('Refresh status').click());
  expect(replacement()?.getAttribute('aria-current')).toBe('true');
  expect(paymentMutations().map((item) => item.path)).toEqual([
    '/api/platform-account/commerce/checkouts/waiting-checkout/close',
    '/api/platform-account/commerce/checkouts',
  ]);
  expect(JSON.parse(paymentMutations()[1].body)).toMatchObject({ offerId: 'addon-a', provider: 'alipay' });
});

test('a refresh recovers the confirmed offer closure when the failed read hid its receipt', async () => {
  const checkout = { id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'alipay', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z' } as const;
  commerce.checkouts = [checkout];
  await render('overview');
  await act(async () => button('Buy extra credits').click());

  const replacement = host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Buy extra credits"]');
  expect(replacement?.disabled).toBe(false);
  commerceReadFailures = 1;
  await act(async () => replacement?.click());
  expect(host?.querySelector('[role="alert"]')).not.toBeNull();
  expect(paymentMutations().map((item) => item.path)).toEqual(['/api/platform-account/commerce/checkouts/waiting-checkout/close']);

  commerce.checkouts = [{ ...checkout, payment_status: 'CLOSED' }];
  omitClosedFromSummary = true;
  await act(async () => button('Refresh wallets and orders').click());
  expect(paymentMutations().map((item) => item.path)).toEqual([
    '/api/platform-account/commerce/checkouts/waiting-checkout/close',
    '/api/platform-account/commerce/checkouts',
  ]);
  expect(JSON.parse(paymentMutations()[1].body)).toMatchObject({ accountId: 'team-a', offerId: 'addon-a', provider: 'alipay' });
});

test('a completed external receipt leaves balance available for the next purchase', async () => {
  const checkout = { id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z' } as const;
  commerce.checkouts = [checkout];
  await render('overview');

  commerce.checkouts = [{ ...checkout, payment_status: 'PAID', fulfillment_status: 'FULFILLED' }];
  await act(async () => button('Refresh status').click());
  expect(host?.querySelector('[data-purchase-checkout]')?.textContent).toContain('Your purchase is active');

  await act(async () => button('Existing cash balances').click());
  expect(host?.querySelector('[data-purchase-checkout]')?.textContent).toContain('Your purchase is active');
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Buy extra credits"]')?.click());
  expect(paymentMutations()).toHaveLength(0);

  await act(async () => button('Buy Buy extra credits for CNY 10.00').click());
  expect(paymentMutations().map((item) => item.path)).toEqual(['/api/platform-account/commerce/purchases']);
});

test('changing the membership period clears the unsubmitted balance purchase', async () => {
  const monthly = commerce.offers?.find((offer) => offer.id === 'membership-a');
  if (!monthly) throw new Error('Missing fixture membership');
  commerce.offers?.push({ ...monthly, id: 'annual-a', name: 'SuperWagie Annual', period: 'year', price: '120000000' });
  activeMembership = false;
  await render('overview');
  await act(async () => button('Existing cash balances').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]')?.click());
  expect(host?.querySelector('[data-purchase-checkout]')?.textContent).toContain('SuperWagie Plus');

  await act(async () => button('Annual').click());
  expect(Boolean(host?.querySelector('[data-platform-offer][aria-label="SuperWagie Annual"]'))).toBe(true);
  expect(Boolean(host?.querySelector('[data-purchase-checkout]'))).toBe(false);
  expect(paymentMutations()).toHaveLength(0);
});

test('changing the membership period preserves an existing payment and its offer', async () => {
  const monthly = commerce.offers?.find((offer) => offer.id === 'membership-a');
  if (!monthly) throw new Error('Missing fixture membership');
  commerce.offers?.push({ ...monthly, id: 'annual-a', name: 'SuperWagie Annual', period: 'year', price: '120000000' });
  activeMembership = false;
  const checkout = { id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: monthly.name, amount: monthly.price, currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z' } as const;
  commerce.checkouts = [checkout];
  commerce.intents = [{ idempotencyKey: 'restored-checkout', kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: monthly.price, offerId: monthly.id, resourceId: checkout.id, provider: 'wechat', status: 'PENDING', createdAt: checkout.created_at }];
  await render('overview');

  await act(async () => button('Annual').click());
  expect(Boolean(host?.querySelector('[data-platform-offer][aria-label="SuperWagie Annual"]'))).toBe(true);
  expect(host?.querySelector('[data-payment-checkout]')?.getAttribute('data-payment-checkout')).toBe(checkout.id);
  expect(host?.querySelector('[data-purchase-checkout]')?.textContent).toContain(monthly.name);
  expect(paymentMutations()).toHaveLength(0);
});

test('browsing purchase categories leaves a pending wallet recharge alone', async () => {
  commerce.checkouts = [{ id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', walletTopUp: true, offer_name: '', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z' }];
  await render('overview');
  await act(async () => button('Subscribe').click());
  expect(host?.querySelector('[data-purchase-checkout]')).toBeNull();
  const categories = host?.querySelector('[data-purchase-categories]');
  const addOns = [...(categories?.querySelectorAll('button') ?? [])].find((btn) => btn.textContent === 'Buy extra credits');
  await act(async () => addOns?.click());
  expect(host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Buy extra credits"]')?.disabled).toBe(true);
  expect(host?.querySelector('[data-payment-checkout]')?.textContent).toContain('Top up shared cash');
  expect(paymentMutations()).toHaveLength(0);
});

test('selecting another product retains a payment that succeeded before closure', async () => {
  commerce.checkouts = [{ id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z' }];
  await render('overview');
  checkoutCloseStatus = 'PAID';
  await act(async () => button('Buy extra credits').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="Buy extra credits"]')?.click());
  expect(host?.querySelector('[data-purchase-checkout]')?.textContent).toContain('Your purchase is active');
  expect(paymentMutations().map((item) => item.path)).toEqual(['/api/platform-account/commerce/checkouts/waiting-checkout/close']);
  expect(host?.querySelector<HTMLButtonElement>('[data-platform-offer]')?.disabled).toBe(false);
  expect(paymentMutations()).toHaveLength(1);
});

for (const closeStatus of ['PENDING', 'UNKNOWN']) test(`a ${closeStatus} close keeps the original checkout and lets the user retry the channel switch`, async () => {
  commerce.payments = { mode: 'external', canPurchase: true, providers: ['wechat', 'alipay'] };
  commerce.checkouts = [{ id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z', session: { kind: 'qr', url: 'weixin://pay/fixture', expires_at: '2099-01-01T00:00:00Z' } }];
  commerce.intents = [{ idempotencyKey: 'restored-checkout', kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: '10000000', offerId: 'membership-a', resourceId: 'waiting-checkout', provider: 'wechat', status: 'PENDING', createdAt: '2026-11-08T00:00:00Z' }];
  checkoutCloseStatus = closeStatus;
  await render('orders');
  expect(host?.textContent).toContain('WeChat Pay');
  const channelGroup = [...(host?.querySelectorAll('[role="group"]') ?? [])].find((item) => item.getAttribute('aria-label') === 'Payment method');
  const alipay = [...(channelGroup?.querySelectorAll('button') ?? [])].find((item) => item.textContent === 'Alipay' && item.getAttribute('aria-pressed') !== 'true');
  expect(alipay).toBeDefined();
  await act(async () => alipay?.click());
  expect(paymentMutations().map((item) => item.path)).toEqual([
    '/api/platform-account/commerce/checkouts/waiting-checkout/close',
  ]);
  const originalPanel = channelGroup?.closest('[data-payment-checkout]');
  expect(originalPanel?.getAttribute('data-payment-checkout')).toBe('waiting-checkout');
  expect(originalPanel?.textContent).toContain('The original payment method stays selected until the provider confirms the order is closed. Try switching again.');
  expect(channelGroup?.querySelector('[aria-pressed="true"]')?.textContent).toBe('WeChat Pay');
  expect(alipay?.disabled).toBe(false);
  await act(async () => alipay?.click());
  expect(paymentMutations().map((item) => item.path)).toEqual([
    '/api/platform-account/commerce/checkouts/waiting-checkout/close',
    '/api/platform-account/commerce/checkouts/waiting-checkout/close',
  ]);
});

for (const status of ['PENDING', 'PAID']) test(`switching from an expired checkout whose close returns ${status} does not create another order`, async () => {
  commerce.payments = { mode: 'external', canPurchase: true, providers: ['wechat', 'alipay'] };
  commerce.checkouts = [{ id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2020-01-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z', session: { kind: 'qr', url: 'weixin://pay/fixture', expires_at: '2020-01-01T00:00:00Z' } }];
  commerce.intents = [{ idempotencyKey: 'restored-checkout', kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: '10000000', offerId: 'membership-a', resourceId: 'waiting-checkout', provider: 'wechat', status: 'PENDING', createdAt: '2020-01-01T00:00:00Z' }];
  checkoutCloseStatus = status;
  await render('orders');
  expect(host?.textContent).toContain('WeChat Pay');
  const channelGroup = [...(host?.querySelectorAll('[role="group"]') ?? [])].find((item) => item.getAttribute('aria-label') === 'Payment method');
  const alipay = [...(channelGroup?.querySelectorAll('button') ?? [])].find((item) => item.textContent === 'Alipay' && item.getAttribute('aria-pressed') !== 'true');
  expect(alipay).toBeDefined();
  await act(async () => alipay?.click());
  expect(paymentMutations().map((item) => item.path)).toEqual([
    '/api/platform-account/commerce/checkouts/waiting-checkout/close',
  ]);
  if (status === 'PAID') {
    expect(host?.textContent).toContain('Your purchase is active');
    expect(accountRefreshes).toBe(1);
  } else {
    expect(host?.textContent).toContain('The original payment method stays selected');
  }
});

test('reopening retains paid activation and refund states without presenting another payment link', async () => {
  commerce.checkouts = [{ id: 'paid-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'alipay', offer_name: 'Paid membership', amount: '10000000', currency: 'CNY', payment_status: 'PAID', fulfillment_status: 'FULFILLED', refund_status: 'PENDING', expires_at: '2027-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z', session: { kind: 'redirect', url: 'https://openapi.alipay.com/gateway.do?sign=fixture', expires_at: '2027-01-01T00:00:00Z' } }];
  await render('orders');
  expect(host?.textContent).toContain('Refund processing');
  expect(host?.textContent).not.toContain('Open Alipay checkout');
  await act(async () => root?.unmount()); root = undefined;
  await render('overview');
  expect(host?.textContent).toContain('Refund processing');
  expect(writes).toBe(0);
  expect(host?.textContent).not.toContain('Request original-channel refund');
  expect(host?.querySelector('[data-purchase-catalog]')).not.toBeNull();
  expect(host?.querySelectorAll('[data-platform-offer]:not(:disabled)')).toHaveLength(0);
  expect(host?.querySelector('[data-purchase-checkout]')).not.toBeNull();
});


for (const rejection of ['failed','http','conflict'] as const) test(`external upgrade ${rejection} releases only a conclusively invalidated quote and requires fresh confirmation`, async () => {
  commerce.payments={mode:'external',canPurchase:true,providers:['wechat','alipay']};
  const offer=commerce.offers?.find(item=>item.id==='membership-a');if(!offer)throw new Error('Missing offer');
  currentMembership={id:'subscription-a',product_id:'superwagie',status:'active',paid_through:'2099-12-08T00:00:00Z',offer:{id:'old',name:'Old',period:'month',rank:0}};
  upgradeQuote={id:'quote-a',accountId:'team-a',subscriptionId:'subscription-a',subscriptionVersion:1,offer,amount:'5000000',additionalCredits:'100000000',periodStart:'2026-11-08T00:00:00Z',createdAt:'2026-11-08T00:00:00Z',expiresAt:'2099-11-09T00:00:00Z',paymentSource:'external',originalAmount:'5000000',roundingRule:'cny_cent_ceil_v1'};
  await render('overview');await act(async()=>button('Subscribe').click());await act(async()=>host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]')?.click());
  upgradeRejection=rejection;await act(async()=>button('Confirm upgrade for CNY 5.00').click());
  expect(paymentMutations()).toHaveLength(2);const oldKey=JSON.parse(paymentMutations()[1].body).idempotencyKey;
  if(rejection==='conflict'){await render('orders');expect(host?.textContent).toContain('has no confirmed result yet');return;}
  expect(host?.textContent).not.toContain('Confirm upgrade for CNY 5.00');expect(button('Check upgrade price').disabled).toBe(false);
  upgradeQuote={...upgradeQuote,id:'quote-b'};await act(async()=>button('Check upgrade price').click());expect(paymentMutations()).toHaveLength(3);
  await act(async()=>button('Confirm upgrade for CNY 5.00').click());expect(paymentMutations()).toHaveLength(4);
  expect(JSON.parse(paymentMutations()[3].body)).toMatchObject({quoteId:'quote-b',provider:'wechat'});expect(JSON.parse(paymentMutations()[3].body).idempotencyKey).not.toBe(oldKey);
});


test('refreshing newly fulfilled checkout benefits refreshes the account once without a financial command', async () => {
  commerce.checkouts=[{id:'fulfilled-checkout',account_id:'team-a',product_id:'superwagie',provider:'wechat',offer_name:'Membership',amount:'10000000',currency:'CNY',payment_status:'PENDING',fulfillment_status:'NOT_STARTED',refund_status:'',expires_at:'2027-01-01T00:00:00Z',created_at:'2026-11-08T00:00:00Z'}];
  await render('orders');expect(accountRefreshes).toBe(0);
  commerce.checkouts[0].payment_status='PAID';commerce.checkouts[0].fulfillment_status='FULFILLED';
  await act(async()=>button('Refresh wallets and orders').click());expect(accountRefreshes).toBe(1);
  await act(async()=>button('Refresh wallets and orders').click());expect(accountRefreshes).toBe(1);
  commerce.checkouts[0].refund_status='SUCCEEDED';
  await act(async()=>button('Refresh wallets and orders').click());expect(accountRefreshes).toBe(2);expect(writes).toBe(0);
});

test('a pending net upgrade payment retains the quoted credit without a refund estimate', async () => {
  commerce.checkouts = [{
    id: 'net-upgrade-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Professional', amount: '7000000',
    currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2099-12-08T00:00:00Z', created_at: '2026-11-08T00:00:00Z',
    product_credit_upgrade: { previous_subscription_id: 'subscription-old', previous_order_id: 'order-old', estimated_refund_amount: '0', refund_payment_source: 'external', applied_credit_amount: '3000000' },
  }];
  await render('orders');
  const panel = host?.querySelector('[data-payment-checkout="net-upgrade-checkout"]');
  expect(panel?.textContent).toContain('Plan price CNY 10.00');
  expect(panel?.textContent).toContain('Old plan credit CNY 3.00');
  expect(panel?.textContent).toContain('Amount due¥7.00');
  expect(panel?.textContent).toContain('A new subscription period starts when payment is confirmed.');
  expect(panel?.textContent).not.toContain('Estimated refund');
  expect(paymentMutations()).toHaveLength(0);
});

test('completed upgrade returns show the original partial refund and withhold duplicate refund controls', async () => {
  commerce.productCreditWallet = true;
  commerce.checkouts = [{
    id: 'original-paid', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Original membership', amount: '100000000',
    currency: 'CNY', payment_status: 'PAID', fulfillment_status: 'FULFILLED', refund_status: '', upgrade_return_status: 'UPGRADE_RETURNED',
    upgrade_refund_amount: '20000000', expires_at: '2099-12-08T00:00:00Z', created_at: '2026-11-08T00:00:00Z',
  }];
  await render('orders');
  expect(host?.textContent).toContain('Previous plan refund returned');
  expect(host?.textContent).toContain('Refund amount CNY 20.00');
  expect(host?.textContent).not.toContain('Request a refund');
  expect(paymentMutations()).toHaveLength(0);
});

test('a refunded checkout does not hold the purchase panel open', async () => {
  // A refunded PAID checkout keeps fulfillment NOT_STARTED on the server. It
  // is settled money and must not grey out the buying task, matching the
  // server commercialClear() which excludes refund_status = SUCCEEDED.
  commerce.checkouts = [
    { id: 'refunded-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'alipay', offer_name: 'Refunded membership', amount: '10000000', currency: 'CNY', payment_status: 'PAID', fulfillment_status: 'NOT_STARTED', refund_status: 'SUCCEEDED', expires_at: '2027-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z', session: { kind: 'redirect', url: 'https://openapi.alipay.com/gateway.do?sign=fixture', expires_at: '2027-01-01T00:00:00Z' } },
    { id: 'refunded-wechat', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Refunded addon', amount: '9800000', currency: 'CNY', payment_status: 'PAID', fulfillment_status: 'NOT_STARTED', refund_status: 'SUCCEEDED', expires_at: '2027-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z' },
  ];
  activeMembership = false;
  await render('overview');
  expect(host?.textContent).not.toContain('An earlier request is unresolved. Check its original status before starting another purchase or recharge.');
  expect(button('Subscribe').disabled).toBe(false);
  expect(button('Buy extra credits').disabled).toBe(false);
  const membership = host?.querySelector<HTMLButtonElement>('[data-platform-offer][aria-label="SuperWagie Plus"]');
  expect(membership?.disabled).toBe(false);
  expect(paymentMutations()).toHaveLength(0);
  expect(host?.querySelector('[data-purchase-checkout]')).toBeNull();
});
