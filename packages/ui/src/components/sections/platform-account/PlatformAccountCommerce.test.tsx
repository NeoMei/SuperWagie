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
  payments: { mode: 'sandbox', canRecharge: true, canPurchase: true },
  wallets: [{ productId: '', asset: 'CNY/6', amount: '1234567' }, { productId: 'superwagie', asset: 'CNY/6', amount: '30000000' }, { productId: 'llmrouter', asset: 'CNY/6', amount: '86400000' }, { productId: 'other-service', asset: 'CNY/6', amount: '999999000000' }],
  offers: [
    { id: 'addon-a', productId: 'llmrouter', name: 'llmrouter add-on', accountKind: 'both', kind: 'addon', period: 'once', price: '10000000', monthlyCredit: '20000000', validityMonths: 12, rank: 1, sandbox: true },
    { id: 'other-addon', productId: 'other-service', name: 'Other service add-on', accountKind: 'both', kind: 'addon', period: 'once', price: '10000000', monthlyCredit: '20000000', validityMonths: 12, rank: 1, sandbox: true },
    { id: 'membership-a', productId: 'superwagie', name: 'SuperWagie Plus', accountKind: 'both', kind: 'membership', period: 'month', price: '10000000', monthlyCredit: '20000000', validityMonths: 1, rank: 1, sandbox: true },
    { id: 'other-membership', productId: 'llmrouter', name: 'llmrouter membership', accountKind: 'both', kind: 'membership', period: 'month', price: '10000000', monthlyCredit: '20000000', validityMonths: 1, rank: 1, sandbox: true },
  ],
  orders: [
    { id: 'order-a', productId: 'superwagie', offerName: 'Previous membership', amount: '30000000', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refundStatus: '' },
    { id: 'order-addon', productId: 'llmrouter', offerName: 'llmrouter add-on order', amount: '10000000', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refundStatus: '' },
    { id: 'order-other', productId: 'other-service', offerName: 'Other service order', amount: '999999000000', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refundStatus: '' },
  ],
  checkouts: [], intents: [], rechargeHistoryScope: 'this-instance',
};
let writes = 0;
let accountRefreshes = 0;
const initialCommerce = structuredClone(commerce);
const mutations: Array<{ path: string; body: string }> = [];
let activeMembership = true;
let currentMembership: Extract<PlatformAccountState, { status: 'signed-in' }>['membership'][number] | undefined;
let upgradeQuote: PlatformUpgradeQuote | undefined;
let loseUpgradeResponse = false;
let upgradeRejection: 'failed' | 'http' | 'conflict' | null = null;
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const path = String(input instanceof Request ? input.url : input);
  if (init?.method && init.method !== 'GET') { writes++; mutations.push({ path, body: String(init.body) }); }
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
  await act(async () => root?.render(<I18nProvider><PlatformAccountCommerce accountId="team-a" payer="Team A" view={view} hasActiveMembership={activeMembership} currentMembership={currentMembership} membershipSummary={({ openMembership, openAddon }) => <><p>Current membership</p><button type="button" onClick={openMembership}>Subscribe</button><button type="button" onClick={openAddon}>Buy extra credits</button></>} onAccountRefresh={() => { accountRefreshes++; }} /></I18nProvider>));
};
const button = (text: string) => {
  const found = [...(host?.querySelectorAll('button') ?? [])].find(item => item.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined;
  writes = 0; accountRefreshes = 0; mutations.length = 0; Object.assign(commerce, structuredClone(initialCommerce)); activeMembership = true; currentMembership = undefined; upgradeQuote = undefined; loseUpgradeResponse = false; upgradeRejection = null; usePlatformAccountTabStore.getState().setTab('billing');
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

test('overview opens a buying task deliberately and preserves its offer while visiting orders', async () => {
  await render('overview');
  expect(host?.querySelector('[role="radiogroup"]')).toBeNull();
  expect(host?.textContent).not.toContain('Previous membership');
  await act(async () => button('Buy extra credits').click());
  const offer = host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Buy extra credits"]');
  expect(offer).not.toBeNull();
  expect(host?.querySelectorAll('[role="radio"]')).toHaveLength(1);
  expect(/unihub|llmrouter|other service/i.test(host?.textContent ?? '')).toBe(false);
  await act(async () => offer?.click());
  await render('orders');
  expect(host?.textContent).toContain('Previous membership');
  expect(/unihub|llmrouter|other service|999999/i.test(host?.textContent ?? '')).toBe(false);
  expect(host?.querySelector('[role="radiogroup"]')).toBeNull();
  await render('overview');
  expect(host?.querySelector('[role="radio"][aria-label="Buy extra credits"]')?.getAttribute('aria-checked')).toBe('true');
  await act(async () => button('Subscribe').click());
  expect(host?.querySelector('[role="radio"][aria-label="SuperWagie Plus"]')).not.toBeNull();
  expect(host?.querySelectorAll('[role="radio"]')).toHaveLength(1);
  expect(writes).toBe(0);
});

test('model recharge navigation opens the model wallet without creating a payment', async () => {
  await render('overview');
  expect(host?.textContent).toContain('Account balance');
  expect(host?.textContent).toContain('Subscription balance');
  expect(host?.textContent).toContain('Model balance');
  expect(host?.textContent).toContain('1.234567');
  expect(host?.textContent).toContain('30.00');
  expect(host?.textContent).toContain('86.40');
  expect(/unihub|llmrouter|other-service|999999/i.test(host?.textContent ?? '')).toBe(false);
  expect(host?.querySelector('#unihub-recharge-amount')).toBeNull();
  await act(async () => preparePlatformAccountTarget('platform-account.model-recharge'));
  expect(host?.querySelector('#unihub-recharge-amount')).not.toBeNull();
  expect(host?.querySelector('[data-settings-item="platform-account.model-recharge"]')?.textContent).toContain('Model balance');
  expect(/unihub|llmrouter/i.test(host?.textContent ?? '')).toBe(false);
  expect(usePlatformAccountTabStore.getState().rechargeTarget).toBeNull();
  expect(writes).toBe(0);
});

test('older unresolved requests stay recoverable without exposing another service', async () => {
  commerce.intents = [
    { idempotencyKey: 'older-command', kind: 'purchase', accountId: 'team-a', productId: 'other-service', amount: '4321000', status: 'UNKNOWN', createdAt: '2026-11-06T00:00:00Z' },
    { idempotencyKey: 'completed-other', kind: 'purchase', accountId: 'team-a', productId: 'other-service', amount: '999999000000', status: 'APPLIED', createdAt: '2026-11-06T00:00:00Z' },
  ];
  await render('overview');
  expect(button('Check original request').disabled).toBe(false);
  expect(host?.textContent).toContain('4.321');
  expect(/other-service|999999/i.test(host?.textContent ?? '')).toBe(false);
  await render('orders');
  expect(button('Check original request').disabled).toBe(false);
  expect(host?.textContent).toContain('4.321');
  expect(/unihub|llmrouter|other-service|other service|999999/i.test(host?.textContent ?? '')).toBe(false);
  expect(writes).toBe(0);
});

test('unconfirmed intent recovery remains reachable in overview and orders while new commands stay blocked', async () => {
  commerce.intents = [{ idempotencyKey: 'original-command', kind: 'recharge', accountId: 'team-a', productId: 'llmrouter', amount: '5000000', status: 'UNKNOWN', createdAt: '2026-11-06T00:00:00Z' }];
  await render('overview');
  expect(button('Check original request').disabled).toBe(false);
  await act(async () => preparePlatformAccountTarget('platform-account.model-recharge'));
  expect(host?.querySelector<HTMLInputElement>('#unihub-recharge-amount')?.disabled).toBe(true);
  await render('orders');
  expect(button('Check original request').disabled).toBe(false);
  expect(host?.textContent).toContain('Previous membership');
  expect(writes).toBe(0);
});

test('an unsubscribed account opens published plans without inventing candidate prices', async () => {
  activeMembership = false;
  commerce.offers = [];
  await render('overview');
  expect(host?.textContent).toContain('No membership offers are published');
  expect(host?.querySelectorAll('[role="radio"]')).toHaveLength(0);
  expect(host?.textContent).not.toContain('39.00');
  expect(host?.querySelector('details')?.open).toBe(false);
  expect(writes).toBe(0);
});

test('new SuperWagie credit packages require membership before purchase', async () => {
  activeMembership = false;
  const addon = commerce.offers?.find((offer) => offer.id === 'addon-a');
  if (!addon) throw new Error('Missing fixture addon');
  addon.productId = 'superwagie'; addon.name = 'Extra 200';
  await render('overview');
  await act(async () => preparePlatformAccountTarget('platform-account.addon'));
  const option = host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Extra 200"]');
  await act(async () => option?.click());
  expect(button('Buy Extra 200 for CNY 10.00').disabled).toBe(true);
  expect(host?.textContent).toContain('Subscribe before buying');
  expect(usePlatformAccountTabStore.getState().purchaseTarget).toBeNull();
  expect(writes).toBe(0);
});

test('point runtime readiness blocks selection while leaving original balance recovery available', async () => {
  const addon = commerce.offers?.find((offer) => offer.id === 'addon-a');
  if (!addon) throw new Error('Missing fixture addon');
  addon.productId = 'superwagie'; addon.name = 'Extra 200'; addon.purchaseReadiness = { ready: false, reason: 'points_runtime_unavailable' };
  commerce.payments.mode = 'unconfigured'; commerce.payments.canRecharge = false;
  await render('overview');
  await act(async () => preparePlatformAccountTarget('platform-account.addon'));
  expect(host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Extra 200"]')?.disabled).toBe(true);
  expect(host?.textContent).toContain('not open for purchase yet');
  await act(async () => preparePlatformAccountTarget('platform-account.model-recharge'));
  expect(host?.querySelector('details')?.open).toBe(true);
  expect(writes).toBe(0);
});

test('existing eligible offers can use a sufficient balance without external payment configuration', async () => {
  commerce.payments.mode = 'unconfigured'; commerce.payments.canRecharge = false;
  const addon = commerce.offers?.find((offer) => offer.id === 'addon-a');
  if (!addon) throw new Error('Missing fixture addon');
  addon.sandbox = false;
  await render('overview');
  await act(async () => preparePlatformAccountTarget('platform-account.addon'));
  await act(async () => host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Buy extra credits"]')?.click());
  expect(button('Buy Buy extra credits for CNY 10.00').disabled).toBe(false);
  expect(writes).toBe(0);
});

for (const lostResponse of [false, true]) test(`upgrade confirms the authoritative difference and preserves its original request when response is ${lostResponse ? 'lost' : 'received'}`, async () => {
  const offer = commerce.offers?.find((item) => item.id === 'membership-a');
  if (!offer) throw new Error('Missing fixture membership');
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: 'previous-plan', name: 'Standard', period: 'month', rank: 0 } };
  upgradeQuote = { id: 'quote-a', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1, offer, amount: '5000000', additionalCredits: '100000000', periodStart: '2026-11-08T00:00:00Z', createdAt: '2026-11-08T00:00:00Z', expiresAt: '2099-11-09T00:00:00Z' };
  await render('overview');
  await act(async () => button('Subscribe').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="SuperWagie Plus"]')?.click());
  await act(async () => button('Check upgrade price').click());
  expect(mutations).toHaveLength(1);
  expect(mutations[0].path.endsWith('/upgrade-quotes')).toBe(true);
  expect(host?.textContent).toContain('100 credits');
  loseUpgradeResponse = lostResponse;
  await act(async () => button('Confirm upgrade for CNY 5.00').click());
  expect(mutations[1].path.endsWith('/upgrade-purchases')).toBe(true);
  expect(mutations[1].body).toContain('"quoteId":"quote-a"');
  if (lostResponse) {
    expect(host?.textContent).toContain('request outcome is unknown');
    await act(async () => button('Recover original request').click());
    expect(mutations[2].body).toBe(mutations[1].body);
  }
  expect(host?.textContent).toContain('Your purchase is active');
  expect(mutations.every((request) => !request.path.endsWith('/purchases') && !request.path.endsWith('/recharges'))).toBe(true);
});

test('an expired upgrade quote can be refreshed without accepting or charging it', async () => {
  const offer = commerce.offers?.find((item) => item.id === 'membership-a');
  if (!offer) throw new Error('Missing fixture membership');
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: 'previous-plan', name: 'Standard' } };
  upgradeQuote = { id: 'expired-quote', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1, offer, amount: '5000000', additionalCredits: '100000000', periodStart: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-02T00:00:00Z' };
  await render('overview');
  await act(async () => button('Subscribe').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="SuperWagie Plus"]')?.click());
  await act(async () => button('Check upgrade price').click());
  expect(button('Confirm upgrade for CNY 5.00').disabled).toBe(true);
  upgradeQuote = { ...upgradeQuote, id: 'fresh-quote', expiresAt: '2099-12-01T00:00:00Z' };
  await act(async () => button('Check upgrade price').click());
  expect(button('Confirm upgrade for CNY 5.00').disabled).toBe(false);
  expect(mutations).toHaveLength(2);
  expect(mutations.every((request) => request.path.endsWith('/upgrade-quotes'))).toBe(true);
});

for (const rejection of ['failed', 'http', 'conflict'] as const) test(`upgrade ${rejection} response only releases a conclusively invalidated quote`, async () => {
  const offer = commerce.offers?.find((item) => item.id === 'membership-a');
  if (!offer) throw new Error('Missing fixture membership');
  currentMembership = { id: 'subscription-a', product_id: 'superwagie', status: 'active', paid_through: '2099-12-08T00:00:00Z', offer: { id: 'previous-plan', name: 'Standard' } };
  upgradeQuote = { id: 'quote-a', accountId: 'team-a', subscriptionId: currentMembership.id, subscriptionVersion: 1, offer, amount: '5000000', additionalCredits: '100000000', periodStart: '2026-11-08T00:00:00Z', createdAt: '2026-11-08T00:00:00Z', expiresAt: '2099-12-01T00:00:00Z' };
  await render('overview');
  await act(async () => button('Subscribe').click());
  await act(async () => host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="SuperWagie Plus"]')?.click());
  await act(async () => button('Check upgrade price').click());
  upgradeRejection = rejection;
  await act(async () => button('Confirm upgrade for CNY 5.00').click());
  if (rejection === 'conflict') {
    expect(host?.textContent).toContain('request outcome is unknown');
    await act(async () => button('Recover original request').click());
    expect(mutations[2].body).toBe(mutations[1].body);
    expect(mutations[2].path.endsWith('/upgrade-purchases')).toBe(true);
  } else {
    expect(host?.textContent).toContain('This quote is no longer valid');
    expect(host?.textContent).not.toContain('Confirm upgrade for CNY 5.00');
    expect(host?.textContent).not.toContain('Recover original request');
    expect(button('Check upgrade price').disabled).toBe(false);
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    expect(host?.textContent).toContain('报价已失效，请重新获取补差报价。');
    await act(async () => useI18nStore.getState().setLocale('en'));
    upgradeQuote = { ...upgradeQuote, id: 'quote-b', subscriptionVersion: 2 };
    await act(async () => button('Check upgrade price').click());
    await act(async () => button('Confirm upgrade for CNY 5.00').click());
    expect(mutations[3].body).toContain('"quoteId":"quote-b"');
    expect(mutations[3].body).not.toBe(mutations[1].body);
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
  expect(host.textContent).toContain('150 credits');
  expect(host.textContent).toContain('60 credits');
  expect(host.textContent).toContain('Other shared credits');
  expect(host.textContent).toContain('10 credits');
  expect(host.textContent).toContain('0.000007');
  expect(host.textContent).not.toContain('999');
  expect(host.textContent).toContain('Expired');
  expect(host.textContent).toContain('Remaining credits keep their original expiry');
  expect(host.textContent).not.toContain('Next grant');
  expect(writes).toBe(0);
});


test('external channel selection stays read-only until explicit confirmation and unknown checkout blocks another payment', async () => {
  commerce.payments = { mode: 'external', canRecharge: false, canPurchase: true, providers: ['wechat', 'alipay'] };
  commerce.wallets = [];
  activeMembership = false;
  await render('overview');
  await act(async () => host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="SuperWagie Plus"]')?.click());
  await act(async () => button('Alipay').click());
  expect(writes).toBe(0);
  const purchase = [...(host?.querySelectorAll('button') ?? [])].find(item => item.textContent?.includes('SuperWagie Plus') && item.textContent?.includes('10.00') && item.getAttribute('role') !== 'radio');
  expect(purchase?.disabled).toBe(false);
  await act(async () => purchase?.click());
  expect(mutations).toHaveLength(1);
  expect(mutations[0].path.endsWith('/checkouts')).toBe(true);
  expect(JSON.parse(mutations[0].body)).toMatchObject({ accountId: 'team-a', provider: 'alipay', offerId: 'membership-a' });
  expect(host?.textContent).toContain('Check original request');
  expect(button('WeChat Pay').disabled).toBe(true);
  await render('orders');
  await render('overview');
  expect(writes).toBe(1);
});

test('reopening retains paid activation and refund states without presenting another payment link', async () => {
  commerce.checkouts = [{ id: 'paid-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'alipay', offer_name: 'Paid membership', amount: '10000000', currency: 'CNY', payment_status: 'PAID', fulfillment_status: 'PENDING', refund_status: 'PENDING', expires_at: '2027-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z', session: { kind: 'redirect', url: 'https://openapi.alipay.com/gateway.do?sign=fixture', expires_at: '2027-01-01T00:00:00Z' } }];
  await render('orders');
  expect(host?.textContent).toContain('Refund processing');
  expect(host?.textContent).not.toContain('Open Alipay checkout');
  await act(async () => root?.unmount()); root = undefined;
  await render('overview');
  expect(host?.textContent).toContain('Refund processing');
  expect(writes).toBe(0);
  await act(async () => button('Request original-channel refund').click());
  expect(writes).toBe(0);
  expect(host?.textContent).toContain('Confirm refund');
});


for (const rejection of ['failed','http','conflict'] as const) test(`external upgrade ${rejection} releases only a conclusively invalidated quote and requires fresh confirmation`, async () => {
  commerce.payments={mode:'external',canRecharge:false,canPurchase:true,providers:['wechat','alipay']};
  const offer=commerce.offers?.find(item=>item.id==='membership-a');if(!offer)throw new Error('Missing offer');
  currentMembership={id:'subscription-a',product_id:'superwagie',status:'active',paid_through:'2099-12-08T00:00:00Z',offer:{id:'old',name:'Old',period:'month',rank:0}};
  upgradeQuote={id:'quote-a',accountId:'team-a',subscriptionId:'subscription-a',subscriptionVersion:1,offer,amount:'5000000',additionalCredits:'100000000',periodStart:'2026-11-08T00:00:00Z',createdAt:'2026-11-08T00:00:00Z',expiresAt:'2099-11-09T00:00:00Z',paymentSource:'external',originalAmount:'5000000',roundingRule:'cny_cent_ceil_v1'};
  await render('overview');await act(async()=>button('Subscribe').click());await act(async()=>host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="SuperWagie Plus"]')?.click());await act(async()=>button('Check upgrade price').click());
  upgradeRejection=rejection;await act(async()=>button('Confirm upgrade for CNY 5.00').click());
  expect(mutations).toHaveLength(2);const oldKey=JSON.parse(mutations[1].body).idempotencyKey;
  if(rejection==='conflict'){expect(host?.textContent).toContain('Recover original request');return;}
  expect(host?.textContent).not.toContain('Confirm upgrade for CNY 5.00');expect(button('Check upgrade price').disabled).toBe(false);
  upgradeQuote={...upgradeQuote,id:'quote-b'};await act(async()=>button('Check upgrade price').click());expect(mutations).toHaveLength(3);
  await act(async()=>button('Confirm upgrade for CNY 5.00').click());expect(mutations).toHaveLength(4);
  expect(JSON.parse(mutations[3].body)).toMatchObject({quoteId:'quote-b',provider:'wechat'});expect(JSON.parse(mutations[3].body).idempotencyKey).not.toBe(oldKey);
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
