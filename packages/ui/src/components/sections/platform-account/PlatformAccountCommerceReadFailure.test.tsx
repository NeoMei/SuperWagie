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
const offer = { id: 'membership-a', productId: 'superwagie', name: 'SuperWagie Plus', accountKind: 'both', kind: 'membership', period: 'month', price: '10000000', monthlyCredit: '20000000', validityMonths: 1, rank: 1, sandbox: false } as const;
const baseCheckout = { id: 'waiting-checkout', account_id: 'team-a', product_id: 'superwagie', provider: 'wechat', offer_name: 'Membership', amount: '10000000', currency: 'CNY', payment_status: 'PENDING', fulfillment_status: 'NOT_STARTED', refund_status: '', expires_at: '2027-01-01T00:00:00Z', created_at: '2026-11-08T00:00:00Z' } as const;
const commerce: PlatformCommerceState = {
  accountId: 'team-a', role: 'owner', financialAccess: true, missingScopes: [],
  payments: { mode: 'external', canPurchase: true, providers: ['wechat', 'alipay'] },
  wallets: [], offers: [offer], orders: [], checkouts: [], intents: [],
};
const initialCommerce = structuredClone(commerce);
const mutations: Array<{ path: string; body: string }> = [];
let commerceReadFailures = 0;
let failReadAfterMutation: 'channel-switch' | 'refund' | null = null;
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const path = String(input instanceof Request ? input.url : input);
  if (init?.method && init.method !== 'GET') mutations.push({ path, body: String(init.body) });
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (new URL(path, 'http://localhost').pathname === '/api/platform-account/commerce' && method === 'GET') {
    const switchStarted = mutations.some((item) => item.path.endsWith('/checkouts/waiting-checkout/close'));
    const refundStarted = mutations.some((item) => item.path.endsWith('/checkouts/waiting-checkout/refund'));
    if (commerceReadFailures > 0 || failReadAfterMutation === 'channel-switch' && switchStarted || failReadAfterMutation === 'refund' && refundStarted) {
      commerceReadFailures--;
      return Response.json({ error: 'platform_commerce_unavailable' }, { status: 503 });
    }
    return Response.json(commerce);
  }
  if (path.endsWith('/checkouts/waiting-checkout/close') || path.endsWith('/checkouts/waiting-checkout/refund')) {
    const checkout = commerce.checkouts?.find(item => item.id === 'waiting-checkout') ?? baseCheckout;
    return Response.json({ ...checkout, payment_status: path.endsWith('/close') ? 'CLOSED' : checkout.payment_status, refund_status: path.endsWith('/refund') ? 'PENDING' : checkout.refund_status });
  }
  if (path.endsWith('/api/platform-account/commerce/checkouts')) {
    const intent = { ...JSON.parse(String(init?.body)), kind: 'checkout', accountId: 'team-a', productId: 'superwagie', amount: '10000000', status: 'UNKNOWN', createdAt: '2026-11-08T00:00:00Z' };
    commerce.intents.push(intent);
    return Response.json(intent);
  }
  return Response.json(commerce);
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { PlatformAccountCommerce } = await import('./PlatformAccountCommerce');
const { preparePlatformAccountTarget, usePlatformAccountTabStore } = await import('./platformAccountTabs');
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const render = async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><PlatformAccountCommerce accountId="team-a" payer="Team A" view="overview" hasActiveMembership={false} membershipSummary={({ openMembership, openAddon, membershipOpen, addonOpen, disabled }) => <><button type="button" disabled={disabled} aria-pressed={membershipOpen} onClick={openMembership}>Subscribe</button><button type="button" disabled={disabled} aria-pressed={addonOpen} onClick={openAddon}>Buy extra credits</button></>} onAccountRefresh={() => {}} /></I18nProvider>));
};
const button = (text: string) => {
  const found = [...(host?.querySelectorAll('button') ?? [])].find(item => item.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
const assertFailedRead = () => {
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Could not read wallets or orders. Refresh to check the authoritative status.');
  expect(button('Subscribe').disabled).toBe(true);
  expect(button('Buy extra credits').disabled).toBe(true);
  expect(host?.querySelector('[role="radiogroup"]')).toBeNull();
};
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined;
  mutations.length = 0; Object.assign(commerce, structuredClone(initialCommerce));
  commerceReadFailures = 0; failReadAfterMutation = null;
  usePlatformAccountTabStore.getState().setTab('billing');
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

test('a funding target received during a failed commerce read stays closed after recovery', async () => {
  commerceReadFailures = 1;
  await render();
  await act(async () => preparePlatformAccountTarget('platform-account.addon'));
  expect(usePlatformAccountTabStore.getState().purchaseTarget).toBeNull();
  assertFailedRead();
  await act(async () => button('Refresh wallets and orders').click());
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(button('Subscribe').disabled).toBe(false);
  expect(button('Buy extra credits').disabled).toBe(false);
  expect(button('Buy extra credits').getAttribute('aria-pressed')).toBe('false');
  expect(host?.querySelector('[role="radiogroup"]')).toBeNull();
  expect(mutations).toHaveLength(0);
});

test('a failed follow-up read after a channel switch disables purchase entries until an authoritative refresh', async () => {
  await render();
  await act(async () => host?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="SuperWagie Plus"]')?.click());
  await act(async () => button('Alipay').click());
  const purchase = [...(host?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.includes('Buy SuperWagie Plus'));
  await act(async () => purchase?.click());
  expect(mutations.filter((item) => item.path.endsWith('/api/platform-account/commerce/checkouts'))).toHaveLength(1);
  commerce.intents[0].status = 'FAILED';
  commerce.checkouts = [{ ...baseCheckout, id: 'waiting-checkout', provider: 'alipay' }];
  await act(async () => button('Refresh wallets and orders').click());
  const channelSwitch = [...(host?.querySelectorAll('button') ?? [])].filter((item) => item.textContent === 'WeChat Pay').at(0);
  expect(channelSwitch).toBeDefined();
  expect(channelSwitch?.getAttribute('aria-pressed')).toBe('false');
  failReadAfterMutation = 'channel-switch';
  await act(async () => channelSwitch?.click());
  expect(mutations.filter((item) => item.path.endsWith('/checkouts/waiting-checkout/close'))).toHaveLength(1);
  expect(mutations.filter((item) => item.path.endsWith('/api/platform-account/commerce/checkouts'))).toHaveLength(2);
  assertFailedRead();
  failReadAfterMutation = null;
  await act(async () => button('Refresh wallets and orders').click());
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(button('Subscribe').disabled).toBe(false);
  expect(button('Buy extra credits').disabled).toBe(false);
  expect(host?.querySelector('[role="radiogroup"]')).toBeNull();
});

test('a failed follow-up read after a refund disables purchase entries until an authoritative refresh', async () => {
  commerce.checkouts = [{ ...baseCheckout, provider: 'alipay', payment_status: 'PAID', fulfillment_status: 'FULFILLED' }];
  await render();
  await act(async () => button('Request original-channel refund').click());
  failReadAfterMutation = 'refund';
  await act(async () => button('Confirm refund').click());
  expect(mutations.filter((item) => item.path.endsWith('/checkouts/waiting-checkout/refund'))).toHaveLength(1);
  assertFailedRead();
  failReadAfterMutation = null;
  await act(async () => button('Refresh wallets and orders').click());
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(button('Subscribe').disabled).toBe(false);
  expect(button('Buy extra credits').disabled).toBe(false);
  expect(mutations.filter((item) => item.path.endsWith('/checkouts/waiting-checkout/refund'))).toHaveLength(1);
});
