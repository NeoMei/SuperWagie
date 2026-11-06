import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { PlatformCommerceState } from '@/lib/platformCommerce';

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
  intents: [], rechargeHistoryScope: 'this-instance',
};
let writes = 0;
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
  if (init?.method && init.method !== 'GET') writes++;
  return Response.json(commerce);
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { PlatformAccountCommerce } = await import('./PlatformAccountCommerce');
const { preparePlatformAccountTarget, usePlatformAccountTabStore } = await import('./platformAccountTabs');
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const render = async (view: 'overview' | 'orders') => {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><PlatformAccountCommerce accountId="team-a" payer="Team A" view={view} hasActiveMembership membershipSummary={({ openMembership, openAddon }) => <><p>Current membership</p><button type="button" onClick={openMembership}>Membership subscription</button><button type="button" onClick={openAddon}>Credit add-ons</button></>} onAccountRefresh={() => {}} /></I18nProvider>));
};
const button = (text: string) => {
  const found = [...(host?.querySelectorAll('button') ?? [])].find(item => item.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined;
  writes = 0; commerce.intents = []; usePlatformAccountTabStore.getState().setTab('billing');
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

test('overview opens a buying task deliberately and preserves its offer while visiting orders', async () => {
  await render('overview');
  expect(host?.querySelector('[role="radiogroup"]')).toBeNull();
  expect(host?.textContent).not.toContain('Previous membership');
  await act(async () => button('Credit add-ons').click());
  const offer = host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Credit add-ons"]');
  expect(offer).not.toBeNull();
  expect(host?.querySelectorAll('[role="radio"]')).toHaveLength(1);
  expect(/unihub|llmrouter|other service/i.test(host?.textContent ?? '')).toBe(false);
  await act(async () => offer?.click());
  await render('orders');
  expect(host?.textContent).toContain('Previous membership');
  expect(/unihub|llmrouter|other service|999999/i.test(host?.textContent ?? '')).toBe(false);
  expect(host?.querySelector('[role="radiogroup"]')).toBeNull();
  await render('overview');
  expect(host?.querySelector('[role="radio"][aria-label="Credit add-ons"]')?.getAttribute('aria-checked')).toBe('true');
  await act(async () => button('Membership subscription').click());
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
